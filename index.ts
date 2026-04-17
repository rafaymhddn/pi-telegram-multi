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
 * Each session signs its replies with a leading emoji+bold header
 * `<emoji> @session_name` (plus `· i/N` pagination on multi-chunk replies).
 */

import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  type TelegramConfig,
  type TelegramMessage,
  type TelegramUpdate,
  RateLimitError,
  readTelegramConfig,
  writeTelegramConfig,
  makeApiClient,
  downloadFile,
} from "./lib/api.ts";

import {
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

import {
  type ReplyRecord,
  readAndClearReplies,
  writeReply,
  removeReplies,
} from "./lib/replies.ts";

import { logTurnStart, logDelegationDispatch, logDelegationResult, logTurnEnd } from "./lib/history.ts";

import { resolveSessionName, sanitizeName, sessionEmoji } from "./lib/naming.ts";
import { routeMessage, parseBotCommand, extractText } from "./lib/router.ts";
import { buildReplyChunks, buildPreview, chunkMessage } from "./lib/rendering.ts";

// --- Constants ---

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "telegram.json");
const TEMP_DIR = join(AGENT_DIR, "tmp", "telegram-multi");
const TELEGRAM_PREFIX = "[telegram]";
const INBOX_POLL_INTERVAL_MS = 2000;
const REPLY_POLL_INTERVAL_MS = 1000;
const LEADER_CHECK_INTERVAL_MS = 15000;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const DEFAULT_DELEGATE_TIMEOUT_S = 600;
const DELEGATE_STATUS_EXCERPT_CHARS = 120;
// Telegram Bot API (cloud) limits.
const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024; // 50 MB via sendDocument
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024; // 20 MB via getFile

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active (multi-session).
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

const LEADER_ORCHESTRATION_SUFFIX = `

You are the LEADER of a multi-session Telegram bridge. Live sessions and their cwds are listed below; coordinate them with the telegram_delegate tool.

telegram_delegate is ASYNCHRONOUS and NON-BLOCKING:
- telegram_delegate({target, task, timeoutSeconds?}) DISPATCHES a subtask and returns immediately with a correlationId. Your turn ends normally after you've finished responding.
- The target's reply arrives LATER as a new user message prefixed:
    "[delegation-reply from @target] (task: …)"     — on success
    "[delegation-error from @target] (task: …)"     — target returned an error
    "[delegation-timeout from @target] (task: …)"   — timed out (default 600s)
  When you see one of those prefixes, treat it as input to your orchestration, not a user question.
- Each turn's system prompt begins with a "Pending delegations" block that is the authoritative list of what is still in flight. Trust it over your memory.
- You may dispatch MULTIPLE delegations in a single turn (fan-out). Each reply will arrive as its own later turn; aggregate when you have enough to answer.
- If the user interjects with an unrelated question while delegations are pending, answer them directly — the pending delegations keep running and their replies still arrive as follow-up turns.
- Each delegation is visible to the user on Telegram: "→ 🦊 @target · task" on dispatch, then the target's own full reply (emoji-headed, threaded under the dispatch bubble) when it finishes. Failure/timeout add a "⚠ …" or "⏱ …" bubble; successful replies do NOT get a separate "done" bubble because the reply itself is the signal.
- Do not delegate to yourself. If a target session is unknown, tell the user instead of guessing.
- Orchestration history is logged at ~/.pi/agent/telegram-multi/orchestration-log.md with DISPATCH/RESULT entries. You may read it if the user asks about past delegations.

KEEP THE CHAT QUIET — the user sees every message:
- Do NOT quote or forward what a target said. The user already saw the target's reply with its own signature and threading. Repeating it ("@zoro says: …") is pure noise.
- Do NOT post filler interim messages like "OK, I'll ask them" or "I told @zoro and @sanji". If you have nothing to add, just dispatch the delegations and let the tool's status bubble speak for you — end your turn with no text.
- DO speak up when you have real value to add: synthesising across replies ("@zoro and @sanji agree, but @nami disagrees because …"), flagging a blocker, answering a direct user question, asking for a decision, or summarising once ALL expected replies are in.
- If the user explicitly asks "what did they say?" or similar, you may quote — that's value, not noise.`;

// --- Types ---

interface ActiveTurn {
  chatId: number;
  replyToMessageId: number;
  queuedAttachments: string[];
  /**
   * Present when this turn is executing a task delegated by another session.
   * The final assistant text is mirrored to the delegator's reply-channel
   * file so their `telegram_delegate` tool-call promise resolves.
   */
  delegation?: {
    correlationId: string;
    fromSession: string;
    replyChannel: string;
  };
  /** User-facing input excerpt used for history logging. */
  historyInput?: string;
}

interface QueuedInboxMessage {
  msg: InboxMessage;
  order: number;
}

interface PendingDelegation {
  correlationId: string;
  target: string;
  task: string;
  startedAt: number;
  timeoutSec: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Chat where the originating `@leader` message came from; replies post here. */
  chatId: number;
  /**
   * `message_id` of the "→ @target" dispatch status bubble. The target
   * session's full reply and this delegation's closing ✓/⚠/⏱ status
   * all thread under it in Telegram's UI.
   */
  dispatchMessageId?: number;
  /**
   * `message_id` of the user's original @leader request. The leader's
   * later aggregated reply (triggered by an injected follow-up turn)
   * threads under this so the whole orchestration sits in one tree.
   * 0 means "no threading" (e.g. delegation was initiated from a
   * reply-injected turn with synthetic message_id = 0).
   */
  rootReplyToMessageId: number;
}

/** Pending delegations block cap so the system prompt doesn't blow up. */
const MAX_PENDING_IN_PROMPT = 20;

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
  let replyWatcher: ReturnType<typeof setInterval> | undefined;
  const pendingDelegations = new Map<string, PendingDelegation>();
  /**
   * Last chatId we saw from Telegram. Used as a fallback when
   * telegram_delegate is called outside of an active Telegram turn
   * (e.g. the user kicked off orchestration from the pi CLI directly).
   * For DM bots this defaults to `config.allowedUserId` since a
   * Telegram private-chat id equals the paired user's id.
   */
  let lastTelegramChatId: number | undefined;

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
  let lastPreviewHtml = "";
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

  /**
   * Deliver the final reply. If a preview message is already in the chat,
   * edit that message in place with the first chunk instead of sending a
   * new one — this avoids the duplicate "streaming preview + final reply"
   * bubble pair. Subsequent chunks (if any) are sent as new messages.
   *
   * Each chunk begins with the session's emoji-bold header (`@name`
   * plus `· i/N` on multi-chunk).
   */
  async function deliverFinalReply(
    chatId: number,
    text: string,
    editMessageId?: number,
    replyToMessageId?: number,
  ): Promise<void> {
    const chunks = buildReplyChunks(myName, text);
    let startIdx = 0;
    if (editMessageId !== undefined && chunks.length > 0) {
      try {
        await api.editMessageText(chatId, editMessageId, chunks[0], "HTML");
        startIdx = 1;
      } catch {
        // Edit failed (e.g. message too old, identical content, HTML parse error):
        // fall back to sending the first chunk as a new message.
      }
    }
    for (let i = startIdx; i < chunks.length; i++) {
      // Only the first newly-sent chunk threads under the user's source
      // message — subsequent chunks post inline right after to avoid
      // "replying to X" banner repetition on every page.
      const replyTo = i === startIdx ? replyToMessageId : undefined;
      await api.sendMessage(chatId, chunks[i], "HTML", undefined, replyTo);
    }
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
    startReplyWatcher(ctx);
    updateStatus(ctx);
  }

  async function stopPolling(): Promise<void> {
    stopTypingLoop();
    stopReplyWatcher();
    pollingController?.abort();
    pollingController = undefined;
    await pollingPromise?.catch(() => undefined);
    pollingPromise = undefined;
  }

  // ─── Leader: Reply Channel Watcher ─────────────────────────────
  //
  // Delegations are fire-and-forget from the tool's perspective. When a
  // target session's reply arrives on our reply-channel file, we:
  //   1) close the status bubble ("✓ @target done" / "⚠ @target: err"),
  //   2) log a RESULT entry to the orchestration log,
  //   3) inject a synthetic `[delegation-reply|error|timeout from @target]`
  //      user message into the leader's pi session so the agent can see the
  //      result and continue reasoning — potentially dispatching more work
  //      or summarising.
  //
  // Timeout follows the same injection path, keyed off the setTimeout
  // registered in the `telegram_delegate` tool's execute handler.

  function startReplyWatcher(ctx: ExtensionContext): void {
    if (replyWatcher) return;
    replyWatcher = setInterval(async () => {
      try {
        const records = await readAndClearReplies(myName);
        for (const rec of records) {
          const pending = pendingDelegations.get(rec.correlationId);
          if (!pending) continue; // leader restart or unknown correlation — drop
          clearTimeout(pending.timeoutHandle);
          pendingDelegations.delete(rec.correlationId);
          await onDelegationResult(
            ctx,
            pending,
            rec.ok ? "ok" : "error",
            rec.text,
            rec.error,
          );
        }
      } catch {}
    }, REPLY_POLL_INTERVAL_MS);
  }

  function stopReplyWatcher(): void {
    if (replyWatcher) {
      clearInterval(replyWatcher);
      replyWatcher = undefined;
    }
    // In-flight delegations on target sessions are NOT cancelled — they
    // keep running. Their replies, if they arrive after polling stops (or
    // the leader changes), will hit an empty `pendingDelegations` and be
    // logged + dropped by a future leader. Clear timers locally.
    for (const [id, pending] of pendingDelegations) {
      clearTimeout(pending.timeoutHandle);
      pendingDelegations.delete(id);
    }
  }

  /**
   * Render the authoritative "Pending delegations" block that gets injected
   * into the leader's system prompt at the start of every turn. The agent
   * treats this as the source of truth for what is currently in flight,
   * so it never forgets outstanding work even across interjected turns.
   */
  function renderPendingBlock(): string {
    const entries = Array.from(pendingDelegations.values()).sort((a, b) => a.startedAt - b.startedAt);
    if (entries.length === 0) return "Pending delegations: (none)";
    const now = Date.now();
    const shown = entries.slice(0, MAX_PENDING_IN_PROMPT);
    const extra = entries.length - shown.length;
    const lines = shown.map((p) => {
      const ageSec = Math.round((now - p.startedAt) / 1000);
      const task = p.task.length > 160 ? p.task.slice(0, 159) + "…" : p.task;
      return `  - @${p.target} (${ageSec}s ago, ${p.correlationId}, timeout ${p.timeoutSec}s): "${task}"`;
    });
    const suffix = extra > 0 ? `\n  … and ${extra} more` : "";
    return `Pending delegations (${entries.length}):\n${lines.join("\n")}${suffix}`;
  }

  /**
   * Unified "delegation concluded" handler. Posts the closing Telegram
   * status line, logs the RESULT entry, and injects a follow-up user
   * message into the leader's pi session via `dispatchToLocalAgent` —
   * which queues behind any in-flight turn via the existing `leaderQueue`.
   */
  async function onDelegationResult(
    ctx: ExtensionContext,
    pending: PendingDelegation,
    status: "ok" | "error" | "timeout",
    text: string,
    errorMsg?: string,
  ): Promise<void> {
    const durationMs = Date.now() - pending.startedAt;
    const sec = (durationMs / 1000).toFixed(1);

    // Closing status bubble. On success we skip it entirely — the
    // target's own full reply (already posted, threaded under the
    // dispatch bubble, signed with its emoji header) is the completion
    // signal. A separate "✓ done" adds noise without information. Only
    // post on failure/timeout, where the user would otherwise have no
    // visible cue.
    const emoji = sessionEmoji(pending.target);
    const threadTo = pending.dispatchMessageId;
    try {
      if (status === "timeout") {
        await api.sendMessage(
          pending.chatId,
          `⏱ ${emoji} @${pending.target} · timeout after ${sec}s`,
          undefined, undefined, threadTo,
        );
      } else if (status === "error") {
        const err = errorMsg && errorMsg.length > DELEGATE_STATUS_EXCERPT_CHARS
          ? errorMsg.slice(0, DELEGATE_STATUS_EXCERPT_CHARS - 1) + "…"
          : errorMsg;
        await api.sendMessage(
          pending.chatId,
          `⚠ ${emoji} @${pending.target} · ${err ?? "failed"}`,
          undefined, undefined, threadTo,
        );
      }
      // status === "ok": intentionally no bubble.
    } catch {}

    void logDelegationResult({
      from: myName,
      to: pending.target,
      correlationId: pending.correlationId,
      status,
      durationMs,
      resultExcerpt: status === "ok" ? text : undefined,
      error: status === "ok" ? undefined : (errorMsg ?? status),
    });

    // Build the injected user message. The agent's system prompt teaches it
    // to recognise these prefixes.
    const taskExcerpt = pending.task.length > 160
      ? pending.task.slice(0, 159) + "…"
      : pending.task;
    const header = status === "ok"
      ? `[delegation-reply from @${pending.target}] (task: "${taskExcerpt}")`
      : status === "timeout"
        ? `[delegation-timeout from @${pending.target}] (task: "${taskExcerpt}")`
        : `[delegation-error from @${pending.target}] (task: "${taskExcerpt}")`;
    const body = status === "ok"
      ? (text.trim() || "(empty reply)")
      : (errorMsg ?? (status === "timeout" ? `no reply after ${pending.timeoutSec}s` : "failed"));
    const injected = `${header}\n\n${body}`;

    // Synthetic source message — message_id is re-used downstream as the
    // injected turn's activeTurn.replyToMessageId so the leader's later
    // aggregated reply threads under the user's original request.
    const pseudo = {
      chat: { id: pending.chatId, type: "private" },
      message_id: pending.rootReplyToMessageId || 0,
    } as TelegramMessage;

    await dispatchToLocalAgent(injected, pseudo, [], ctx);
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
    let lastPersistedUpdateId = config.lastUpdateId ?? 0;
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates((config.lastUpdateId ?? 0) + 1, 30, signal);
        for (const update of updates) {
          config.lastUpdateId = update.update_id;
          await handleUpdate(update, ctx);
        }
        const now = config.lastUpdateId ?? 0;
        if (now !== lastPersistedUpdateId) {
          await writeTelegramConfig(AGENT_DIR, CONFIG_PATH, config);
          lastPersistedUpdateId = now;
        }
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof RateLimitError) {
          updateStatus(ctx, `rate-limited; waiting ${err.retryAfter}s`);
          await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
          updateStatus(ctx);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
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

    // Remember the chat so orchestration dispatched from the pi CLI
    // (no active Telegram turn) still has a chat to post status /
    // replies into.
    lastTelegramChatId = message.chat.id;

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

    const routing = routeMessage(text || "📎 attachment", {
      defaultSession: defaultName,
      leaderSession: myName,
      knownSessions: sessionNames,
    });

    // Download any media (skipping files over the Bot API's 20 MB download cap).
    const { files, oversize } = await downloadMessageFiles(message);
    if (oversize.length > 0) {
      const lines = oversize.map(
        (o) => `• ${o.name}${o.size > 0 ? ` (${(o.size / 1024 / 1024).toFixed(1)} MB)` : ""}`,
      );
      await sendPlainReply(
        message.chat.id,
        `Can't download — files over 20 MB are blocked by the Telegram Bot API:\n${lines.join("\n")}`,
      );
    }

    // If the message had *only* oversize attachments and no text, there's
    // nothing meaningful left to forward to the agent.
    if (!text && files.length === 0 && oversize.length > 0) return;

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
        // Thread the routing ack under the user's message for consistency
        // with the rest of the UI.
        try {
          await api.sendMessage(
            message.chat.id,
            `→ ${sessionEmoji(routing.targetSession)} @${routing.targetSession}`,
            undefined, undefined, message.message_id,
          );
        } catch {}
      }
    }
  }

  interface DownloadResult {
    files: InboxFile[];
    oversize: Array<{ name: string; size: number }>;
  }

  async function downloadMessageFiles(message: TelegramMessage): Promise<DownloadResult> {
    const downloads: Array<Promise<{
      file?: InboxFile;
      oversize?: { name: string; size: number };
    }>> = [];

    const enqueueDownload = (
      fileId: string,
      name: string,
      fileSize: number | undefined,
      isImage: boolean,
      mimeType?: string,
    ) => {
      // Pre-flight against Bot API getFile's 20 MB ceiling. If we skip here,
      // the end-user gets a clear "too large" message rather than a silent drop.
      if (fileSize !== undefined && fileSize > TELEGRAM_DOWNLOAD_LIMIT) {
        downloads.push(Promise.resolve({ oversize: { name, size: fileSize } }));
        return;
      }

      downloads.push((async () => {
        try {
          const path = await downloadFile(config.botToken, fileId, name, TEMP_DIR);
          return { file: { path, name, isImage, mimeType } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Telegram returns "file is too big" when size was unknown up front.
          if (/too big/i.test(msg)) return { oversize: { name, size: fileSize ?? 0 } };
          return {};
        }
      })());
    };

    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1]; // highest res
      enqueueDownload(photo.file_id, `photo_${message.message_id}.jpg`, photo.file_size, true, "image/jpeg");
    }
    if (message.document) {
      enqueueDownload(
        message.document.file_id,
        message.document.file_name || "document",
        message.document.file_size,
        false,
        message.document.mime_type,
      );
    }
    if (message.video) {
      enqueueDownload(
        message.video.file_id,
        message.video.file_name || "video.mp4",
        message.video.file_size,
        false,
        message.video.mime_type,
      );
    }
    if (message.audio) {
      enqueueDownload(
        message.audio.file_id,
        message.audio.file_name || "audio.mp3",
        message.audio.file_size,
        false,
        message.audio.mime_type,
      );
    }
    if (message.voice) {
      enqueueDownload(
        message.voice.file_id,
        `voice_${message.message_id}.ogg`,
        message.voice.file_size,
        false,
        message.voice.mime_type,
      );
    }

    const results = await Promise.all(downloads);
    const files = results.flatMap((result) => result.file ? [result.file] : []);
    const oversize = results.flatMap((result) => result.oversize ? [result.oversize] : []);
    return { files, oversize };
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
        await sendPlainReply(
          message.chat.id,
          `Unknown command /${name}. Try /sessions, /status, /stop.`,
        );
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
      queuedAttachments: [],
      historyInput: text,
    };

    void logTurnStart({ session: myName, userText: text, via: "telegram" });
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
        queuedAttachments: [],
        delegation: msg.delegation,
        historyInput: msg.text,
      };

      startTypingLoop(ctx, msg.chatId);
      void logTurnStart({
        session: myName,
        userText: msg.text,
        via: msg.delegation ? `delegated by ${msg.delegation.fromSession}` : "inbox",
      });
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
        stopLeaderCheck();  // No longer need to poll for leadership
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
    // DM chat id = paired user's id (Telegram convention). This seeds
    // `lastTelegramChatId` so orchestration kicked off from the pi CLI
    // can post to Telegram before any update has been received.
    if (lastTelegramChatId === undefined && config.allowedUserId !== undefined) {
      lastTelegramChatId = config.allowedUserId;
    }

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

    // Abort any in-flight pi turn so it doesn't try to reply after we disconnect.
    try { currentAbort?.(); } catch {}
    currentAbort = undefined;

    await stopPolling();
    stopInboxWatcher();
    stopLeaderCheck();
    stopTypingLoop();

    await unregisterSession(myName);
    await removeInbox(myName);
    await removeReplies(myName);

    activeTurn = undefined;
    previewMessageId = undefined;
    if (previewFlushTimer) {
      clearTimeout(previewFlushTimer);
      previewFlushTimer = undefined;
    }
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

  // ─── Temp-file Cleanup ─────────────────────────────────────────

  async function cleanupTempDir(dir: string, maxAgeMs: number): Promise<void> {
    const now = Date.now();
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (now - s.mtimeMs > maxAgeMs) await unlink(full);
      } catch {}
    }
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
        let size: number;
        try {
          const s = await stat(p);
          size = s.size;
        } catch {
          return {
            content: [{ type: "text", text: `File not found: ${p}` }],
            details: {},
            isError: true,
          };
        }
        if (size > TELEGRAM_UPLOAD_LIMIT) {
          const mb = (size / 1024 / 1024).toFixed(1);
          return {
            content: [{
              type: "text",
              text: `File too large for Telegram (${mb} MB; limit is 50 MB via Bot API): ${p}`,
            }],
            details: {},
            isError: true,
          };
        }
        activeTurn.queuedAttachments.push(p);
      }
      return {
        content: [{ type: "text", text: `Queued ${params.paths.length} file(s) for Telegram delivery.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "telegram_delegate",
    label: "Telegram Delegate",
    description:
      "Dispatch a subtask to another connected pi session via the Telegram bridge. NON-BLOCKING: returns immediately after dispatch. The target's reply will arrive later as a new user message prefixed '[delegation-reply from @target]' (or -error / -timeout). Leader-only.",
    parameters: Type.Object({
      target: Type.String({ description: "Target session name (no @ prefix)." }),
      task: Type.String({ description: "Instruction to forward to the target session." }),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 10, maximum: 3600 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!isLeader) {
        return {
          content: [{ type: "text", text: "telegram_delegate is leader-only. This session is not the leader." }],
          details: {},
          isError: true,
        };
      }
      // Determine the chat to post status / receive replies in. Prefer
      // the active Telegram turn's chat; fall back to the last Telegram
      // chat we've seen (or the paired user's DM id). Without any, the
      // tool can't work because the target has nowhere to post its reply.
      const chatId = activeTurn?.chatId ?? lastTelegramChatId;
      if (chatId === undefined) {
        return {
          content: [{ type: "text", text: "No Telegram chat known — send a message to the bot first (or use /start) so the bridge has a chat to post to." }],
          details: {},
          isError: true,
        };
      }
      const target = params.target.replace(/^@/, "").trim();
      if (!target) {
        return { content: [{ type: "text", text: "target is required." }], details: {}, isError: true };
      }
      if (target.toLowerCase() === myName.toLowerCase()) {
        return {
          content: [{ type: "text", text: "Refusing to delegate to self. Handle the task directly." }],
          details: {},
          isError: true,
        };
      }

      const found = await findSession(target);
      if (!found) {
        return {
          content: [{ type: "text", text: `Unknown or dead session "@${target}". Use /telegram-status to see live sessions.` }],
          details: {},
          isError: true,
        };
      }

      const correlationId = `dlg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const rootReplyToMessageId = activeTurn?.replyToMessageId ?? 0;
      const startedAt = Date.now();
      const timeoutSec = params.timeoutSeconds ?? DEFAULT_DELEGATE_TIMEOUT_S;

      // Transparent status bubble — user sees the delegation kick off.
      // Thread it under the user's triggering message for a clean tree.
      const taskExcerpt = params.task.length > DELEGATE_STATUS_EXCERPT_CHARS
        ? params.task.slice(0, DELEGATE_STATUS_EXCERPT_CHARS - 1) + "…"
        : params.task;
      let dispatchMessageId: number | undefined;
      try {
        const sent = await api.sendMessage(
          chatId,
          `→ ${sessionEmoji(target)} @${target} · ${taskExcerpt}`,
          undefined,
          undefined,
          rootReplyToMessageId || undefined,
        );
        dispatchMessageId = sent.message_id;
      } catch {}

      // Write to target's inbox. Its final reply threads under the
      // dispatch bubble (if we got one), making the per-target reply
      // tree visible in Telegram.
      try {
        await writeToInbox(target, {
          id: correlationId,
          chatId,
          replyToMessageId: dispatchMessageId ?? rootReplyToMessageId,
          text: params.task,
          files: [],
          timestamp: startedAt,
          delegation: {
            correlationId,
            fromSession: myName,
            replyChannel: myName,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to write to inbox of @${target}: ${msg}` }],
          details: {},
          isError: true,
        };
      }

      // Schedule timeout — fires `onDelegationResult` if no reply lands first.
      const timeoutHandle = setTimeout(() => {
        const pending = pendingDelegations.get(correlationId);
        if (!pending) return;
        pendingDelegations.delete(correlationId);
        void onDelegationResult(
          ctx,
          pending,
          "timeout",
          "",
          `no reply after ${timeoutSec}s`,
        );
      }, timeoutSec * 1000);
      // Node's setTimeout keeps the event loop alive by default. Delegations
      // should not block graceful shutdown on their own.
      timeoutHandle.unref?.();

      pendingDelegations.set(correlationId, {
        correlationId,
        target,
        task: params.task,
        startedAt,
        timeoutSec,
        timeoutHandle,
        chatId,
        dispatchMessageId,
        rootReplyToMessageId,
      });

      void logDelegationDispatch({
        from: myName,
        to: target,
        task: params.task,
        correlationId,
      });

      // Return immediately — the reply arrives later as an injected user message.
      return {
        content: [{
          type: "text",
          text:
            `Dispatched to @${target} (correlationId ${correlationId}, timeout ${timeoutSec}s). ` +
            `You'll receive the reply as a new user message prefixed "[delegation-reply from @${target}]". ` +
            `Continue with other work; don't block waiting for this.`,
        }],
        details: { target, correlationId, status: "dispatched", timeoutSec },
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
        // Remove the stale inbox file under the old name so it doesn't
        // accumulate undelivered messages or linger after rename.
        if (oldName && oldName !== myName) {
          try { await removeInbox(oldName); } catch {}
        }
      }
      ctx.ui.notify(`Renamed: @${oldName} → @${myName}`, "info");
      updateStatus(ctx);
    },
  });

  // ─── Lifecycle Hooks ────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    config = await readTelegramConfig(CONFIG_PATH);
    await mkdir(TEMP_DIR, { recursive: true });
    // Best-effort sweep of old downloads from previous sessions.
    void cleanupTempDir(TEMP_DIR, 24 * 60 * 60 * 1000);
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
      try { await removeReplies(myName); } catch {}
      activeTurn = undefined;
      currentAbort = undefined;
      isConnected = false;
      isLeader = false;
      isDefault = false;
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const e = event as { prompt: string; systemPrompt: string };
    // Idempotent: if pi re-emits the original systemPrompt each turn this
    // is a no-op; if it accumulates, skip to avoid duplicating the suffix.
    if (e.systemPrompt.includes("Telegram bridge extension is active")) {
      return { systemPrompt: e.systemPrompt };
    }
    let suffix = e.prompt.trimStart().startsWith(TELEGRAM_PREFIX)
      ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
      : SYSTEM_PROMPT_SUFFIX;
    if (isLeader && isConnected) {
      const sessions = await listSessions().catch(() => []);
      const peerLines = sessions
        .filter((s) => s.name !== myName)
        .map((s) => `  - @${s.name} (cwd: ${s.cwd})`);
      const peers = peerLines.length > 0 ? `\nPeer sessions:\n${peerLines.join("\n")}` : "\nPeer sessions: (none currently connected)";
      suffix += LEADER_ORCHESTRATION_SUFFIX + peers + "\n" + renderPendingBlock();
    }
    return { systemPrompt: e.systemPrompt + suffix };
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentAbort = () => ctx.abort();
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const turn = activeTurn;
    const editTarget = previewMessageId;
    currentAbort = undefined;
    stopTypingLoop();
    if (previewFlushTimer) {
      clearTimeout(previewFlushTimer);
      previewFlushTimer = undefined;
    }
    previewMessageId = undefined;
    lastPreviewHtml = "";
    activeTurn = undefined;
    updateStatus(ctx);

    if (!turn) return;

    const e = event as { messages: Array<{ role?: string; content?: unknown; stopReason?: string; errorMessage?: string }> };
    const text = extractAssistantText(e.messages);
    const stopReason = e.messages[e.messages.length - 1]?.stopReason;
    const isError = stopReason === "error" || (!text && stopReason !== "stop");
    const finalText = isError ? "Error processing request." : (text ?? "");

    // Final reply — edit the streaming preview in place if one exists.
    // When sending fresh chunks, thread under whatever message triggered
    // this turn (the user's original message for a direct turn; the
    // dispatch bubble for a delegated turn; the root for an injected
    // reply turn). 0 → undefined so the API call omits reply_to.
    const threadTo = turn.replyToMessageId || undefined;
    if (isError) {
      await deliverFinalReply(turn.chatId, finalText, editTarget, threadTo);
    } else if (text) {
      await deliverFinalReply(turn.chatId, text, editTarget, threadTo);
    } else if (editTarget !== undefined) {
      // No final text but we had a preview — remove the stale bubble.
      await api.deleteMessage(turn.chatId, editTarget);
    }

    // Mirror the result to the delegator's reply channel. The delegator's
    // reply watcher will drain the record and inject a follow-up user
    // message ("[delegation-reply from @<us>] …") into its own pi session.
    // Non-fatal on failure.
    if (turn.delegation) {
      const rec: ReplyRecord = {
        correlationId: turn.delegation.correlationId,
        fromSession: myName,
        text: finalText,
        ok: !isError,
        error: isError ? "target session reported error" : undefined,
        timestamp: Date.now(),
      };
      try { await writeReply(turn.delegation.replyChannel, rec); } catch {}
    }

    if (turn.historyInput !== undefined) {
      void logTurnEnd({ session: myName, replyText: finalText });
    }

    // Send queued attachments, threaded under this turn's trigger.
    for (const filePath of turn.queuedAttachments) {
      try {
        const name = basename(filePath);
        await api.sendDocument(turn.chatId, filePath, name, undefined, threadTo);
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

    const preview = buildPreview(myName, text);
    if (preview === lastPreviewHtml) return;

    // Throttled preview update
    if (previewFlushTimer) clearTimeout(previewFlushTimer);
    previewFlushTimer = setTimeout(async () => {
      previewFlushTimer = undefined;
      if (!activeTurn || !config.botToken || preview === lastPreviewHtml) return;
      try {
        if (previewMessageId) {
          await api.editMessageText(activeTurn.chatId, previewMessageId, preview, "HTML");
        } else {
          const previewThreadTo = activeTurn.replyToMessageId || undefined;
          const sent = await api.sendMessage(
            activeTurn.chatId,
            preview,
            "HTML",
            undefined,
            previewThreadTo,
          );
          previewMessageId = sent.message_id;
        }
        lastPreviewHtml = preview;
      } catch {}
    }, PREVIEW_THROTTLE_MS);
  });

  pi.on("message_start", async (event, _ctx) => {
    // Reset the preview anchor on each new assistant message within a turn.
    // If a preview bubble from a prior assistant message is still in the
    // chat, delete it so we don't leave orphan previews stacking up when
    // the agent interleaves text/tool-use messages.
    const e = event as { message: { role?: string } };
    if (e.message?.role !== "assistant") return;
    const stale = previewMessageId;
    previewMessageId = undefined;
    lastPreviewHtml = "";
    if (stale !== undefined && activeTurn) {
      await api.deleteMessage(activeTurn.chatId, stale);
    }
  });
}
