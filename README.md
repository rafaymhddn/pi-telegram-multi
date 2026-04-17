# pi-telegram-multi

A Telegram bridge extension for [pi](https://github.com/mariozechner/pi-coding-agent) — connects **one Telegram bot** to **many concurrently-running pi sessions** and turns one of them into a leader/orchestrator that can delegate work across the others.

Chat with any session from your phone. Ask the leader to coordinate the rest. Watch it happen live in Telegram.

```
user: @luffy have @zoro review the diff and ask @sanji to write release notes

→ 🤺 @zoro · review the refactor in lib/router.ts
→ 👨‍🍳 @sanji · draft release notes for the orchestration rework

🤺 @zoro
│ Found 2 issues: …

👨‍🍳 @sanji
│ Release notes draft: …

🦸 @luffy
│ Both done. Zoro flagged two issues; sanji has the notes. Want me
│ to open a PR once zoro's fixes are in?
```

---

## What it does

- **Multi-session.** Every pi session you run `/telegram-connect` in registers itself. Messages route by `@mention`.
- **Leader elects automatically.** Exactly one session polls Telegram at a time (the leader). If it dies, a follower takes over within ~15 s.
- **Orchestration.** The leader has a `telegram_delegate` tool — it dispatches subtasks to other sessions, aggregates results, and runs multi-step workflows.
- **Non-blocking.** The leader stays responsive while delegations are in flight. It can answer interjected user questions, fan out more tasks, or chat normally — delegation replies arrive as follow-up turns.
- **Native Telegram threading.** Every dispatch, reply, and status bubble uses Telegram's `reply_to_message_id` so the orchestration tree is visible as native reply chains in the UI.
- **Role-based visual identity.** Each session gets a deterministic human-role emoji (luffy → 🦸, sanji → 👨‍🍳, franky → 👷, …) plus a bold name header and a blockquote body, making it obvious at a glance who's speaking.
- **Attachments both directions.** Send photos / docs / voice / video from Telegram → pi agent sees local paths. The agent can use the `telegram_attach` tool to push files back.
- **File-based coordination.** No server, no database — everything goes through `~/.pi/agent/telegram-multi/` (registry.json, per-session inbox, per-session reply-channel, orchestration log). Pure filesystem IPC.

---

## Installation

The extension is a drop-in folder. pi auto-loads extensions from `~/.pi/agent/extensions/`.

```bash
git clone https://github.com/rafaymhddn/pi-telegram-multi.git \
  ~/.pi/agent/extensions/pi-telegram-multi
```

Restart any running pi session so it picks the extension up. That's it — no build step, no bundler. pi loads the `.ts` files directly via its TypeScript runtime.

Requires a recent pi (>= 0.67) with TypeScript-extension support.

### Set up a Telegram bot

1. Chat with [@BotFather](https://t.me/BotFather) on Telegram and create a new bot. You'll get a token like `123456:ABC-DEF…`.
2. In any pi session, run `/telegram-setup` and paste the token.
3. Send `/start` to your bot on Telegram — this pairs your Telegram user id with the bot (only you will be allowed to control the sessions).

### Connect a session

```
/telegram-connect               # use pi's session name, or auto-derive
/telegram-connect luffy         # explicit name
```

The first connected session becomes the **default** (receives plain, unmentioned messages) and the **leader** (polls Telegram). Additional sessions register as followers and receive messages via their inbox file.

---

## Commands

### In pi

| Command | What it does |
|---|---|
| `/telegram-setup` | Configure the bot token (once per machine; shared across sessions). |
| `/telegram-connect [name]` | Connect this session to the bridge. |
| `/telegram-disconnect` | Disconnect this session. |
| `/telegram-status` | Show bridge state (role, leader, peers). |
| `/telegram-rename <name>` | Rename this session. |

### On Telegram (to the bot)

| What you type | What happens |
|---|---|
| `plain message` | Routed to the **default** session. |
| `@name task` | Routed directly to `@name`. The session replies to you itself (fast path). |
| `@leader plan X and have @foo, @bar handle parts` | Routed to the leader in **orchestrate** mode — it coordinates via `telegram_delegate`. |
| `@a @b task` | Multi-mention → leader orchestrates (decides how to fan out). |
| `/sessions` | List connected sessions. |
| `/status` | Current bridge status. |
| `/stop` | Abort the current turn on the session that's answering you. |

---

## The `telegram_delegate` tool (leader only)

When the leader receives an orchestration request, its pi agent can call:

```ts
telegram_delegate({
  target: "sanji",
  task: "draft release notes for the refactor",
  timeoutSeconds: 600   // optional, default 600
})
```

This is **non-blocking**:

1. Immediately posts a `→ 👨‍🍳 @sanji · …` status bubble to Telegram and writes the task to sanji's inbox.
2. Returns `{ status: "dispatched", correlationId, target }` — the leader's turn can keep going (or end).
3. When sanji finishes, its reply is posted to Telegram *and* mirrored to the leader's reply channel.
4. The leader's reply-channel watcher injects the reply as a new user message (`[delegation-reply from @sanji] (task: "…") …`) into the leader's pi session — triggering a new turn where the agent can synthesise, dispatch more, or respond to the user.

Because dispatch is non-blocking, the leader can:

- **Fan out** many delegations in a single turn.
- **Answer interjections** ("what's the status?") between dispatch and replies.
- **Chain** delegations based on earlier results.

The leader's system prompt always includes a live "Pending delegations" block so the agent never forgets what's still in flight across turns.

---

## Architecture (short version)

```
┌──────────┐       ┌───────────────────┐
│ Telegram │──────▶│  Leader (polls)   │
└──────────┘       └────────┬──────────┘
                            │
             ┌──────────────┼──────────────┐
             │              │              │
             ▼              ▼              ▼
      inbox/zoro.jsonl  inbox/sanji  ...   (file-based queues)
             │              │
             ▼              ▼
       [zoro session]  [sanji session]
             │              │
             └──────┬───────┘
                    ▼
       replies/leader.jsonl     ◀── follower → leader reply channel
                    │
                    ▼
          leader's reply-watcher
                    │
                    ▼
     dispatchToLocalAgent(pseudo-message)
                    │
                    ▼
          leader's pi session sees:
       "[delegation-reply from @zoro] …"
```

- **Registry** (`~/.pi/agent/telegram-multi/registry.json`): every connected session + leader id + leader pid. Liveness via `process.kill(pid, 0)`.
- **Inbox** (`.../inbox/<name>.jsonl`): messages routed *to* a session (from Telegram or from a delegation). Atomic rename-on-drain so concurrent writer + reader never lose records.
- **Replies** (`.../replies/<name>.jsonl`): delegation results, same atomic-drain plumbing.
- **Orchestration log** (`.../orchestration-log.md`): append-only audit trail — DISPATCH / RESULT entries with correlation ids, durations, status. The leader can read it to answer "what did you ask @X yesterday?".

See [`CLAUDE.md`](./CLAUDE.md) for a deeper dive — it's the file Claude Code reads when working in this repo.

---

## Configuration

Bot token and paired user id live in `~/.pi/agent/telegram.json`:

```json
{
  "botToken": "123456:ABC-…",
  "botUsername": "my_orchestrator_bot",
  "botId": 123456,
  "allowedUserId": 42000000,
  "lastUpdateId": 512
}
```

Shared across all sessions on the machine — it's the *bot* that's paired, not the session.

---

## Limits

Telegram Bot API ceilings the extension enforces / handles:

- **4096 chars/message.** Long replies are chunked with HTML-tag-aware splitting; each chunk gets a `1/N` pagination marker in the header.
- **50 MB upload** via `sendDocument` — `telegram_attach` rejects files larger than this pre-flight.
- **20 MB download** via `getFile` — oversize incoming attachments are skipped with a clear user-facing message.
- **1 msg/s per chat, ~30/s global.** HTTP 429s are surfaced as a typed `RateLimitError` and the poll loop / API wrappers honour `retry_after`.

---

## Directory layout

```
pi-telegram-multi/
├── README.md                   you are here
├── CLAUDE.md                   architecture notes for Claude Code
├── index.ts                    pi entry point (tools, hooks, commands)
├── lib/
│   ├── api.ts                  Telegram Bot HTTP wrappers (+ typed errors)
│   ├── inbox.ts                per-session inbox queue
│   ├── replies.ts              per-session reply channel
│   ├── jsonl-queue.ts          atomic-drain rename-based JSONL primitive
│   ├── registry.ts             shared session registry
│   ├── router.ts               @mention parsing (direct vs orchestrate)
│   ├── rendering.ts            HTML rendering, chunker, header + blockquote
│   ├── naming.ts               session name → role emoji mapping
│   └── history.ts              orchestration log helpers
└── tests/
    └── queue-concurrency.test.ts   bun:test regression test for the drain race
```

No bundler. No lockfile. pi loads the `.ts` files directly.

---

## TODO / roadmap

Things worth doing next, roughly in impact order:

- **Improve UI polish further.** The header + blockquote + role-emoji is a big step, but there's more room:
  - Collapsible (`<blockquote expandable>`) for long replies so threads don't dominate the chat.
  - Consolidated dispatch dashboard — one live-edited "🏴‍☠️ Orchestrating N tasks" bubble that updates in place instead of scattering N separate `→` bubbles for large fan-outs.
  - Premium custom-emoji entities so character names render as actual character stickers rather than Unicode approximations.
- **Multiple bot profiles.** Today `~/.pi/agent/telegram.json` holds a single bot token. Extend it to store a named list (e.g. `bots: { work: {token, username, …}, personal: {…}, pirates: {…} }` plus an `activeBot` pointer) and add `/telegram-setup <profile>` / `/telegram-use <profile>` commands to switch. Lets the user keep a work bot, a personal bot, and a throwaway test bot without re-pasting tokens, and makes per-project bot scoping possible.
- **Auto-connect on session start.** A config flag (e.g. `autoConnect: true` in `~/.pi/agent/telegram.json`, or a `PI_TELEGRAM_AUTOCONNECT=1` env var) that fires `/telegram-connect` automatically when pi boots, picking a random name (`basename(cwd) + _NNNN`) if none is set. Zero-friction multi-session setup — every pi you launch joins the bridge without a manual command.
- **Direct messaging between sessions without Telegram.** Same orchestration primitive, but usable *purely* from the pi CLI — talk to your peer sessions without the bot in the loop. The inbox / reply-channel plumbing is already generic; mostly it's a `/pi-chat @name message` command and a small CLI-side poller.
- **Better agent prompting.** The leader's system prompt still needs tuning for when to wait vs when to answer partial, how aggressively to fan out, and how to recover from timeouts without nagging the user. Concrete wins to experiment with: few-shot examples in the prompt, a `telegram_await_all()` helper tool for explicit synchronisation points, and per-pending-delegation "what I'm expecting back" annotations so the agent's plan is explicit.
- **Per-session `(busy)` indicator** in `/sessions` so the user knows which sessions are mid-turn.
- **Structured logs.** Replace silent `catch {}` blocks with `ctx.ui.notify` at debug level so failures are diagnosable without a test suite.
- **Media-group batching.** Telegram album uploads arrive as N separate updates sharing `media_group_id` — batch them into one turn with a short debounce before dispatching to pi.

---

## License

MIT (pending). Use at your own risk — it hits Telegram's API and touches your filesystem; read the code.
