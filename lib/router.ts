/**
 * Message routing — parse @mentions, resolve target session.
 */
import type { SessionEntry } from "./registry.ts";

export interface RoutingResult {
  /** Target session name (resolved from @mention or default) */
  targetSession: string;
  /** Message text with @mention stripped */
  text: string;
  /** Whether this was explicitly addressed via @mention */
  explicit: boolean;
}

/**
 * Parse a Telegram message text for @session_name routing.
 *
 * Formats:
 *   "@name some message"       → route to "name"
 *   "regular message"          → route to default session
 *   "/sessions"                → control command (no routing)
 */
export function routeMessage(
  text: string,
  defaultSession: string,
  knownSessions: string[],
): RoutingResult {
  const trimmed = text.trim();

  // Check for @mention at start
  const mentionMatch = trimmed.match(/^@([a-zA-Z0-9._-]+)\s*(.*)/s);
  if (mentionMatch) {
    const mentioned = mentionMatch[1].toLowerCase();
    const remaining = (mentionMatch[2] || "").trim();
    const match = knownSessions.find(
      (s) => s.toLowerCase() === mentioned,
    );
    if (match) {
      return {
        targetSession: match,
        text: remaining || "continue",
        explicit: true,
      };
    }
    // Unknown @mention — return as-is with default routing
    // (don't eat the @mention if it's not a known session)
  }

  return {
    targetSession: defaultSession,
    text: trimmed,
    explicit: false,
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
