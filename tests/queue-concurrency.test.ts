import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = await mkdtemp(join(tmpdir(), "pi-telegram-multi-test-home-"));
process.env.HOME = tempHome;

const inbox = await import("../lib/inbox.ts");
const replies = await import("../lib/replies.ts");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

describe("atomic JSONL queue draining", () => {
  test("readAndClearInbox handles missing files safely", async () => {
    await expect(inbox.readAndClearInbox("missing-session")).resolves.toEqual([]);
  });

  test("readAndClearReplies handles missing files safely", async () => {
    await expect(replies.readAndClearReplies("missing-session")).resolves.toEqual([]);
  });

  test("inbox preserves FIFO ordering without losing records under concurrent drain/write", async () => {
    const total = 2000;
    const session = `inbox-${Date.now()}`;
    const seen: number[] = [];
    let writerDone = false;

    const writer = (async () => {
      for (let i = 0; i < total; i++) {
        await inbox.writeToInbox(session, {
          id: `msg-${i}`,
          chatId: 1,
          replyToMessageId: 1,
          text: `message ${i}`,
          files: [],
          timestamp: i,
        });
        if (i % 7 === 0) await sleep(0);
      }
      writerDone = true;
    })();

    const reader = (async () => {
      while (!writerDone) {
        const batch = await inbox.readAndClearInbox(session);
        for (const msg of batch) {
          seen.push(Number(msg.id.replace("msg-", "")));
        }
        await sleep(0);
      }

      while (true) {
        const batch = await inbox.readAndClearInbox(session);
        if (batch.length === 0) break;
        for (const msg of batch) {
          seen.push(Number(msg.id.replace("msg-", "")));
        }
      }
    })();

    await Promise.all([writer, reader]);

    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
  }, 15000);

  test("reply channel preserves FIFO ordering without losing records under concurrent drain/write", async () => {
    const total = 2000;
    const session = `reply-${Date.now()}`;
    const seen: number[] = [];
    let writerDone = false;

    const writer = (async () => {
      for (let i = 0; i < total; i++) {
        await replies.writeReply(session, {
          correlationId: `corr-${i}`,
          fromSession: "worker",
          text: `reply ${i}`,
          ok: true,
          timestamp: i,
        });
        if (i % 7 === 0) await sleep(0);
      }
      writerDone = true;
    })();

    const reader = (async () => {
      while (!writerDone) {
        const batch = await replies.readAndClearReplies(session);
        for (const record of batch) {
          seen.push(Number(record.correlationId.replace("corr-", "")));
        }
        await sleep(0);
      }

      while (true) {
        const batch = await replies.readAndClearReplies(session);
        if (batch.length === 0) break;
        for (const record of batch) {
          seen.push(Number(record.correlationId.replace("corr-", "")));
        }
      }
    })();

    await Promise.all([writer, reader]);

    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
  }, 15000);
});
