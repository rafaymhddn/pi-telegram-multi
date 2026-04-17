# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`pi-telegram-multi` is an extension for the pi coding agent (`@mariozechner/pi-coding-agent`). It bridges **one Telegram bot** to **many concurrently-running pi sessions** so the user can talk to any session from Telegram.

There is no build step, no test suite, and no linter config. `package.json` is private/minimal. `index.ts` imports `./lib/*.ts` directly — pi loads the extension via its TypeScript runtime. Don't add a bundler unless asked.

## Architecture

### Multi-session coordination (filesystem-based)

All coordination state lives under `~/.pi/agent/telegram-multi/`:
- `registry.json` — every connected session registers here; records `{sessions, leader, leaderPid}`.
- `inbox/<session-name>.jsonl` — append-only queue of messages routed *to* a non-leader session.

Liveness is determined by `process.kill(pid, 0)` checks (`registry.ts:isPidAlive`). Dead sessions are garbage-collected on every `registerSession` / `ensureLeadership` call — there is no separate reaper.

### Leader / follower model

Exactly one session polls Telegram (`getUpdates` long-poll). That session is the **leader**.

- **Leader** (`runPollLoop`): receives all Telegram updates, downloads attachments, runs `routeMessage` to pick a target session.
  - If target is self → dispatch to its own pi agent (`dispatchToLocalAgent`).
  - If target is another session → append to that session's inbox file (`writeToInbox`).
- **Follower**: polls its own inbox every `INBOX_POLL_INTERVAL_MS` (2s) and additionally runs `ensureLeadership` every `LEADER_CHECK_INTERVAL_MS` (15s) to claim leadership if the current leader's PID is dead.

Leader election is first-writer-wins via `registerSession` / `ensureLeadership`. There is no locking — races are tolerated because PID liveness is the source of truth and re-checked on each tick.

### Routing

`router.ts:routeMessage` parses a leading `@name` mention against the live `knownSessions` list. Unknown `@mentions` fall through to the default session (the message is **not** stripped in that case). `/sessions`, `/status`, `/stop`, `/start` are handled by the leader directly as bot commands, not routed.

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

### Reply formatting

All final replies are wrapped by `signReply` → `"<b>[session-name]</b>\n" + markdown→HTML`. `rendering.ts:renderMarkdownToHtml` is a hand-rolled minimal converter (bold/italic/code/links/headers only). Messages over 4096 chars are split by `chunkMessage` preferring paragraph, then newline, then hard-cut boundaries.

## Config

Bot token + paired user id live in `~/.pi/agent/telegram.json` (shared across sessions — it's the bot, not the session, that's paired). First `/start` message to the bot captures `allowedUserId`; every subsequent message is rejected if `from.id` doesn't match.

## Commands exposed to pi users

`/telegram-setup`, `/telegram-connect [name]`, `/telegram-disconnect`, `/telegram-status`, `/telegram-rename <name>`. Session name defaults to pi's `sessionManager.getSessionName()`, falling back to `basename(cwd) + random 4-digit suffix` (see `naming.ts`).
