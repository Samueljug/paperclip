# Dark-factory cutover — restore notes

Date of cutover: 2026-06-13
Operator: Claude Code (controlled, reversible cutover)

This cutover STOPPED the old dark-factory runtime and made Paperclip the live
control plane. Everything here is reversible. Backups in this same directory:

- `crontab.before.txt` — full crontab as it was before the cutover
- `tmux-sessions.before.txt` — `tmux ls` before the cutover
- `launchd-foreman.before.txt` — `launchctl list | grep -i foreman` before
- `com.openclaw.dark-factory-foreman.plist` — exact copy of the live Foreman plist

---

## What was stopped (and how to bring each back)

### 1. Foreman launchd watchdog — `com.openclaw.dark-factory-foreman`

- Live plist: `~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`
- Runs: `node .../workspace-development/tools/factory-intake/factory-watchdog.mjs --blocked-max 10 --foreman-max 10`
  every 1800s (StartInterval) and at load (RunAtLoad).
- The plist file was NOT deleted — only booted out of launchd. It still exists on disk.

RESTORE (re-enable the watchdog):

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist
# (older-macOS fallback)  launchctl load ~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist
launchctl list | grep -i foreman      # verify it's back
```

If the plist on disk were ever lost, restore it from the copy in this dir first:

```
cp "$(dirname "$0")/com.openclaw.dark-factory-foreman.plist" ~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist
```

### 2. Improver-monitor cron line

Exact line removed (also in `crontab.before.txt`):

```
*/30 * * * * /bin/zsh -lc 'cd /Users/samuelimini/.openclaw/workspace-telegram4 && /opt/homebrew/Cellar/node/26.0.0/bin/node /Users/samuelimini/.openclaw/workspace-telegram4/bin/dark-factory-improver-monitor.mjs >> /Users/samuelimini/.openclaw/workspace-telegram4/logs/dark-factory-improver-monitor.log 2>&1'
```

RESTORE (re-add the cron line, appending to current crontab):

```
( crontab -l 2>/dev/null; cat <<'CRON'
*/30 * * * * /bin/zsh -lc 'cd /Users/samuelimini/.openclaw/workspace-telegram4 && /opt/homebrew/Cellar/node/26.0.0/bin/node /Users/samuelimini/.openclaw/workspace-telegram4/bin/dark-factory-improver-monitor.mjs >> /Users/samuelimini/.openclaw/workspace-telegram4/logs/dark-factory-improver-monitor.log 2>&1'
CRON
) | crontab -
crontab -l | grep improver-monitor   # verify
```

Or, to restore the WHOLE crontab exactly as it was before:

```
crontab "$(dirname "$0")/crontab.before.txt"
```

### 3. tmux factory sessions — `pi-team-*` (~36) + `pi-coms-net-hub`

These are recreated by the live launcher script (NOT a plist/cron — they are
started on demand by this script):

- Launcher: `/Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code/scripts/openclaw-team.sh`
- It names sessions with prefix `pi-team` and hub `pi-coms-net-hub` (see lines 124-125),
  and has a built-in `stop` subcommand that kills exactly those sessions and leaves
  unrelated Pi/tmux sessions alone.

RESTORE (recreate the full team of tmux sessions):

```
/Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code/scripts/openclaw-team.sh full
/Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code/scripts/openclaw-team.sh status   # verify
```

(Subsets: `core` = orchestrator + leads, `research`, `problem`. Model preset via
`OPENCLAW_PI_MODEL_PRESET=…`, e.g. codex-default — see usage at line 288.)

NOTE: The tmux sessions were killed individually by name via
`tmux kill-session -t <name>` for each `pi-team-*` session and `pi-coms-net-hub`
only (the launcher's `stop` subcommand would also have worked). No `kill-server`
was issued. See the "Collateral note" below for what happened to the unrelated
sessions when the tmux server subsequently exited with zero sessions left.

---

## What replaced it

Paperclip is now the live control plane:

- API: http://127.0.0.1:3101/api (company 1e8bc12a-f8fd-431c-9fbd-e47be79446a3)
- The ~35 team agents (those with `metadata.piRole` set) were PATCHed to
  `status: "active"` with `runtimeConfig.heartbeat.enabled: false` — i.e. live but
  ON-DEMAND, no auto-loop. To revert them to paused:
  `PATCH /api/agents/<id>  {"status":"paused"}`.

OpenClaw's gateway / Telegram / Dr Claw daemon was deliberately LEFT RUNNING and
was not touched by this cutover.

---

## Collateral note (tmux server exit)

The local tmux server held the ~36 factory sessions AND three unrelated session
wrappers (`paperclip-run-3101`, `fable-dev-backend`, `ope249-pr32-current-head-watchdog`).
After the last factory session was killed, the tmux **server** exited (zero
sessions left), which tore down those three wrappers too.

Impact assessment:

- `paperclip-run-3101`: NO impact — Paperclip runs as a standalone detached process
  (`pnpm paperclipai run`, PID was 26299, started 17:16 and STILL RUNNING). The tmux
  session was only a viewer; the service never restarted and is healthy on :3101.
- `fable-dev-backend`: no live process was found tied to it (was an idle/spare shell).
- `ope249-pr32-current-head-watchdog`: its watchdog process (was PID 87319) ran INSIDE
  the session and stopped when the server exited. The script is intact on disk:
  `/Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code/.pi/openclaw-teams/runs/OPE-249-reconcile-20260613T0526Z/bin/ope249-pr32-current-head-watchdog.mjs`

RELAUNCH the ope249 watchdog if still needed (in its own tmux session):

```
tmux new-session -d -s ope249-pr32-current-head-watchdog \
  -c /Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code \
  'node /Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code/.pi/openclaw-teams/runs/OPE-249-reconcile-20260613T0526Z/bin/ope249-pr32-current-head-watchdog.mjs'
```

(Re-creating any tmux session starts a fresh tmux server automatically.)
