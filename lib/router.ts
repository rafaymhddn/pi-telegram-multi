/**
 * Message routing — parse @mentions, resolve target session.
 *
 * Routing modes:
 *   direct      — send straight to the named (single, non-leader) session.
 *                 Session replies to the user on its own. Fast path.
 *   orchestrate — send to the leader, which uses the `delegate` tool to
 *                 coordinate across sessions. Triggered by multi-mention
 *                 or by explicit `@leader` single-mention.
 */
import type { SessionEntry } from "./registry.ts";

export type RoutingMode = "direct" | "orchestrate";

export interface RoutingResult {
  /** Session that will execute the turn. */
  targetSession: string;
  /** Text forwarded to the target. For orchestrate-multi, mentions are kept intact. */
  text: string;
  /** True if any leading @mention matched a known session. */
  explicit: boolean;
  /** direct = target session replies to user itself; orchestrate = leader coordinates. */
  mode: RoutingMode;
  /** Resolved session names from the leading mention block, in order. */
  mentions: string[];
}

export interface RoutingContext {
  defaultSession: string;
  leaderSession: string;
  knownSessions: string[];
}

const MENTION_TOKEN = /^@([a-zA-Z0-9._-]+)/;

/**
 * Parse the contiguous leading @mention block of a message.
 * Returns { mentions: [rawNames...], rest: "..." }.
 */
function parseLeadingMentions(text: string): { mentions: string[]; rest: string } {
  const mentions: string[] = [];
  let i = 0;
  const s = text.trimStart();
  // Preserve how much leading whitespace was skipped so we don't shift non-space.
  let cursor = 0;
  let t = s;
  while (true) {
    const m = t.match(MENTION_TOKEN);
    if (!m) break;
    mentions.push(m[1]);
    // Advance past "@name" and any single whitespace separator.
    cursor = m[0].length;
    t = t.slice(cursor);
    // Eat one run of whitespace between mentions, but stop if none.
    const wsMatch = t.match(/^(\s+)/);
    if (wsMatch) {
      t = t.slice(wsMatch[1].length);
    } else {
      // No whitespace after this mention — stop (treat as end of block).
      break;
    }
    i++;
    if (i > 16) break; // sanity guard
  }
  return { mentions, rest: t.trim() };
}

/**
 * Resolve raw mention names to canonical session names (case-insensitive lookup).
 * Preserves order; drops unknown mentions.
 */
function resolveMentions(raw: string[], known: string[]): string[] {
  const resolved: string[] = [];
  for (const name of raw) {
    const hit = known.find((s) => s.toLowerCase() === name.toLowerCase());
    if (hit && !resolved.includes(hit)) resolved.push(hit);
  }
  return resolved;
}

export function routeMessage(text: string, ctx: RoutingContext): RoutingResult {
  const trimmed = text.trim();
  const { mentions: raw, rest } = parseLeadingMentions(trimmed);
  const resolved = resolveMentions(raw, ctx.knownSessions);

  // No matching mentions → default session, text unchanged.
  if (resolved.length === 0) {
    return {
      targetSession: ctx.defaultSession,
      text: trimmed,
      explicit: false,
      mode: "direct",
      mentions: [],
    };
  }

  // Single mention: direct unless it's the leader (explicit orchestration opt-in).
  if (resolved.length === 1) {
    const target = resolved[0];
    const isLeaderMention = target.toLowerCase() === ctx.leaderSession.toLowerCase();
    return {
      targetSession: target,
      text: rest || "continue",
      explicit: true,
      mode: isLeaderMention ? "orchestrate" : "direct",
      mentions: resolved,
    };
  }

  // Multi-mention → leader orchestrates; keep the full original text so the
  // leader's agent can see the tags and decide how to fan out.
  return {
    targetSession: ctx.leaderSession,
    text: trimmed,
    explicit: true,
    mode: "orchestrate",
    mentions: resolved,
  };
}

/**
 * Check if text is a Telegram bot command.
 */
export function parseBotCommand(
  text: string,
): { name: string; args: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [head, ...tail] = trimmed.split(/\s+/);
  const name = head.slice(1).split("@")[0]?.toLowerCase();
  if (!name) return undefined;
  return { name, args: tail.join(" ").trim() };
}

/**
 * Extract text from a Telegram message (text or caption).
 */
export function extractText(text?: string, caption?: string): string {
  return (text || caption || "").trim();
}

// Re-export SessionEntry to avoid unused import lint warning when only types used.
export type { SessionEntry };
