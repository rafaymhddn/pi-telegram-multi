/**
 * Inbox — per-session message queue via JSONL files.
 *
 * The leader writes to non-leader inbox files.
 * Non-leaders poll and drain their own inbox.
 *
 * File: ~/.pi/agent/telegram-multi/inbox/<session-name>.jsonl
 */
import { join } from "node:path";
import { MULTI_DIR } from "./registry.ts";
import { appendJsonlRecord, readAndDrainJsonlRecords, removeQueueFile } from "./jsonl-queue.ts";

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
  await appendJsonlRecord(inboxPath(sessionName), msg);
}

/**
 * Read and drain all messages from a session's inbox.
 * Returns messages in FIFO order using an atomic rename-on-drain snapshot.
 */
export async function readAndClearInbox(sessionName: string): Promise<InboxMessage[]> {
  return readAndDrainJsonlRecords<InboxMessage>(inboxPath(sessionName));
}

/**
 * Remove inbox file (on disconnect).
 */
export async function removeInbox(sessionName: string): Promise<void> {
  await removeQueueFile(inboxPath(sessionName));
}
