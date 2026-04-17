/**
 * Shared JSONL queue helpers.
 *
 * Writers append newline-delimited JSON records to a live queue file.
 * Readers atomically drain the queue by renaming the live file to a unique
 * snapshot path before reading it. New writers then create/append to a fresh
 * live file, so no records are lost between read and clear.
 */
import { appendFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

let drainCounter = 0;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

function makeDrainPath(path: string): string {
  drainCounter += 1;
  return `${path}.drain-${process.pid}-${Date.now()}-${drainCounter}`;
}

export async function appendJsonlRecord(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

export async function readAndDrainJsonlRecords<T>(path: string): Promise<T[]> {
  const drainPath = makeDrainPath(path);

  try {
    await rename(path, drainPath);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return [];
    throw err;
  }

  try {
    const content = await readFile(drainPath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } finally {
    try {
      await unlink(drainPath);
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
    }
  }
}

export async function removeQueueFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
  }
}
