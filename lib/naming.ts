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
