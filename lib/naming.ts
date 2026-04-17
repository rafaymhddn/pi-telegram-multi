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
 * Per-session emoji. Two-tier lookup:
 *
 *   1. Canonical table — if the session name (case-insensitive) is a
 *      One Piece / classic anime character, use its iconic emoji. This
 *      gives the stable mapping users expect: `👒 = luffy` always,
 *      `🗡️ = zoro` always, regardless of machine or process.
 *
 *   2. Hash fallback — for unknown names, djb2-hash into a pirate-
 *      themed palette so every session still gets a stable glyph.
 *
 * Lookup is by the name's base identifier (lowercase, ignoring any
 * trailing `_1234` suffix from auto-generated names), so `luffy_4821`
 * still resolves to `👒`.
 */
const CHARACTER_EMOJI: Record<string, string> = {
  // Straw Hat Pirates
  luffy: "👒",
  zoro: "🗡️",
  sanji: "🔥",
  nami: "🍊",
  usopp: "🎯",
  chopper: "🦌",
  robin: "📚",
  franky: "🔩",
  brook: "💀",
  jimbei: "🐟",
  // Other notable pirates / marines
  ace: "🔥",
  sabo: "🎩",
  shanks: "⚔️",
  law: "🩺",
  kid: "🧲",
  buggy: "🤡",
  boa: "🐍",
  mihawk: "🦅",
  whitebeard: "🔱",
  blackbeard: "🌑",
  // Ships / flavor
  sunny: "🌞",
  merry: "🐑",
};

const FALLBACK_EMOJI_PALETTE = [
  "⚔️", "🍊", "🎯", "🦌", "📖", "🔧",
  "🎻", "🐟", "🧭", "🗺️", "⚓", "🏴‍☠️", "💰", "🌊",
] as const;

function baseIdentifier(name: string): string {
  return name.toLowerCase().replace(/_\d+$/, "");
}

export function sessionEmoji(name: string): string {
  const base = baseIdentifier(name);
  const canonical = CHARACTER_EMOJI[base];
  if (canonical) return canonical;

  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_EMOJI_PALETTE[h % FALLBACK_EMOJI_PALETTE.length];
}
