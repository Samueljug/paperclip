#!/usr/bin/env node
/**
 * install-wiki-maintainer — idempotent installer for the Dark Factory
 * Wiki-Maintainer agent + its drift-check routine, on the live Paperclip
 * control plane.
 *
 * SAFETY: it creates everything **paused/inert** — the agent is `status:paused`
 * and the routine is `status:paused` with **no schedule trigger**, so nothing
 * runs until you activate it. Re-running is safe (matches by name/title, PATCHes
 * in place). Nothing else in the factory is touched.
 *
 *   node install.mjs --dry-run     # print the plan, write nothing (default)
 *   node install.mjs --apply       # create/patch the agent + routine (paused)
 *   node install.mjs --rollback    # archive the agent + routine
 *
 * Activate later (your call, after eyeballing in the dashboard):
 *   - unpause the "DF Wiki Maintainer" agent and the routine,
 *   - add a schedule (e.g. daily) to the routine in the Routines UI,
 *   - or test once now:  curl -s -X POST .../api/routines/<id>/run
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.PAPERCLIP_API_URL?.replace(/\/$/, "") || "http://127.0.0.1:3101";
const COMPANY = "1e8bc12a-f8fd-431c-9fbd-e47be79446a3"; // OPE = the live factory company
const DARK_FACTORY_PROJECT = "c4525f28-55d1-4378-864c-aec26d51fc37";
const WORKSPACE = path.resolve(fileURLToPath(import.meta.url), "../../../.."); // .openclaw/workspace
const INSTRUCTIONS = path.join(WORKSPACE, "tools/dark-factory/wiki-maintainer/instructions.md");

const AGENT_NAME = "DF Wiki Maintainer";
const ROUTINE_TITLE = "Wiki drift check & maintenance";

const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--rollback")
    ? "rollback"
    : "dry-run";

async function api(method, urlPath, body) {
  const res = await fetch(`${API}/api${urlPath}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${(json && (json.error || json.message)) || text.slice(0, 200)}`);
  }
  return json;
}

function agentBody() {
  return {
    name: AGENT_NAME,
    role: "qa",
    title: "Dark Factory Wiki Maintainer",
    icon: "file-code",
    adapterType: "claude_local",
    adapterConfig: {
      command: "claude",
      model: "claude-sonnet-4-6",
      dangerouslySkipPermissions: true,
      timeoutSec: 1800,
      maxTurnsPerRun: 40,
      cwd: WORKSPACE,
      instructionsFilePath: INSTRUCTIONS,
    },
    // Heartbeat ON so the routine-created issue is actually picked up and run.
    // (Agents default to heartbeat.enabled=false = org-chart only; that no-ops routines.)
    runtimeConfig: { heartbeat: { enabled: true, maxConcurrentRuns: 1 } },
    budgetMonthlyCents: 0,
  };
}

function routineBody(agentId) {
  return {
    title: ROUTINE_TITLE,
    description:
      "Runs tools/dark-factory/wiki-drift-check.mjs; auto-fixes mechanical drift (broken links, LaunchAgent status, undocumented tools); files a review task per stale doc. Instructions: tools/dark-factory/wiki-maintainer/instructions.md. Created PAUSED + no trigger — add a schedule and unpause to activate.",
    projectId: DARK_FACTORY_PROJECT,
    assigneeAgentId: agentId,
    status: "paused",
    priority: "low",
    concurrencyPolicy: "skip_if_active",
    catchUpPolicy: "skip_missed",
  };
}

async function main() {
  // sanity: instructions file must exist
  readFileSync(INSTRUCTIONS, "utf8");

  const agents = await api("GET", `/companies/${COMPANY}/agents`);
  const existingAgent = agents.find((a) => a.name === AGENT_NAME);
  const routines = await api("GET", `/companies/${COMPANY}/routines`).catch(() => []);
  const existingRoutine = (Array.isArray(routines) ? routines : routines.routines || []).find((r) => r.title === ROUTINE_TITLE);

  if (mode === "rollback") {
    console.log("ROLLBACK (archive):");
    if (existingRoutine) {
      await api("PATCH", `/routines/${existingRoutine.id}`, { status: "archived" });
      console.log(`  archived routine ${existingRoutine.id}`);
    }
    if (existingAgent) {
      await api("PATCH", `/agents/${existingAgent.id}`, { status: "archived" });
      console.log(`  archived agent ${existingAgent.id}`);
    }
    if (!existingRoutine && !existingAgent) console.log("  nothing to roll back.");
    return;
  }

  const plan = [];
  plan.push(`Agent "${AGENT_NAME}": ${existingAgent ? `PATCH (id=${existingAgent.id})` : "CREATE"} — claude_local, sonnet-4-6, status=paused, cwd=${WORKSPACE}`);
  plan.push(`Routine "${ROUTINE_TITLE}": ${existingRoutine ? `PATCH (id=${existingRoutine.id})` : "CREATE"} — status=paused, NO trigger (inert)`);

  if (mode === "dry-run") {
    console.log("DRY-RUN — would do:\n  " + plan.join("\n  "));
    console.log("\nAgent body:\n" + JSON.stringify(agentBody(), null, 2));
    console.log("\nRe-run with --apply to create (paused). Nothing written.");
    return;
  }

  // apply
  let agentId;
  if (existingAgent) {
    await api("PATCH", `/agents/${existingAgent.id}`, agentBody());
    agentId = existingAgent.id;
    console.log(`~ patched agent ${agentId}`);
  } else {
    const created = await api("POST", `/companies/${COMPANY}/agents`, agentBody());
    agentId = created.id;
    console.log(`+ created agent ${agentId}`);
  }
  // status is not a create field — pause immediately so it stays inert.
  await api("POST", `/agents/${agentId}/pause`, {}).catch((e) => console.log(`  (pause: ${e.message})`));
  console.log(`  paused agent ${agentId}`);

  if (existingRoutine) {
    await api("PATCH", `/routines/${existingRoutine.id}`, routineBody(agentId));
    console.log(`~ patched routine ${existingRoutine.id} (paused, no trigger)`);
  } else {
    const created = await api("POST", `/companies/${COMPANY}/routines`, routineBody(agentId));
    console.log(`+ created routine ${created.id} (paused, no trigger)`);
  }

  console.log("\nInstalled INERT. To activate: unpause the agent + routine and add a schedule trigger in the Routines UI, or test once with POST /api/routines/<id>/run.");
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
