/**
 * Inbox — per-session message queue via JSONL files.
 *
 * The leader writes to non-leader inbox files.
 * Non-leaders poll and drain their own inbox.
 *
 * File: ~/.pi/agent/telegram-multi/inbox/<session-name>.jsonl
 */
import { mkdir, readFile, writeFile, appendFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { MULTI_DIR } from "./registry.ts";

export interface InboxMessage {
  id: string;
  chatId: number;
  replyToMessageId: number;
  text: string;
  files: InboxFile[];
  timestamp: number;
}

export interface InboxFile {
  path: string;
  name: string;
  isImage: boolean;
  mimeType?: string;
}

const INBOX_DIR = join(MULTI_DIR, "inbox");

function inboxPath(sessionName: string): string {
  return join(INBOX_DIR, `${sessionName}.jsonl`);
}

/**
 * Write a message to a session's inbox.
 */
export async function writeToInbox(sessionName: string, msg: InboxMessage): Promise<void> {
  await mkdir(INBOX_DIR, { recursive: true });
  const line = JSON.stringify(msg) + "\n";
  await appendFile(inboxPath(sessionName), line, "utf8");
}

/**
 * Read and drain all messages from a session's inbox.
 * Returns messages in order. Clears the file after reading.
 */
export async function readAndClearInbox(sessionName: string): Promise<InboxMessage[]> {
  const path = inboxPath(sessionName);
  if (!existsSync(path)) return [];

  try {
    const content = await readFile(path, "utf8");
    // Clear immediately
    await writeFile(path, "", "utf8");

    return content
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as InboxMessage);
  } catch {
    return [];
  }
}

/**
 * Remove inbox file (on disconnect).
 */
export async function removeInbox(sessionName: string): Promise<void> {
  try {
    await unlink(inboxPath(sessionName));
  } catch {
    // ignore
  }
}
