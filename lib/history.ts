/**
 * Orchestration log — append-only markdown journal of leader turns and
 * delegations. Shared across sessions via the telegram-multi dir so any
 * session (including newly promoted leaders) can read past history.
 *
 * File: ~/.pi/agent/telegram-multi/orchestration-log.md
 */
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { MULTI_DIR } from "./registry.ts";

const LOG_PATH = join(MULTI_DIR, "orchestration-log.md");

function iso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

async function append(text: string): Promise<void> {
  try {
    await mkdir(MULTI_DIR, { recursive: true });
    await appendFile(LOG_PATH, text, "utf8");
  } catch {
    // non-fatal
  }
}

export async function logTurnStart(args: { session: string; userText: string; via?: string }): Promise<void> {
  const via = args.via ? ` · via ${args.via}` : "";
  await append(`\n## ${iso()} — ${args.session}${via}\n**Input:** ${truncate(args.userText, 400)}\n`);
}

export async function logDelegationDispatch(args: {
  from: string;
  to: string;
  task: string;
  correlationId: string;
}): Promise<void> {
  const task = truncate(args.task, 160);
  await append(`- ${iso()} DISPATCH ${args.from} → @${args.to} [${args.correlationId}] · "${task}"\n`);
}

export type DelegationResultStatus = "ok" | "error" | "timeout";

export async function logDelegationResult(args: {
  from: string;
  to: string;
  correlationId: string;
  status: DelegationResultStatus;
  durationMs: number;
  resultExcerpt?: string;
  error?: string;
}): Promise<void> {
  const sec = (args.durationMs / 1000).toFixed(1);
  const mark = args.status === "ok" ? "✓" : args.status === "timeout" ? "⏱" : "⚠";
  const detail = args.status === "ok"
    ? (args.resultExcerpt ? ` — ${truncate(args.resultExcerpt, 200)}` : "")
    : ` — ${truncate(args.error ?? args.status, 200)}`;
  await append(`- ${iso()} RESULT   @${args.to} → ${args.from} [${args.correlationId}] · ${mark} ${sec}s${detail}\n`);
}

export async function logTurnEnd(args: { session: string; replyText: string }): Promise<void> {
  await append(`**Reply:** ${truncate(args.replyText, 600)}\n\n---\n`);
}
