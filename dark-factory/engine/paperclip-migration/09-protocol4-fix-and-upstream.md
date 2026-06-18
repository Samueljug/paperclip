# 09 — Protocol-4 bridge fix (and why NOT to pull upstream)

## The fix (LOCAL, in the running clone)
Two edits to `packages/adapters/openclaw-gateway/src/server/execute.ts` make the
adapter work with the live OpenClaw 2026.6.5 gateway (protocol 4):
1. line 89:  `PROTOCOL_VERSION = 3` -> `4`
2. line ~1142: `agentParams.paperclip = paperclipPayload;` -> omitted (`void paperclipPayload;`)
   (v4 gateway removed Paperclip integration + uses a strict schema; the root
   `paperclip` prop is rejected.)

Saved as `openclaw-gateway-protocol4.patch` — re-apply with:
    cd ~/.openclaw/workspace/tools/paperclip
    git apply ~/.openclaw/workspace/tools/dark-factory/paperclip-migration/openclaw-gateway-protocol4.patch
Then restart the server (kill the PID on :3101 + pnpm wrappers, then
`tmux new-session -d -s paperclip-run-3101 -c <paperclip> "pnpm paperclipai run --data-dir <data> --bind loopback"`).

## Do NOT pull upstream to fix this
Checked 2026-06-13: upstream master (412a04c9) is 203 commits ahead of the local
clone (2a9d0439) but STILL has `PROTOCOL_VERSION = 3` and STILL sends
`agentParams.paperclip`. So upstream has NOT fixed the protocol-4 break — pulling
gains nothing for the bridge. The local clone is also detached-HEAD with the team's
UNCOMMITTED customizations (UI, services), so a full pull risks conflicts, DB
migrations, and live-server breakage. Keep the local patch.

## Optional: upstream it
The clean long-term fix is a PR to paperclipai/paperclip making the adapter
negotiate protocol 4 (and deliver Paperclip context the v4 way instead of the
removed `paperclip` param). Until then, this patch is the source of truth.
