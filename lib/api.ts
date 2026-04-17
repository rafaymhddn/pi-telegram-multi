/**
 * Telegram API helpers — thin wrappers around the Bot HTTP API.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// --- Config ---

export interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
}

export async function readTelegramConfig(configPath: string): Promise<TelegramConfig> {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

export async function writeTelegramConfig(
  agentDir: string,
  configPath: string,
  config: TelegramConfig,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

// --- API types ---

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramApiError extends Error {
  constructor(public method: string, public description: string) {
    super(`${method}: ${description}`);
    this.name = "TelegramApiError";
  }
}

export class RateLimitError extends TelegramApiError {
  constructor(method: string, description: string, public retryAfter: number) {
    super(method, description);
    this.name = "RateLimitError";
  }
}

export class NotConfiguredError extends Error {
  constructor() {
    super("Telegram bot token is not configured");
    this.name = "NotConfiguredError";
  }
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramSticker {
  file_id: string;
  emoji?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  sticker?: TelegramSticker;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramSentMessage {
  message_id: number;
}

interface TelegramGetFileResult {
  file_path: string;
}

// --- API calls ---

const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_S = 30;

function handleApiResult<T>(method: string, data: ApiResponse<T>): T {
  if (data.ok && data.result !== undefined) return data.result;
  const desc = data.description || `Telegram API ${method} failed`;
  const retry = data.parameters?.retry_after;
  if (retry !== undefined) throw new RateLimitError(method, desc, retry);
  throw new TelegramApiError(method, desc);
}

async function callApi<T>(
  botToken: string | undefined,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (!botToken) throw new NotConfiguredError();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const data = (await res.json()) as ApiResponse<T>;
      return handleApiResult(method, data);
    } catch (err) {
      lastErr = err;
      if (
        err instanceof RateLimitError &&
        attempt < MAX_RATE_LIMIT_RETRIES &&
        err.retryAfter <= MAX_RATE_LIMIT_WAIT_S &&
        !signal?.aborted
      ) {
        await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function callMultipartApi<T>(
  botToken: string | undefined,
  method: string,
  fields: Record<string, string>,
  fileField: string,
  filePath: string,
  fileName: string,
  signal?: AbortSignal,
): Promise<T> {
  if (!botToken) throw new NotConfiguredError();
  const buf = await readFile(filePath);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      form.set(fileField, new Blob([buf]), fileName);
      const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        body: form,
        signal,
      });
      const data = (await res.json()) as ApiResponse<T>;
      return handleApiResult(method, data);
    } catch (err) {
      lastErr = err;
      if (
        err instanceof RateLimitError &&
        attempt < MAX_RATE_LIMIT_RETRIES &&
        err.retryAfter <= MAX_RATE_LIMIT_WAIT_S &&
        !signal?.aborted
      ) {
        await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function downloadFile(
  botToken: string | undefined,
  fileId: string,
  suggestedName: string,
  tempDir: string,
): Promise<string> {
  if (!botToken) throw new NotConfiguredError();
  const file = await callApi<TelegramGetFileResult>(botToken, "getFile", { file_id: fileId });
  await mkdir(tempDir, { recursive: true });
  const safeName = suggestedName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const target = join(tempDir, `${Date.now()}-${safeName}`);
  const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Failed to download Telegram file: ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
  return target;
}

// --- Convenience wrappers ---

export function makeApiClient(getToken: () => string | undefined) {
  return {
    getMe: (signal?: AbortSignal) =>
      callApi<TelegramUser>(getToken(), "getMe", {}, signal),

    getUpdates: (offset: number, timeout: number, signal?: AbortSignal) =>
      callApi<TelegramUpdate[]>(getToken(), "getUpdates", {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      }, signal),

    sendMessage: (
      chatId: number,
      text: string,
      parseMode?: string,
      signal?: AbortSignal,
      replyToMessageId?: number,
    ) =>
      callApi<TelegramSentMessage>(getToken(), "sendMessage", {
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        // `allow_sending_without_reply` ensures we still post if the
        // referenced message was deleted by the user.
        ...(replyToMessageId
          ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true }
          : {}),
      }, signal),

    editMessageText: (chatId: number, messageId: number, text: string, parseMode?: string, signal?: AbortSignal) =>
      callApi<TelegramSentMessage | boolean>(getToken(), "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }, signal),

    deleteMessage: (chatId: number, messageId: number, signal?: AbortSignal) =>
      callApi<boolean>(getToken(), "deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      }, signal).catch(() => false as boolean),

    sendDocument: (
      chatId: number,
      filePath: string,
      fileName: string,
      signal?: AbortSignal,
      replyToMessageId?: number,
    ) =>
      callMultipartApi<TelegramSentMessage>(getToken(), "sendDocument", {
        chat_id: String(chatId),
        ...(replyToMessageId
          ? { reply_to_message_id: String(replyToMessageId), allow_sending_without_reply: "true" }
          : {}),
      }, "document", filePath, fileName, signal),

    sendChatAction: (chatId: number, action: string, signal?: AbortSignal) =>
      callApi<boolean>(getToken(), "sendChatAction", { chat_id: chatId, action }, signal),

    deleteWebhook: (signal?: AbortSignal) =>
      callApi<boolean>(getToken(), "deleteWebhook", { drop_pending_updates: false }, signal),

    setMyCommands: (commands: { command: string; description: string }[], signal?: AbortSignal) =>
      callApi<boolean>(getToken(), "setMyCommands", { commands }, signal),

    answerCallbackQuery: (id: string, text?: string, signal?: AbortSignal) =>
      callApi<boolean>(getToken(), "answerCallbackQuery", {
        callback_query_id: id,
        ...(text ? { text } : {}),
      }, signal).catch(() => false as boolean),
  };
}
