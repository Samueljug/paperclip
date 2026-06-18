#!/usr/bin/env bash
# Create the 4 dark-factory routines in Paperclip, PAUSED. Additive + reversible.
# Dry-run by default; --apply to create. Writes id mapping to routines-map.json.
#
# See 04-routines-migration.md for the full migration plan, parallel-run plan,
# and the GATED cut-over steps (disabling crontab/launchd).
set -euo pipefail

API="${PAPERCLIP_API_BASE:-http://127.0.0.1:3101/api}"
COMPANY="${PAPERCLIP_COMPANY_ID:-1e8bc12a-f8fd-431c-9fbd-e47be79446a3}"
PROJECT="${PAPERCLIP_PROJECT_ID:-c4525f28-55d1-4378-864c-aec26d51fc37}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAP="$HERE/routines-map.json"
APPLY="${1:-}"
AUTH=()
[ -n "${PAPERCLIP_TOKEN:-}" ] && AUTH=(-H "authorization: Bearer ${PAPERCLIP_TOKEN}")

# Agent ids (override via env if the agents workstream registers dedicated agents)
A_COORD="${A_COORD:-ec2f4237-5d27-4675-a919-d4cbc45c55ca}"        # OpenClaw Coordinator (pm)
A_REPORTER="${A_REPORTER:-9b8240f0-f0e8-4175-bd06-7534b8f43185}"  # Self-Improvement Reporter (researcher)
A_ORCH="${A_ORCH:-be605938-5fa4-44ee-bea5-dcd5e624a871}"          # pi-orchestrator (devops)

api() { # METHOD PATH [JSON]
  local m="$1" p="$2" body="${3:-}"
  if [ "$APPLY" != "--apply" ]; then
    echo "DRYRUN $m $API$p ${body:+--data $body}" >&2
    echo '{"id":"00000000-0000-0000-0000-000000000000","trigger":{"id":"00000000-0000-0000-0000-000000000000"}}'
    return 0
  fi
  if [ -n "$body" ]; then
    curl -fsS -X "$m" "$API$p" -H 'content-type: application/json' "${AUTH[@]}" --data "$body"
  else
    curl -fsS -X "$m" "$API$p" "${AUTH[@]}"
  fi
}

create_routine() { # title desc assignee priority concurrency
  local title="$1" desc="$2" assignee="$3" prio="$4" conc="$5"
  api POST "/companies/$COMPANY/routines" "$(cat <<JSON
{"projectId":"$PROJECT","title":"$title","description":"$desc","assigneeAgentId":"$assignee",
 "priority":"$prio","status":"paused","concurrencyPolicy":"$conc","catchUpPolicy":"skip_missed"}
JSON
)" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])"
}

add_trigger() { # routineId cron
  api POST "/routines/$1/triggers" "$(cat <<JSON
{"kind":"schedule","label":"every-30-min","cronExpression":"$2","timezone":"Australia/Sydney","enabled":true}
JSON
)" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('trigger') or d).get('id'))"
}

echo "Creating routines (PAUSED). APPLY=${APPLY:-dry-run}" >&2

R_MON=$(create_routine "Dark Factory — improver monitor (infra health)" \
  "Every 30 min: disk/log/tmux health. Migrated from crontab. Folder-scoped." \
  "$A_COORD" high skip_if_active)
T_MON=$(add_trigger "$R_MON" "*/30 * * * *")

R_PAT=$(create_routine "Dark Factory — cross-run pattern miner" \
  "Every 30 min: improver-pattern-miner.mjs --file-tickets. Files repeated_pattern tickets." \
  "$A_REPORTER" medium skip_if_active)
T_PAT=$(add_trigger "$R_PAT" "5,35 * * * *")

R_SWP=$(create_routine "Dark Factory — improvement-backlog sweeper" \
  "Every 30 min: improvement-backlog-claude-reviewer.mjs --apply --max-candidates 5." \
  "$A_REPORTER" medium coalesce_if_active)
T_SWP=$(add_trigger "$R_SWP" "10,40 * * * *")

R_FOR=$(create_routine "Dark Factory — foreman (factory-watchdog)" \
  "Every 30 min: factory-watchdog.mjs --blocked-max 10 --foreman-max 10. From launchd." \
  "$A_ORCH" high coalesce_if_active)
T_FOR=$(add_trigger "$R_FOR" "15,45 * * * *")

cat > "$MAP" <<JSON
{
  "createdAt": "$(date -u +%FT%TZ)",
  "apply": "${APPLY:-dry-run}",
  "routines": {
    "improver-monitor":  { "routineId": "$R_MON", "triggerId": "$T_MON", "external": "crontab:dark-factory-improver-monitor" },
    "pattern-miner":     { "routineId": "$R_PAT", "triggerId": "$T_PAT", "external": "crontab:improver-monitor(inner)" },
    "backlog-sweeper":   { "routineId": "$R_SWP", "triggerId": "$T_SWP", "external": "crontab:improver-monitor(inner)" },
    "foreman":           { "routineId": "$R_FOR", "triggerId": "$T_FOR", "external": "launchd:com.openclaw.dark-factory-foreman" }
  }
}
JSON
echo "Wrote $MAP" >&2
cat "$MAP"
