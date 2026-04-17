# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`pi-telegram-multi` is an extension for the pi coding agent (`@mariozechner/pi-coding-agent`). It bridges **one Telegram bot** to **many concurrently-running pi sessions** so the user can talk to any session from Telegram.

There is no build step, no test suite, and no linter config. `package.json` is private/minimal. `index.ts` imports `./lib/*.ts` directly — pi loads the extension via its TypeScript runtime. Don't add a bundler unless asked.

## Architecture

### Multi-session coordination (filesystem-based)

All coordination state lives under `~/.pi/agent/telegram-multi/`:
- `registry.json` — every connected session registers here; records `{sessions, leader, leaderPid}`.
- `inbox/<session-name>.jsonl` — append-only queue of messages routed *to* a non-leader session. Messages carry an optional `delegation` field when they originated from the leader's `telegram_delegate` tool rather than from Telegram directly.
- `replies/<session-name>.jsonl` — reply channel for delegations: a session that processed a delegated task writes its result back here so the leader's reply-channel watcher can drain it and inject a follow-up user message into the leader's own pi session.
- `orchestration-log.md` — append-only markdown journal of orchestrator turns and delegations (timestamps, tasks, outcomes, durations). The leader can read its own history to answer "what did you ask X to do?".

Liveness is determined by `process.kill(pid, 0)` checks (`registry.ts:isPidAlive`). Dead sessions are garbage-collected on every `registerSession` / `ensureLeadership` call — there is no separate reaper.

### Leader / follower model

Exactly one session polls Telegram (`getUpdates` long-poll). That session is the **leader**.

- **Leader** (`runPollLoop`): receives all Telegram updates, downloads attachments, runs `routeMessage` to pick a target session.
  - If target is self → dispatch to its own pi agent (`dispatchToLocalAgent`).
  - If target is another session → append to that session's inbox file (`writeToInbox`).
- **Follower**: polls its own inbox every `INBOX_POLL_INTERVAL_MS` (2s) and additionally runs `ensureLeadership` every `LEADER_CHECK_INTERVAL_MS` (15s) to claim leadership if the current leader's PID is dead.

Leader election is first-writer-wins via `registerSession` / `ensureLeadership`. There is no locking — races are tolerated because PID liveness is the source of truth and re-checked on each tick.

### Routing

`router.ts:routeMessage` parses the contiguous leading `@mention` block and returns a `{ targetSession, text, explicit, mode, mentions }` result. Two modes:
- `direct` — a single `@name` pointing at a non-leader session, or no mentions at all. The target session runs the turn and replies to Telegram itself. Fast path, no leader involvement beyond inbox handoff.
- `orchestrate` — either an explicit `@leader` single-mention or any multi-mention (`@a @b task`). The leader executes the turn itself, with the `telegram_delegate` tool and an orchestration-flavored system prompt. It decides how to break the request down and calls `telegram_delegate` once per target.

Unknown `@mentions` still fall through to the default session (the message is **not** stripped in that case). `/sessions`, `/status`, `/stop`, `/start` are handled by the leader directly as bot commands, not routed.

The **default session** is whichever session registered first; re-assigned on disconnect if necessary. It owns plain (unmentioned) messages.

### Turn lifecycle (`index.ts` pi hooks)

1. `session_start` → load config, prep temp dir.
2. `before_agent_start` → append `SYSTEM_PROMPT_SUFFIX` so the agent knows about `[telegram]` prefix and the `telegram_attach` tool.
3. Incoming Telegram message (leader) or inbox drain (follower) → construct `activeTurn`, call `pi.sendUserMessage(promptText)`.
4. `message_update` (leader only) → throttled streaming preview via `editMessageText`.
5. `agent_end` → send signed final reply, flush `queuedAttachments` via `sendDocument`, then drain next queued item (`leaderQueue` or `inboxQueue`).
6. `session_shutdown` → unregister and remove inbox.

Only one turn runs at a time per session. Additional messages while `activeTurn` is set go into `leaderQueue` (leader's own self-routed messages) or `inboxQueue` (follower draining inbox).

### The `telegram_attach` tool

Registered at startup. The agent calls this with local file paths during a turn; paths are pushed onto `activeTurn.queuedAttachments` and sent after the final reply in `agent_end`. Plain-text mention of a path will NOT send the file — the system prompt suffix states this.

### The `telegram_delegate` tool (leader-only, non-blocking)

Registered unconditionally but the handler rejects when the session is not the leader. Semantics are **fire-and-forget**: the tool dispatches work and returns immediately so the leader's turn can end and the leader can keep responding to other Telegram messages while the target is working.

Dispatch path (inside the tool handler):
1. Validate target (leader-only, not self, live session).
2. Generate a `correlationId`, post `→ @target: <task excerpt>` status line.
3. Append a delegation-flavored `InboxMessage` to `inbox/<target>.jsonl` with `{ correlationId, fromSession, replyChannel }`.
4. Register a `PendingDelegation { correlationId, target, task, startedAt, timeoutSec, timeoutHandle, chatId }` in an in-memory `pendingDelegations` Map.
5. Return `{ status: "dispatched", target, correlationId }` to the agent synchronously — no `await`.

Result path (outside the tool, asynchronous):
- The target session's `agent_end` posts its full Telegram reply (with `--<target>` footer) and appends a `ReplyRecord` to `replies/<leader>.jsonl`.
- The leader's reply-channel watcher (`REPLY_POLL_INTERVAL_MS = 1000`) drains records, looks up `correlationId`, and calls `onDelegationResult(...)`.
- `onDelegationResult` posts the closing status line (`✓ / ⚠ / ⏱`), logs a `RESULT` entry, and **injects a synthetic user message** into the leader's own pi session via `dispatchToLocalAgent`. Prefixes:
  - `[delegation-reply from @target] (task: "…")\n\n<result text>`
  - `[delegation-error from @target] (task: "…")\n\n<error>`
  - `[delegation-timeout from @target] (task: "…")\n\nno reply after Xs`

Because injection goes through `dispatchToLocalAgent`, a result arriving while the leader is in another turn queues naturally via `leaderQueue` — FIFO, no special handling.

Timeouts default to 600 s (`DEFAULT_DELEGATE_TIMEOUT_S`) and are overridable per call; they fire the same injection path with status `timeout`. On `stopPolling`, the watcher and all timeout handles are cleared; in-flight delegations on target sessions keep running, and any replies that arrive after leadership changes are dropped (logged, no crash).

### Ambient pending-delegations state

On every leader turn, `before_agent_start` appends a `Pending delegations (N):` block (or `Pending delegations: (none)`) rendered from the live `pendingDelegations` map. The agent treats this as the authoritative source of what's in flight — it never has to "remember" outstanding work across turn boundaries, including turns triggered by user interjections while delegations are pending. Capped at 20 entries (`MAX_PENDING_IN_PROMPT`); overflow shown as "… and N more".

### Orchestration log

`lib/history.ts` appends entries to `~/.pi/agent/telegram-multi/orchestration-log.md` on turn start, each delegation, and turn end. All writes are best-effort (errors swallowed). The leader's system prompt tells the agent where to look.

### Reply formatting

Final replies are built by `rendering.ts:buildReplyChunks(sessionName, markdown)`, which renders markdown→HTML once, chunks it with the HTML-aware `chunkMessage` (preserves tag balance across chunks, never splits inside tags/entities/surrogate pairs), and prepends a **leading header** on every chunk: `{emoji} <b>@session</b>` (plus ` · i/N` on multi-chunk). The worst-case header length is reserved from the 4096-char budget before chunking. Streaming previews use `buildPreview` (same header, single bubble edited in place). The per-session emoji is a deterministic hash of the session name into a 16-emoji neutral palette (`naming.ts:sessionEmoji`) so the same session always gets the same glyph — zero config, works for any domain.

### Threaded messages

Messages use Telegram's `reply_to_message_id` to surface the orchestration tree in the UI:
- The leader's final reply threads under the user's original message.
- Each `telegram_delegate` dispatch bubble (`→ 🦊 @target · …`) threads under the user's message too; its `message_id` is captured on `PendingDelegation.dispatchMessageId`.
- The target's full reply and the closing `✓/⚠/⏱` status bubble thread under the dispatch bubble.
- Subsequent leader turns triggered by injected `[delegation-reply …]` messages thread under the user's original message via `PendingDelegation.rootReplyToMessageId`.
All via a single `replyToMessageId?` positional on `lib/api.ts:sendMessage/sendDocument` with `allow_sending_without_reply: true` for deleted-parent tolerance.

## Config

Bot token + paired user id live in `~/.pi/agent/telegram.json` (shared across sessions — it's the bot, not the session, that's paired). First `/start` message to the bot captures `allowedUserId`; every subsequent message is rejected if `from.id` doesn't match.

## Commands exposed to pi users

`/telegram-setup`, `/telegram-connect [name]`, `/telegram-disconnect`, `/telegram-status`, `/telegram-rename <name>`. Session name defaults to pi's `sessionManager.getSessionName()`, falling back to `basename(cwd) + random 4-digit suffix` (see `naming.ts`).
