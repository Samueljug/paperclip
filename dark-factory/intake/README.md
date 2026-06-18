# Factory Intake

This is the Development OpenClaw Telegram-to-Dark-Factory intake and Todo
handoff shim.

Use `factory-intake.mjs` when Samuel drops one or more tasks into the
Development Telegram chat. It creates Paperclip issues in the Dark Factory
Visibility Pilot project and marks them with `source: telegram-dev-intake`.
The helper is the only board writer for Telegram intake.

```sh
node tools/factory-intake/factory-intake.mjs --raw "TASK: Fix the login page bug" --chat-id "telegram:508625244" --message-id "123"
```

For media-heavy tasks, process any downloaded local media first, then pass the
manifest into intake:

```sh
node tools/factory-intake/process-media.mjs --input ~/.openclaw/media/inbound/repro.mp4 --out-dir tools/factory-intake/state/media-artifacts
node tools/factory-intake/factory-intake.mjs --raw "TASK: Fix the bug shown in the video" --media-manifest @tools/factory-intake/state/media-artifacts/media-manifest-123.json
```

The resulting Paperclip issue gets a **Media Evidence** section plus local
attachments for originals, transcripts, and extracted frames. If a video is
important, do not rely on the video alone: the ticket should include a transcript
and key screenshots/frames before orchestration.

Use `factory-foreman.mjs` from the scheduled foreman loop. It claims unclaimed
Todo-ready Paperclip issues in the Dark Factory Visibility Pilot project and
sends them through coms-net. Telegram-intake issues are one source of Todo
cards, but manually dragging any issue into Todo is also a ready-for-factory
signal.

The foreman applies receiver backpressure before claiming Todo cards. It routes
to `pi-orchestrator` when that lane has capacity, and can bypass the saturated
orchestrator for lane-obvious work by handing directly to online lead lanes such
as `self-improvement-lead`, `security-lead`, `browser-qa-lead`,
`implementation-lead`, `verification-lead`, and `planning-lead`. If no online
handoff lane has room under `targetInboxSoftLimit`/
`FACTORY_INTAKE_TARGET_INBOX_SOFT_LIMIT` (default `80`), it exits with
`backpressure: true` and claims nothing. If coms-net still returns `inbox_full`
during a race, the card is released back to Todo and the event is recorded as
transient backpressure, not as a failed work attempt or a reason to move the
product ticket to Blocked.

For Dark Factory work after handoff, teams should use the local Paperclip
Option B evidence protocol in
`/Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code/.pi/openclaw-teams/paperclip-option-b-evidence-protocol.md`
for visible role comments and ticket attachments. Option B attribution is
advisory/display-only, not non-forgeable Paperclip identity; do not spoof
`authorAgentId` or mutate the DB directly. If a decision, approval, option,
write-scope change, identity/security tradeoff, PR/push choice, or owner action
is needed, the foreman/orchestrator must return to Samuel visibly in Telegram
and leave a Paperclip comment. Do not leave the required decision only in a
ledger, run folder, or hidden ticket state.

```sh
node tools/factory-intake/factory-foreman.mjs --max 5
```

Use `factory-blocked-sweep.mjs` from the recurring blocked-card watcher. It
does not treat Blocked as terminal. It scans blocked Paperclip issues, routes a
bounded unblock prompt to the appropriate online lane, and reactivates
process-review/productivity-review cards to `in_progress` after posting the
visible owner/action. True blockers remain blocked unless a lane records that
the blocker was process-only and moves the work forward.

```sh
node tools/factory-intake/factory-blocked-sweep.mjs --max 20
```

Config lives in `config.local.json`, which is gitignored. `config.example.json`
documents the required keys.

## ClickUp Sync

Use `clickup-sync.mjs` to mirror selected ClickUp tasks into Paperclip Todo,
then move the source ClickUp task to Review after the Paperclip issue reaches
review/done.

The ClickUp token is read from `CLICKUP_API_TOKEN`/`CLICKUP_TOKEN`/`CLICKUP_KEY`,
`CLICKUP_OAUTH_TOKEN`/`CLICKUP_ACCESS_TOKEN`, or from macOS Keychain service
`openclaw-clickup-api-token` account `bugfixer`. Do not store the token in
`clickup.local.json`.

```sh
node tools/factory-intake/clickup-sync.mjs --setup-token
node tools/factory-intake/clickup-sync.mjs --setup-oauth
node tools/factory-intake/clickup-sync.mjs --discover
node tools/factory-intake/clickup-sync.mjs --import --dry-run
node tools/factory-intake/clickup-sync.mjs --import
node tools/factory-intake/clickup-sync.mjs --backsync-only
```

Imports are intentionally opt-in: a bare `node tools/factory-intake/clickup-sync.mjs`
prints an error instead of creating Paperclip cards.

For OAuth setup, register this redirect URI in the ClickUp OAuth app unless
`CLICKUP_OAUTH_REDIRECT_URI` overrides it:

```text
http://127.0.0.1:17895
```

Config lives in `clickup.local.json`, with `clickup.config.example.json` as the
template. Each source needs a ClickUp `listId`, import statuses, and the ClickUp
status name to use for review.

Extra Telegram front doors need extra Telegram bot/account tokens. This shim
uses the existing Development bot and board until Samuel provisions those.
