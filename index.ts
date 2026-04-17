/**
 * pi-telegram-multi — Multi-session Telegram bridge for pi.
 *
 * One Telegram bot, many pi sessions. The first session to connect becomes
 * the default and the leader (polls Telegram). Other sessions register and
 * receive messages through file-based inboxes.
 *
 * Routing:
 *   plain message     → default session
 *   @name message     → specific session
 *   /sessions         → list connected sessions
 *   /stop             → abort current turn
 *
 * Each session signs its replies: [session-name] reply text
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  type TelegramConfig,
  type TelegramMessage,
  type TelegramUpdate,
  readTelegramConfig,
  writeTelegramConfig,
  makeApiClient,
  downloadFile,
} from "./lib/api.ts";

import {
  type SessionEntry,
  type Registry,
  MULTI_DIR,
  readRegistry,
  registerSession,
  unregisterSession,
  ensureLeadership,
  getDefaultSession,
  listSessions,
  findSession,
} from "./lib/registry.ts";

import {
  type InboxMessage,
  type InboxFile,
  readAndClearInbox,
  writeToInbox,
  removeInbox,
} from "./lib/inbox.ts";

import { resolveSessionName, sanitizeName } from "./lib/naming.ts";
import { routeMessage, parseBotCommand, extractText } from "./lib/router.ts";
import { signReply, chunkMessage, MAX_MESSAGE_LENGTH } from "./lib/rendering.ts";

// --- Constants ---

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "telegram.json");
const TEMP_DIR = join(AGENT_DIR, "tmp", "telegram-multi");
const TELEGRAM_PREFIX = "[telegram]";
const INBOX_POLL_INTERVAL_MS = 2000;
const LEADER_CHECK_INTERVAL_MS = 15000;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active (multi-session).
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

// --- Types ---

interface ActiveTurn {
  chatId: number;
  replyToMessageId: number;
  sourceMessageIds: number[];
  queuedAttachments: string[];
  isInboxTurn: boolean; // true if from inbox (non-leader processing)
}

interface QueuedInboxMessage {
  msg: InboxMessage;
  order: number;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  let config: TelegramConfig = {};
  let myName = "";
  let myPid = process.pid;
  let isLeader = false;
  let isDefault = false;
  let isConnected = false;

  // Leader state
  let pollingController: AbortController | undefined;
  let pollingPromise: Promise<void> | undefined;

  // Non-leader state
  let inboxWatcher: ReturnType<typeof setInterval> | undefined;
  let leaderCheckTimer: ReturnType<typeof setInterval> | undefined;

  // Turn state
  let activeTurn: ActiveTurn | undefined;
  let currentAbort: (() => void) | undefined;
  let inboxQueue: QueuedInboxMessage[] = [];
  let leaderQueue: Array<{ text: string; message: TelegramMessage; files: InboxFile[] }> = [];
  let inboxQueueOrder = 0;
  let processingInbox = false;

  // Preview state
  let previewMessageId: number | undefined;
  let previewText = "";
  let previewFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let typingInterval: ReturnType<typeof setInterval> | undefined;

  const api = makeApiClient(() => config.botToken);

  // ─── Session Naming ─────────────────────────────────────────────

  function getMySessionName(ctx: ExtensionContext): string {
    const stored = ctx.sessionManager.getSessionName();
    return resolveSessionName(stored, ctx.cwd);
  }

  // ─── Telegram API Wrappers ──────────────────────────────────────

  async function sendReply(chatId: number, text: string, parseMode?: string): Promise<void> {
    const chunks = chunkMessage(text);
    for (const chunk of chunks) {
      await api.sendMessage(chatId, chunk, parseMode);
    }
  }

  async function sendSignedReply(chatId: number, text: string): Promise<void> {
    const signed = signReply(myName, text);
    await sendReply(chatId, signed, "HTML");
  }

  async function sendPlainReply(chatId: number, text: string): Promise<void> {
    await sendReply(chatId, text);
  }

  // ─── Leader: Polling ────────────────────────────────────────────

  async function startPolling(ctx: ExtensionContext): Promise<void> {
    if (pollingPromise || !config.botToken) return;

    try {
      await api.deleteWebhook();
      await registerBotCommands();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Telegram: failed to initialize polling: ${msg}`, "error");
      return;
    }

    pollingController = new AbortController();
    pollingPromise = runPollLoop(ctx, pollingController.signal).finally(() => {
      pollingPromise = undefined;
      pollingController = undefined;
      updateStatus(ctx);
    });
    updateStatus(ctx);
  }

  async function stopPolling(): Promise<void> {
    stopTypingLoop();
    pollingController?.abort();
    pollingController = undefined;
    await pollingPromise?.catch(() => undefined);
    pollingPromise = undefined;
  }

  async function registerBotCommands(): Promise<void> {
    await api.setMyCommands([
      { command: "start", description: "Show help and pair the bridge" },
      { command: "status", description: "Show session status" },
      { command: "sessions", description: "List connected sessions" },
      { command: "stop", description: "Abort the current turn" },
    ]);
  }

  async function runPollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates((config.lastUpdateId ?? 0) + 1, 30, signal);
        for (const update of updates) {
          config.lastUpdateId = update.update_id;
          await handleUpdate(update, ctx);
        }
        await writeTelegramConfig(AGENT_DIR, CONFIG_PATH, config);
      } catch (err) {
        if (signal.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        // Don't spam errors — just log
        if (!msg.includes("aborted")) {
          updateStatus(ctx, `poll error: ${msg}`);
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // ─── Leader: Update Handling ────────────────────────────────────

  async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
    const message = update.message;
    if (!message) return;

    // Authorization
    const userId = message.from?.id;
    if (!userId) return;

    // Pair on /start
    if (config.allowedUserId === undefined) {
      if (message.text?.startsWith("/start")) {
        config.allowedUserId = userId;
        await writeTelegramConfig(AGENT_DIR, CONFIG_PATH, config);
        await sendPlainReply(message.chat.id, "Paired! Send me a message and I'll forward it to pi.\n\nUse @session_name to route to a specific session, or just type to talk to the default session.\n\nCommands: /sessions, /status, /stop");
        try { await registerBotCommands(); } catch {}
        return;
      }
      return; // Not paired yet
    }

    if (userId !== config.allowedUserId) return;

    // Parse text
    const text = extractText(message.text, message.caption);
    if (!text && !message.photo && !message.document && !message.video && !message.audio && !message.voice) return;

    // Handle commands
    const cmd = parseBotCommand(text);
    if (cmd) {
      await handleBotCommand(cmd.name, cmd.args, message, ctx);
      return;
    }

    // Route the message
    const sessions = await listSessions();
    const sessionNames = sessions.map((s) => s.name);
    const defaultSession = await getDefaultSession();
    const defaultName = defaultSession?.name || myName;

    const routing = routeMessage(text || "📎 attachment", defaultName, sessionNames);

    // Download any media
    const files = await downloadMessageFiles(message);

    if (routing.targetSession === myName) {
      // Route to self (leader)
      await dispatchToLocalAgent(routing.text, message, files, ctx);
    } else {
      // Route to another session's inbox
      const target = await findSession(routing.targetSession);
      if (!target) {
        await sendPlainReply(message.chat.id, `Unknown session "@${routing.targetSession}". Use /sessions to see available sessions.`);
        return;
      }
      await writeToInbox(routing.targetSession, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        text: routing.text,
        files,
        timestamp: Date.now(),
      });
      if (routing.explicit) {
        await sendPlainReply(message.chat.id, `→ @${routing.targetSession}`);
      }
    }
  }

  async function downloadMessageFiles(message: TelegramMessage): Promise<InboxFile[]> {
    const files: InboxFile[] = [];
    const download = async (fileId: string, name: string, isImage: boolean, mimeType?: string) => {
      try {
        const path = await downloadFile(config.botToken!, fileId, name, TEMP_DIR);
        files.push({ path, name, isImage, mimeType });
      } catch (err) {
        // skip failed downloads
      }
    };

    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1]; // highest res
      await download(photo.file_id, `photo_${message.message_id}.jpg`, true, "image/jpeg");
    }
    if (message.document) {
      await download(message.document.file_id, message.document.file_name || "document", false, message.document.mime_type);
    }
    if (message.video) {
      await download(message.video.file_id, message.video.file_name || "video.mp4", false, message.video.mime_type);
    }
    if (message.audio) {
      await download(message.audio.file_id, message.audio.file_name || "audio.mp3", false, message.audio.mime_type);
    }
    if (message.voice) {
      await download(message.voice.file_id, `voice_${message.message_id}.ogg`, false, message.voice.mime_type);
    }

    return files;
  }

  async function handleBotCommand(
    name: string,
    args: string,
    message: TelegramMessage,
    ctx: ExtensionContext,
  ): Promise<void> {
    switch (name) {
      case "start":
      case "help":
        await sendPlainReply(message.chat.id,
          "Send me a message and I'll forward it to pi.\n\n" +
          "• Plain message → default session\n" +
          "• @name message → specific session\n\n" +
          "Commands: /sessions, /status, /stop"
        );
        break;

      case "sessions": {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          await sendPlainReply(message.chat.id, "No sessions connected.");
          return;
        }
        const lines = sessions.map((s) => {
          const flags = [];
          if (s.isDefault) flags.push("default");
          if (s.name === myName) flags.push("← you");
          return `• @${s.name}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`;
        });
        await sendPlainReply(message.chat.id, `Connected sessions:\n${lines.join("\n")}`);
        break;
      }

      case "status": {
        const sessions = await listSessions();
        const leaderTag = isLeader ? " (leader)" : "";
        const defaultTag = isDefault ? " (default)" : "";
        const lines = [
          `Bot: @${config.botUsername || "unknown"}`,
          `This session: @${myName}${leaderTag}${defaultTag}`,
          `Sessions: ${sessions.length}`,
          `Active turn: ${activeTurn ? "yes" : "no"}`,
        ];
        await sendPlainReply(message.chat.id, lines.join("\n"));
        break;
      }

      case "stop": {
        if (currentAbort) {
          currentAbort();
          await sendPlainReply(message.chat.id, "Aborted current turn.");
        } else {
          await sendPlainReply(message.chat.id, "No active turn.");
        }
        break;
      }

      default:
        // Unknown command — treat as regular message
        const text = extractText(message.text, message.caption);
        if (text) {
          const sessions = await listSessions();
          const defaultSession = await getDefaultSession();
          const routing = routeMessage(text, defaultSession?.name || myName, sessions.map((s) => s.name));
          if (routing.targetSession === myName) {
            await dispatchToLocalAgent(routing.text, message, [], ctx);
          } else {
            await writeToInbox(routing.targetSession, {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              chatId: message.chat.id,
              replyToMessageId: message.message_id,
              text: routing.text,
              files: [],
              timestamp: Date.now(),
            });
          }
        }
    }
  }

  // ─── Local Agent Dispatch (Leader or Non-leader) ────────────────

  async function dispatchToLocalAgent(
    text: string,
    sourceMessage: TelegramMessage,
    files: InboxFile[],
    ctx: ExtensionContext,
  ): Promise<void> {
    // If already processing, queue for later
    if (activeTurn) {
      leaderQueue.push({ text, message: sourceMessage, files });
      return;
    }

    await executeLocalTurn(text, sourceMessage, files);
  }

  async function executeLocalTurn(
    text: string,
    sourceMessage: TelegramMessage,
    files: InboxFile[],
  ): Promise<void> {
    let promptText = `${TELEGRAM_PREFIX} ${text}`;
    for (const file of files) {
      promptText += `\nAttached file: ${file.path}${file.isImage ? " (image)" : ""}`;
    }

    activeTurn = {
      chatId: sourceMessage.chat.id,
      replyToMessageId: sourceMessage.message_id,
      sourceMessageIds: [sourceMessage.message_id],
      queuedAttachments: [],
      isInboxTurn: false,
    };

    pi.sendUserMessage(promptText);
  }

  async function processNextLeaderQueueItem(): Promise<void> {
    if (leaderQueue.length === 0) return;
    const item = leaderQueue.shift()!;
    await executeLocalTurn(item.text, item.message, item.files);
  }

  // ─── Non-leader: Inbox Watcher ──────────────────────────────────

  function startInboxWatcher(ctx: ExtensionContext): void {
    if (inboxWatcher) return;

    inboxWatcher = setInterval(async () => {
      if (processingInbox || activeTurn) return;

      try {
        const messages = await readAndClearInbox(myName);
        for (const msg of messages) {
          inboxQueue.push({ msg, order: inboxQueueOrder++ });
        }
        await processNextInboxMessage(ctx);
      } catch {}
    }, INBOX_POLL_INTERVAL_MS);
  }

  function stopInboxWatcher(): void {
    if (inboxWatcher) {
      clearInterval(inboxWatcher);
      inboxWatcher = undefined;
    }
  }

  async function processNextInboxMessage(ctx: ExtensionContext): Promise<void> {
    if (processingInbox || activeTurn || inboxQueue.length === 0) return;

    processingInbox = true;
    const item = inboxQueue.shift()!;

    try {
      const msg = item.msg;
      let promptText = `${TELEGRAM_PREFIX} ${msg.text}`;
      for (const file of msg.files) {
        promptText += `\nAttached file: ${file.path}${file.isImage ? " (image)" : ""}`;
      }

      activeTurn = {
        chatId: msg.chatId,
        replyToMessageId: msg.replyToMessageId,
        sourceMessageIds: [],
        queuedAttachments: [],
        isInboxTurn: true,
      };

      startTypingLoop(ctx, msg.chatId);
      pi.sendUserMessage(promptText);
    } finally {
      processingInbox = false;
    }
  }

  // ─── Leader Check (Non-leader → Leader promotion) ──────────────

  function startLeaderCheck(ctx: ExtensionContext): void {
    if (leaderCheckTimer) return;
    leaderCheckTimer = setInterval(async () => {
      if (!isConnected) return;
      const amLeader = await ensureLeadership(myName, myPid);
      if (amLeader && !isLeader) {
        isLeader = true;
        ctx.ui.notify("Telegram: promoted to leader — starting polling", "info");
        await startPolling(ctx);
        stopInboxWatcher(); // Leader processes own messages directly
      }
    }, LEADER_CHECK_INTERVAL_MS);
  }

  function stopLeaderCheck(): void {
    if (leaderCheckTimer) {
      clearInterval(leaderCheckTimer);
      leaderCheckTimer = undefined;
    }
  }

  // ─── Typing & Preview ──────────────────────────────────────────

  function startTypingLoop(_ctx: ExtensionContext, chatId?: number): void {
    const targetChatId = chatId ?? activeTurn?.chatId;
    if (typingInterval || !targetChatId || !config.botToken) return;

    const sendTyping = async () => {
      try { await api.sendChatAction(targetChatId, "typing"); } catch {}
    };
    void sendTyping();
    typingInterval = setInterval(() => { void sendTyping(); }, 4000);
  }

  function stopTypingLoop(): void {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
  }

  // ─── Status Bar ─────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext, error?: string): void {
    const t = ctx.ui.theme;
    const label = t.fg("accent", "telegram");

    if (error) {
      ctx.ui.setStatus("telegram", `${label} ${t.fg("error", "error")} ${t.fg("muted", error)}`);
      return;
    }
    if (!config.botToken) {
      ctx.ui.setStatus("telegram", `${label} ${t.fg("muted", "not configured")}`);
      return;
    }
    if (!isConnected) {
      ctx.ui.setStatus("telegram", `${label} ${t.fg("muted", "disconnected")}`);
      return;
    }
    if (!config.allowedUserId) {
      ctx.ui.setStatus("telegram", `${label} ${t.fg("warning", "awaiting pairing")}`);
      return;
    }

    const parts = [t.fg("success", "connected")];
    if (isLeader) parts.push(t.fg("muted", "leader"));
    parts.push(t.fg("muted", `@${myName}`));
    if (activeTurn) parts.push(t.fg("accent", "processing"));

    ctx.ui.setStatus("telegram", `${label} ${parts.join(" ")}`);
  }

  // ─── Connect / Disconnect ───────────────────────────────────────

  async function connect(ctx: ExtensionContext, explicitName?: string): Promise<void> {
    if (isConnected) {
      ctx.ui.notify(`Already connected as @${myName}`, "info");
      return;
    }

    if (!config.botToken) {
      ctx.ui.notify("No bot token configured. Run /telegram-setup first.", "error");
      return;
    }

    // Resolve name: explicit → session name → auto
    if (explicitName) {
      myName = sanitizeName(explicitName);
    } else {
      myName = getMySessionName(ctx);
    }

    // Ensure uniqueness
    const existing = await listSessions();
    if (existing.some((s) => s.name === myName && s.pid !== myPid)) {
      myName = `${myName}_${Math.floor(1000 + Math.random() * 9000)}`;
    }

    // Register
    const registry = await registerSession({
      name: myName,
      pid: myPid,
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      isDefault: false, // registerSession will set this if needed
      connectedAt: new Date().toISOString(),
    });

    isDefault = registry.sessions[myName]?.isDefault ?? false;
    isConnected = true;

    // Determine leadership
    const amLeader = await ensureLeadership(myName, myPid);

    if (amLeader) {
      isLeader = true;
      ctx.ui.notify(`Telegram: connected as @${myName} (leader, ${isDefault ? "default" : "secondary"})`, "info");
      await startPolling(ctx);
    } else {
      isLeader = false;
      ctx.ui.notify(`Telegram: connected as @${myName} (${isDefault ? "default" : "secondary"}, leader is @${registry.leader})`, "info");
      startInboxWatcher(ctx);
      startLeaderCheck(ctx);
    }

    updateStatus(ctx);
  }

  async function disconnect(ctx: ExtensionContext): Promise<void> {
    if (!isConnected) return;

    await stopPolling();
    stopInboxWatcher();
    stopLeaderCheck();
    stopTypingLoop();

    await unregisterSession(myName);
    await removeInbox(myName);

    activeTurn = undefined;
    currentAbort = undefined;
    isConnected = false;
    isLeader = false;
    isDefault = false;

    ctx.ui.notify(`Telegram: @${myName} disconnected`, "info");
    updateStatus(ctx);
  }

  // ─── Setup ──────────────────────────────────────────────────────

  async function promptForConfig(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;

    const currentDefault = config.botToken || process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || "123456:ABCDEF...";
    const method = config.botToken ? "editor" : "input";

    const token = method === "editor"
      ? await ctx.ui.editor("Telegram bot token", currentDefault)
      : await ctx.ui.input("Telegram bot token", currentDefault);

    if (!token || token === "123456:ABCDEF...") return;

    const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };

    // Validate
    try {
      const me = await makeApiClient(() => nextConfig.botToken).getMe();
      nextConfig.botId = me.id;
      nextConfig.botUsername = me.username;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Invalid token: ${msg}`, "error");
      return;
    }

    config = nextConfig;
    await writeTelegramConfig(AGENT_DIR, CONFIG_PATH, config);
    ctx.ui.notify(`Telegram bot: @${config.botUsername}`, "info");
    ctx.ui.notify("Send /start to your bot to pair, then /telegram-connect in pi.", "info");
  }

  // ─── Helper: Extract assistant text ─────────────────────────────

  function extractTextContent(content: unknown): string {
    const blocks = Array.isArray(content) ? content : [];
    return blocks
      .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "type" in b)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("")
      .trim();
  }

  function extractAssistantText(messages: Array<{ role?: string; content?: unknown }>): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        return extractTextContent(messages[i].content) || undefined;
      }
    }
    return undefined;
  }

  // ─── Register Tools ─────────────────────────────────────────────

  pi.registerTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description: "Queue local files to be sent with the next Telegram reply.",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!activeTurn) {
        return {
          content: [{ type: "text", text: "No active Telegram turn to attach files to." }],
          details: {},
        };
      }
      for (const p of params.paths) {
        try {
          await stat(p);
          activeTurn.queuedAttachments.push(p);
        } catch {
          return {
            content: [{ type: "text", text: `File not found: ${p}` }],
            details: {},
            isError: true,
          };
        }
      }
      return {
        content: [{ type: "text", text: `Queued ${params.paths.length} file(s) for Telegram delivery.` }],
        details: {},
      };
    },
  });

  // ─── Register Commands ──────────────────────────────────────────

  pi.registerCommand("telegram-setup", {
    description: "Configure Telegram bot token",
    handler: async (_args, ctx) => {
      await promptForConfig(ctx);
    },
  });

  pi.registerCommand("telegram-connect", {
    description: "Connect this session to the Telegram bridge. Optional: /telegram-connect <name>",
    handler: async (args, ctx) => {
      const name = args?.trim() || undefined;
      await connect(ctx, name);
    },
  });

  pi.registerCommand("telegram-disconnect", {
    description: "Disconnect this session from the Telegram bridge",
    handler: async (_args, ctx) => {
      await disconnect(ctx);
    },
  });

  pi.registerCommand("telegram-status", {
    description: "Show Telegram bridge status",
    handler: async (_args, ctx) => {
      const sessions = await listSessions();
      const registry = await readRegistry();
      ctx.ui.notify(
        [
          `Session: @${myName} (${isConnected ? "connected" : "disconnected"})`,
          `Role: ${isLeader ? "leader" : "follower"}${isDefault ? ", default" : ""}`,
          `Bot: @${config.botUsername || "not configured"}`,
          `Leader: @${registry.leader || "none"}`,
          `Sessions: ${sessions.map((s) => `@${s.name}${s.isDefault ? "★" : ""}`).join(", ") || "none"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("telegram-rename", {
    description: "Rename this session in the Telegram bridge. Usage: /telegram-rename <new-name>",
    handler: async (args, ctx) => {
      const newName = args?.trim();
      if (!newName) {
        ctx.ui.notify("Usage: /telegram-rename <name>", "error");
        return;
      }
      const oldName = myName;
      // Unregister old
      if (isConnected) await unregisterSession(myName);
      // Update name
      myName = sanitizeName(newName);
      // Re-register
      if (isConnected) {
        await registerSession({
          name: myName,
          pid: myPid,
          cwd: ctx.cwd,
          sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
          isDefault: isDefault,
          connectedAt: new Date().toISOString(),
        });
      }
      ctx.ui.notify(`Renamed: @${oldName} → @${myName}`, "info");
      updateStatus(ctx);
    },
  });

  // ─── Lifecycle Hooks ────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    config = await readTelegramConfig(CONFIG_PATH);
    await mkdir(TEMP_DIR, { recursive: true });
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (isConnected) {
      await stopPolling();
      stopInboxWatcher();
      stopLeaderCheck();
      stopTypingLoop();
      try { await unregisterSession(myName); } catch {}
      try { await removeInbox(myName); } catch {}
      activeTurn = undefined;
      currentAbort = undefined;
      isConnected = false;
      isLeader = false;
      isDefault = false;
    }
  });

  pi.on("before_agent_start", (event, _ctx) => {
    const e = event as { prompt: string; systemPrompt: string };
    const suffix = e.prompt.trimStart().startsWith(TELEGRAM_PREFIX)
      ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
      : SYSTEM_PROMPT_SUFFIX;
    return { systemPrompt: e.systemPrompt + suffix };
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentAbort = () => ctx.abort();
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const turn = activeTurn;
    currentAbort = undefined;
    stopTypingLoop();
    activeTurn = undefined;
    updateStatus(ctx);

    if (!turn) return;

    const e = event as { messages: Array<{ role?: string; content?: unknown; stopReason?: string; errorMessage?: string }> };
    const text = extractAssistantText(e.messages);
    const stopReason = e.messages[e.messages.length - 1]?.stopReason;

    // Handle errors
    if (stopReason === "error" || (!text && stopReason !== "stop")) {
      await sendSignedReply(turn.chatId, "Error processing request.");
    } else if (text) {
      await sendSignedReply(turn.chatId, text);
    }

    // Send queued attachments
    for (const filePath of turn.queuedAttachments) {
      try {
        const name = basename(filePath);
        await api.sendDocument(turn.chatId, filePath, name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await sendPlainReply(turn.chatId, `Failed to send attachment: ${msg}`);
      }
    }

    // Process next queued item
    if (isLeader) {
      await processNextLeaderQueueItem();
    } else if (inboxQueue.length > 0) {
      await processNextInboxMessage(ctx);
    }
  });

  pi.on("message_update", async (event, _ctx) => {
    // Simple preview streaming for active turn
    if (!activeTurn || !isLeader) return;
    const e = event as { message: { role?: string; content?: unknown } };
    if (e.message?.role !== "assistant") return;

    const text = extractTextContent(e.message.content);
    if (!text) return;

    // Throttled preview update
    if (previewFlushTimer) clearTimeout(previewFlushTimer);
    previewFlushTimer = setTimeout(async () => {
      if (!activeTurn || !config.botToken) return;
      try {
        const preview = signReply(myName, text.length > 500 ? text.slice(0, 500) + "…" : text);
        if (previewMessageId) {
          await api.editMessageText(activeTurn.chatId, previewMessageId, preview, "HTML");
        } else {
          const sent = await api.sendMessage(activeTurn.chatId, preview, "HTML");
          previewMessageId = sent.message_id;
        }
      } catch {}
    }, PREVIEW_THROTTLE_MS);
  });

  pi.on("message_start", async (event, _ctx) => {
    // Clear preview on new assistant message
    const e = event as { message: { role?: string } };
    if (e.message?.role === "assistant") {
      previewMessageId = undefined;
      previewText = "";
    }
  });
}
