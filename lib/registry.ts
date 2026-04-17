/**
 * Session registry — shared state for all connected sessions.
 *
 * File: ~/.pi/agent/telegram-multi/registry.json
 *
 * All sessions read/write this file to register, discover peers,
 * and coordinate leader election.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const MULTI_DIR = join(homedir(), ".pi", "agent", "telegram-multi");

export interface SessionEntry {
  name: string;
  pid: number;
  cwd: string;
  sessionFile?: string;
  isDefault: boolean;
  connectedAt: string;
}

export interface Registry {
  sessions: Record<string, SessionEntry>;
  leader: string | null;
  leaderPid: number | null;
}

const REGISTRY_PATH = join(MULTI_DIR, "registry.json");

export async function readRegistry(): Promise<Registry> {
  try {
    return JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
  } catch {
    return { sessions: {}, leader: null, leaderPid: null };
  }
}

export async function writeRegistry(registry: Registry): Promise<void> {
  await mkdir(MULTI_DIR, { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

/**
 * Check if a PID is still alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = existence check (throws if process doesn't exist)
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register this session. Returns the registry after update.
 * Sets isDefault = true only if no other default exists.
 */
export async function registerSession(entry: SessionEntry): Promise<Registry> {
  const registry = await readRegistry();

  // Clean up dead sessions
  for (const [name, sess] of Object.entries(registry.sessions)) {
    if (!isPidAlive(sess.pid)) {
      delete registry.sessions[name];
      if (registry.leader === name) {
        registry.leader = null;
        registry.leaderPid = null;
      }
    }
  }

  // If no default, this session becomes default
  const hasDefault = Object.values(registry.sessions).some((s) => s.isDefault && s.name !== entry.name);
  if (!hasDefault) {
    entry.isDefault = true;
  }

  registry.sessions[entry.name] = entry;

  // If no leader, become leader
  if (!registry.leader || !registry.sessions[registry.leader] || !isPidAlive(registry.sessions[registry.leader].pid)) {
    registry.leader = entry.name;
    registry.leaderPid = entry.pid;
  }

  await writeRegistry(registry);
  return registry;
}

/**
 * Remove a session from the registry.
 */
export async function unregisterSession(name: string): Promise<Registry> {
  const registry = await readRegistry();
  delete registry.sessions[name];

  // If this was the leader, elect a new one
  if (registry.leader === name) {
    registry.leader = null;
    registry.leaderPid = null;
    const alive = Object.values(registry.sessions).find((s) => isPidAlive(s.pid));
    if (alive) {
      registry.leader = alive.name;
      registry.leaderPid = alive.pid;
    }
  }

  // If this was the default, elect a new default
  const hasDefault = Object.values(registry.sessions).some((s) => s.isDefault);
  if (!hasDefault) {
    const first = Object.values(registry.sessions)[0];
    if (first) first.isDefault = true;
  }

  await writeRegistry(registry);
  return registry;
}

/**
 * Check if the current leader is alive. If not, claim leadership.
 * Returns true if we are (now) the leader.
 */
export async function ensureLeadership(myName: string, myPid: number): Promise<boolean> {
  const registry = await readRegistry();

  // Already leader?
  if (registry.leader === myName && registry.leaderPid === myPid) {
    return true;
  }

  // Leader alive?
  if (registry.leader && registry.leaderPid && isPidAlive(registry.leaderPid)) {
    return false;
  }

  // Claim leadership
  registry.leader = myName;
  registry.leaderPid = myPid;
  await writeRegistry(registry);
  return true;
}

/**
 * Look up an alive session by name. Returns undefined for unknown or dead sessions.
 */
export async function findSession(name: string): Promise<SessionEntry | undefined> {
  const registry = await readRegistry();
  const entry = registry.sessions[name];
  if (!entry) return undefined;
  if (!isPidAlive(entry.pid)) return undefined;
  return entry;
}

/**
 * Get the default session.
 */
export async function getDefaultSession(): Promise<SessionEntry | undefined> {
  const registry = await readRegistry();
  return Object.values(registry.sessions).find((s) => s.isDefault);
}

/**
 * List all alive sessions.
 */
export async function listSessions(): Promise<SessionEntry[]> {
  const registry = await readRegistry();
  return Object.values(registry.sessions).filter((s) => isPidAlive(s.pid));
}
