/**
 * Session naming: use pi's /name command, else derive from cwd + random suffix
 */
import { basename } from "node:path";

/**
 * Resolve the display name for this session.
 * Priority: session name (set via /name) → basename(cwd) + random digits
 */
export function resolveSessionName(
  sessionName: string | undefined,
  cwd: string,
): string {
  if (sessionName && sessionName.trim().length > 0) {
    return sanitizeName(sessionName.trim());
  }
  const dir = basename(cwd) || "session";
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return sanitizeName(`${dir}_${suffix}`);
}

/**
 * Sanitize a name for use as a session identifier (file-safe, mention-safe).
 */
export function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
}

/**
 * Deterministic per-session emoji. Same `name` always hashes to the
 * same glyph so users learn `👒 = luffy` across messages without any
 * configuration. Palette: One Piece / pirate crew vibes — straw hat
 * crew attributes (hat, swords, fire, mikan, bullseye, reindeer, book,
 * wrench, violin, fish) plus classic pirate flavor (compass, map,
 * anchor, jolly roger, treasure, wave). Works for any session name,
 * not just One Piece ones; the theme just gives it personality.
 */
const SESSION_EMOJI_PALETTE = [
  "👒", "⚔️", "🔥", "🍊", "🎯", "🦌", "📖", "🔧",
  "🎻", "🐟", "🧭", "🗺️", "⚓", "🏴‍☠️", "💰", "🌊",
] as const;

export function sessionEmoji(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  }
  return SESSION_EMOJI_PALETTE[h % SESSION_EMOJI_PALETTE.length];
}
