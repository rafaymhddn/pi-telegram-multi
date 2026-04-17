/**
 * Reply channel — per-session delegation-reply queue via JSONL files.
 *
 * When a session acts on a delegated inbox message, it writes its final
 * assistant text back to the delegator's reply-channel file. The delegator
 * polls this file and resolves the pending `delegate()` tool promise.
 *
 * File: ~/.pi/agent/telegram-multi/replies/<session-name>.jsonl
 */
import { join } from "node:path";
import { MULTI_DIR } from "./registry.ts";
import { appendJsonlRecord, readAndDrainJsonlRecords, removeQueueFile } from "./jsonl-queue.ts";

export interface ReplyRecord {
  correlationId: string;
  fromSession: string;
  text: string;
  ok: boolean;
  error?: string;
  timestamp: number;
}

const REPLIES_DIR = join(MULTI_DIR, "replies");

function replyPath(sessionName: string): string {
  return join(REPLIES_DIR, `${sessionName}.jsonl`);
}

export async function writeReply(sessionName: string, record: ReplyRecord): Promise<void> {
  await appendJsonlRecord(replyPath(sessionName), record);
}

export async function readAndClearReplies(sessionName: string): Promise<ReplyRecord[]> {
  return readAndDrainJsonlRecords<ReplyRecord>(replyPath(sessionName));
}

export async function removeReplies(sessionName: string): Promise<void> {
  await removeQueueFile(replyPath(sessionName));
}
