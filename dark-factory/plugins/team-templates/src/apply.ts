// Reads the team agents from the local Paperclip API, groups them by team, and
// rewrites each agent's adapter (model + CLI) to match a team template.
//
// The plugin worker is trusted Node, so it talks to the local Paperclip REST API
// (loopback, local_trusted = no auth) to read + patch agents. This avoids needing
// the managed-agent capability and works on the existing PiTeam agents.

import {
  LLM_ADAPTER,
  TEAMS,
  TEAM_KEYS,
  teamOfAgent,
  type TeamKey,
} from "./teams.js";
import type { ModelSpec, TeamTemplate } from "./templates.js";

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

export const API_BASE = (
  process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3101/api"
).replace(/\/+$/, "");
const DEFAULT_WORKSPACE =
  process.env.TEAM_TEMPLATE_WORKSPACE ||
  "/Users/samuelimini/.openclaw/workspace";

// ---- Pi concurrency throttle (global FIFO cap on real `pi` processes) ----
// Pi agents' `command` is pointed at this wrapper; it gates spawns machine-wide. It is a
// standalone external script (no Paperclip code), so Paperclip can be updated freely.
export const THROTTLE_DIR =
  process.env.PAPERCLIP_PI_THROTTLE_DIR ||
  path.join(os.homedir(), ".paperclip-pi-throttle");
export const THROTTLE_WRAPPER = path.join(THROTTLE_DIR, "bin", "pi-throttle");
export const DEFAULT_MAX_CONCURRENT = 8;

export function writeThrottleConfig(maxConcurrent: number): number {
  const v = Math.max(1, Math.floor(Number(maxConcurrent) || DEFAULT_MAX_CONCURRENT));
  fs.mkdirSync(THROTTLE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(THROTTLE_DIR, "config.json"),
    JSON.stringify({ maxConcurrent: v }),
  );
  return v;
}
export function readThrottleConfig(): number {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(THROTTLE_DIR, "config.json"), "utf8"),
    );
    const v = Math.floor(Number(raw.maxConcurrent));
    return Number.isFinite(v) && v >= 1 ? v : DEFAULT_MAX_CONCURRENT;
  } catch {
    return DEFAULT_MAX_CONCURRENT;
  }
}

export interface Agent {
  id: string;
  name: string;
  status?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok)
    throw new Error(
      `${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`,
    );
  return json;
}

export async function listTeamAgents(companyId: string): Promise<Agent[]> {
  const all = (await api("GET", `/companies/${companyId}/agents`)) as Agent[];
  if (!Array.isArray(all)) return [];
  // Only the agents that belong to a known team (i.e. carry metadata.piRole).
  return all.filter((a) => teamOfAgent(a) !== null);
}

// Build the adapterConfig for a model spec, preserving any existing token/device fields.
export function buildAdapterConfig(
  spec: ModelSpec,
  existing?: Record<string, unknown> | null,
  promptFile?: string | null,
): Record<string, unknown> {
  const llm = LLM_ADAPTER[spec.llm];
  const workspace =
    (existing && (existing.workspace as string)) ||
    (existing && (existing.cwd as string)) ||
    DEFAULT_WORKSPACE;
  const cfg: Record<string, unknown> = {
    command: llm.command,
    model: spec.model,
    workspace,
  };
  // pi_local (the Gemini lane) uses `cwd`, not `workspace`, for the working directory.
  if (llm.adapterType === "pi_local") {
    cfg.cwd = (existing && (existing.cwd as string)) || workspace;
    // Route Pi spawns through the global FIFO concurrency throttle (machine-wide cap on
    // real `pi`). The wrapper exec's the real pi; defaults PAPERCLIP_PI_REAL to the global pi.
    cfg.command = THROTTLE_WRAPPER;
  }
  // Inject the Pi role prompt at exec time. Prompt CONTENT stays in Pi; we only point the CLI adapter at it.
  const instr = promptFile || (existing && (existing.instructionsFilePath as string));
  if (instr) cfg.instructionsFilePath = instr;
  // Claude "ultracode" is a Claude Code SESSION MODE (xhigh effort + dynamic-workflow
  // orchestration), NOT a --effort value. Enable it via the claude CLI's --settings
  // (claude_local forwards `extraArgs` verbatim), and force effort=xhigh alongside.
  if (spec.llm === "claude" && spec.reasoning === "ultracode") {
    cfg.effort = "xhigh";
    cfg.extraArgs = ["--settings", '{"ultracode":true}'];
  } else if (llm.reasoningField && spec.reasoning && spec.reasoning !== "auto") {
    cfg[llm.reasoningField] = spec.reasoning;
  }
  return cfg;
}

export interface TeamState {
  key: TeamKey;
  label: string;
  agentCount: number;
  // The currently-configured model for the team (from the lead, or the first agent).
  current: { adapterType?: string; model?: string; reasoning?: string } | null;
}

function currentModelOf(agent: Agent): {
  adapterType?: string;
  model?: string;
  reasoning?: string;
} {
  const c = agent.adapterConfig || {};
  return {
    adapterType: agent.adapterType,
    model: (c.model as string) || undefined,
    reasoning:
      (c.modelReasoningEffort as string) || (c.effort as string) || undefined,
  };
}

export async function getTeamState(companyId: string): Promise<TeamState[]> {
  const agents = await listTeamAgents(companyId);
  const byTeam = new Map<TeamKey, Agent[]>();
  for (const a of agents) {
    const t = teamOfAgent(a);
    if (!t) continue;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t)!.push(a);
  }
  return TEAM_KEYS.map((key) => {
    const members = byTeam.get(key) || [];
    // Prefer the lead (role ends with -lead) for the "current" readout.
    const lead =
      members.find((m) => String(m.metadata?.piRole || "").endsWith("-lead")) ||
      members[0];
    return {
      key,
      label: TEAMS[key].label,
      agentCount: members.length,
      current: lead ? currentModelOf(lead) : null,
    };
  });
}

export interface ApplyResult {
  templateKey: string;
  patched: number;
  skipped: number;
  // Names of agents that were mid-run when applied. The config change is non-disruptive
  // (it never interrupts an in-flight run); these adopt the new model on their next run.
  running: string[];
  errors: string[];
  perTeam: Array<{
    team: TeamKey;
    llm: string;
    model: string;
    reasoning?: string;
    agents: number;
  }>;
}

export async function applyTemplate(
  companyId: string,
  template: TeamTemplate,
): Promise<ApplyResult> {
  const agents = await listTeamAgents(companyId);
  const result: ApplyResult = {
    templateKey: template.key,
    patched: 0,
    skipped: 0,
    running: [],
    errors: [],
    perTeam: [],
  };

  // Record per-team intent for the summary.
  for (const key of TEAM_KEYS) {
    const spec = template.teams[key];
    if (!spec) continue;
    const count = agents.filter((a) => teamOfAgent(a) === key).length;
    result.perTeam.push({
      team: key,
      llm: spec.llm,
      model: spec.model,
      reasoning: spec.reasoning,
      agents: count,
    });
  }

  for (const agent of agents) {
    const team = teamOfAgent(agent);
    if (!team) {
      result.skipped++;
      continue;
    }
    const role = String(agent.metadata?.piRole || "");
    // A per-worker override wins; otherwise fall back to the team's base spec.
    const spec = (template.workers && template.workers[role]) || template.teams[team];
    if (!spec) {
      result.skipped++;
      continue;
    }
    // Graceful: changing adapterConfig is a non-disruptive DB update — it never
    // interrupts an in-flight run; a mid-run agent adopts the new model on its NEXT
    // run. We still patch it, and report it so the UI can say "switches on next run".
    if (agent.status === "running") result.running.push(agent.name);
    const llm = LLM_ADAPTER[spec.llm];
    const promptFile = (agent.metadata && (agent.metadata.promptFile as string)) || null;
    const adapterConfig = buildAdapterConfig(spec, agent.adapterConfig, promptFile);
    try {
      await api("PATCH", `/agents/${agent.id}`, {
        adapterType: llm.adapterType,
        adapterConfig,
        metadata: {
          ...(agent.metadata || {}),
          teamTemplate: template.key,
          teamTemplateLlm: spec.llm,
          teamTemplateModel: spec.model,
        },
      });
      result.patched++;
    } catch (err) {
      result.errors.push(
        `${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-agent ("individual team member") model reading + setting.
// Lets the UI show every team member and edit each one's model independently.
// ---------------------------------------------------------------------------

export interface Member {
  id: string;
  name: string;
  role: string;
  isLead: boolean;
  llm: "codex" | "claude" | "gemini" | null;
  model: string | null;
  reasoning: string | null;
}

export interface TeamView {
  key: TeamKey;
  label: string;
  lead: Member | null;
  members: Member[];
}

// Map an adapterType back to the LLM it represents.
function llmOfAdapter(
  adapterType?: string,
): "codex" | "claude" | "gemini" | null {
  switch (adapterType) {
    case "codex_local":
      return "codex";
    case "claude_local":
      return "claude";
    case "gemini_local":
      return "gemini";
    default:
      return null;
  }
}

// List every team member, grouped by team, with each member's current model.
export async function listTeamMembers(companyId: string): Promise<TeamView[]> {
  const agents = await listTeamAgents(companyId);
  const byTeam = new Map<TeamKey, Agent[]>();
  for (const a of agents) {
    const t = teamOfAgent(a);
    if (!t) continue;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t)!.push(a);
  }
  const views: TeamView[] = [];
  for (const key of TEAM_KEYS) {
    const group = byTeam.get(key);
    if (!group || group.length === 0) continue;
    const members: Member[] = group.map((a) => {
      const role = String(a.metadata?.piRole || "");
      const cfg = a.adapterConfig || {};
      return {
        id: a.id,
        name: a.name,
        role,
        isLead: role.endsWith("-lead"),
        llm: llmOfAdapter(a.adapterType),
        model: (cfg.model as string) || null,
        reasoning:
          (cfg.modelReasoningEffort as string) ||
          (cfg.effort as string) ||
          null,
      };
    });
    views.push({
      key,
      label: TEAMS[key].label,
      lead: members.find((m) => m.isLead) || null,
      members,
    });
  }
  return views;
}

// Set a single agent's model (LLM + model + reasoning), preserving its
// workspace / instructionsFilePath (role prompt) / metadata.
export async function setAgentModel(
  companyId: string,
  agentId: string,
  llm: "codex" | "claude" | "gemini",
  model: string,
  reasoning?: string,
): Promise<{ ok: boolean; agent: { id: string; adapterType: string; model: string } }> {
  // Fetch the existing agent so we keep its workspace / instructionsFilePath / metadata.
  let existing: Agent | null = null;
  try {
    const got = (await api("GET", `/agents/${agentId}`)) as Agent | null;
    if (got && typeof got === "object" && (got as Agent).id) existing = got as Agent;
  } catch {
    existing = null;
  }
  if (!existing) {
    const agents = await listTeamAgents(companyId);
    existing = agents.find((a) => a.id === agentId) || null;
  }
  if (!existing) throw new Error(`agent "${agentId}" not found`);

  const spec: ModelSpec = { llm, model, reasoning };
  const promptFile =
    (existing.metadata && (existing.metadata.promptFile as string)) || null;
  // buildAdapterConfig preserves workspace + instructionsFilePath and sets the
  // correct reasoning field per llm.
  const adapterConfig = buildAdapterConfig(spec, existing.adapterConfig, promptFile);

  await api("PATCH", `/agents/${agentId}`, {
    adapterType: LLM_ADAPTER[llm].adapterType,
    adapterConfig,
    metadata: { ...(existing.metadata || {}) },
  });

  return {
    ok: true,
    agent: { id: agentId, adapterType: LLM_ADAPTER[llm].adapterType, model },
  };
}
