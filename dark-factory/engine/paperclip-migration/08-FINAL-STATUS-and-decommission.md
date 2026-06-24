# 08 — Final status + decommission criteria (2026-06-13)

## True state right now

The factory **runs 100% on the OLD setup** (OpenClaw + pi-team tmux + coms-net + launchd/cron).
It was NOT removed and must not be, because the new (Paperclip-driven) execution path is BLOCKED.

| Piece                                              | Mapped to Paperclip? | Notes                                                                                                                                         |
| -------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Team org chart                                     | ✅ done              | 35 PiTeam agents registered, heartbeat OFF (visibility only), under existing pi-orchestrator                                                  |
| Goals                                              | ✅ done              | 1 company root + 4 team goals (gates-first-time, zero quota blockers, 100% improver coverage, no infra outages)                               |
| Dashboard                                          | ✅ available         | GET /api/companies/:id/dashboard (agents/tasks/costs/approvals/budgets/activity)                                                              |
| DB backups                                         | ✅ on                | hourly + pre-delete, already running                                                                                                          |
| **Agent execution** (Paperclip drives the pi-team) | ❌ BLOCKED           | openclaw-gateway adapter = protocol 3; live OpenClaw 2026.6.5 gateway = protocol 4. No overlap. Even latest upstream Paperclip is protocol 3. |
| Cost events / budgets                              | ⏸ not started        | needs Foreman to POST cost events (Foreman code change) + observe-first before any cap                                                        |
| Routines (cron → Paperclip)                        | ⏸ not started        | dual-run risk (two loops fighting); do as shadow-then-disable                                                                                 |
| Secrets vault / approvals / sandbox                | ⏸ not started        | only useful once execution runs through Paperclip                                                                                             |

## Backup of the old setup

`~/.openclaw/backups/old-factory-setup-2026-06-13T06-00-29/` (chmod 700) —
launchd plists, crontab, openclaw-team.sh, openclaw.json (has gateway token, chmod 600),
live-state manifest, and `RESTORE.md`. All plists lint-clean, config valid.

## Decommission criteria — DO NOT remove the old setup until ALL of these are true

1. The protocol blocker is resolved (upstream Paperclip ships a protocol-4 openclaw-gateway
   adapter, OR a pi-local execution path is adopted and proven).
2. Paperclip drives execution for **every** lane (one proven canary, then lane-by-lane), with
   the tmux lane kept as hot standby per lane during its bake window.
3. A full run completes end-to-end **through Paperclip** (wake → work → gates → PR → status)
   with parity vs the old route.
4. The schedulers (improver-monitor cron, foreman launchd) run as Paperclip routines in
   dual-run parity for a bake window BEFORE the originals are disabled.
5. A fresh backup is taken immediately before removal.

## Decommission sequence (only after criteria above)

1. `launchctl bootout` / unload the launchd jobs (keep the .plist backups).
2. Remove the crontab line (keep `crontab.txt`).
3. Stop the tmux team (`openclaw-team.sh stop`) once Paperclip owns all lanes.
4. Retire `openclaw-team.sh` as the launch path.
   Each step is reversible from the backup within ~2 minutes.

## Bottom line

"OpenClaw should work exactly like it should" — it DOES, right now, via the old setup.
The path to a clean single-system end state is real but gated behind the protocol fix.
Removing the old setup today would stop the factory; it stays until the new path is proven.
