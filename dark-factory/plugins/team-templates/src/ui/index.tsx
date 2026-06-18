import React, { useMemo, useState } from "react";
import {
  usePluginData,
  usePluginAction,
  useHostNavigation,
  type PluginPageProps,
  type PluginWidgetProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Types (mirror ../templates.ts and ../teams.ts; the UI bundle is standalone
// so we restate the shapes locally rather than import across the worker/ui split)
// ---------------------------------------------------------------------------
type Llm = "codex" | "claude" | "gemini";
interface ModelSpec {
  llm: Llm;
  model: string;
  reasoning?: string;
}
interface TeamTemplate {
  key: string;
  label: string;
  description?: string;
  builtin?: boolean;
  teams: Record<string, ModelSpec>;
  workers?: Record<string, ModelSpec>;
}

// "state" data source (registered in ../worker.ts)
interface TeamState {
  key: string;
  label: string;
  agentCount: number;
  current: { adapterType?: string; model?: string; reasoning?: string } | null;
}
interface StateData {
  teams: TeamState[];
  templates: TeamTemplate[];
  activeTemplate: string | null;
  throttle?: number;
}

// ---------------------------------------------------------------------------
// Option lists (exact ids per the model/CLI contract)
// ---------------------------------------------------------------------------
const MODELS: Record<Llm, string[]> = {
  codex: ["gpt-5.4", "gpt-5.5", "gpt-5.3-codex-spark"],
  claude: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  gemini: ["google-antigravity/gemini-3.5-flash", "google-antigravity/gemini-3.1-pro-high", "google-gemini-cli/gemini-3.5-flash", "google-gemini-cli/gemini-2.5-pro", "google-gemini-cli/gemini-2.5-flash"],
};
const REASONING: Record<Llm, string[]> = {
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  gemini: ["off", "minimal", "low", "medium", "high", "xhigh"],
};
const LLMS: Llm[] = ["codex", "claude", "gemini"];

const TEAM_LABELS: Record<string, string> = {
  // Ordered to match how a task flows through the dark factory (stage-gate relay).
  research: "Research",
  planning: "Planning",
  problemSolving: "Problem Solving",
  implementation: "Implementation",
  verification: "Verification",
  browserQa: "Browser QA",
  review: "Review / Security",
  selfImprovement: "Self-Improvement",
  docsRelease: "Docs & Release",
};
const TEAM_ORDER = Object.keys(TEAM_LABELS);

// The agent roles that make up each team (mirrors ../teams.ts). Used to list
// every worker a template configures, not just the team's summary line.
const TEAM_ROLES: Record<string, string[]> = {
  implementation: [
    "implementation-lead",
    "backend-implementer",
    "frontend-implementer",
  ],
  review: [
    "security-lead",
    "security-reviewer",
    "dependency-auditor",
    "tenant-isolation-reviewer",
    "data-sovereignty-reviewer",
    "authz-reviewer",
    "data-exposure-reviewer",
    "injection-reviewer",
  ],
  verification: ["verification-lead", "test-engineer"],
  browserQa: ["browser-qa-lead", "browser-tester", "visual-qa"],
  planning: ["planning-lead", "product-planner", "architecture-planner"],
  research: [
    "research-lead",
    "research-source-cartographer",
    "research-customer-revenue",
    "research-technical-prober",
    "research-risk-compliance",
    "research-skeptic-red-team",
    "research-synthesis-editor",
  ],
  problemSolving: [
    "problem-solving-lead",
    "problem-root-cause-solver",
    "problem-implementation-solver",
    "problem-test-repro-solver",
    "problem-risk-skeptic",
    "problem-synthesis-judge",
  ],
  docsRelease: ["docs-release-lead"],
  selfImprovement: ["self-improvement-lead", "memory-librarian"],
};

// ---------------------------------------------------------------------------
// Shared visual language (ONE card style + ONE chip style, reused everywhere)
// ---------------------------------------------------------------------------
function llmColor(llm?: string | null): string {
  return llm === "codex"
    ? "#10a37f" // green
    : llm === "claude"
      ? "#d97757" // orange
      : llm === "gemini"
        ? "#4285f4" // blue
        : "#888";
}

const pad: React.CSSProperties = { padding: "1rem" };
const card: React.CSSProperties = {
  border: "1px solid rgba(128,128,128,0.25)",
  borderRadius: 10,
  padding: "0.9rem 1rem",
  background: "rgba(128,128,128,0.04)",
};
const btn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 7,
  border: "1px solid rgba(128,128,128,0.35)",
  background: "transparent",
  cursor: "pointer",
  fontSize: 13,
};
const btnDisabled: React.CSSProperties = {
  opacity: 0.4,
  cursor: "not-allowed",
};
const tag: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.6,
  border: "1px solid rgba(128,128,128,0.3)",
  borderRadius: 5,
  padding: "0px 6px",
};
const sel: React.CSSProperties = {
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid rgba(128,128,128,0.35)",
  background: "#ffffff",
  fontSize: 12,
  color: "#1a1a1a",
};

// Display label for a model in a chip — drop the redundant provider prefix, since the
// coloured badge already shows the provider (orange claude / green codex / blue gemini).
function modelLabel(llm?: string | null, model?: string | null): string {
  if (!model) return "\u2014";
  // gemini ids are provider-qualified (e.g. "google-antigravity/gemini-3.5-flash").
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  if (llm === "claude") return bare.replace(/^claude-/, "");
  if (llm === "gemini") return bare.replace(/^gemini-/, "Gemini ").replace(/-/g, " ");
  return bare;
}

// The ONE llm chip, shared by template cards AND the teams section.
// Renders:  [<llm>] <model> · <reasoning>   (omit "· reasoning" when none)
function LlmChip({
  llm,
  model,
  reasoning,
}: {
  llm?: string | null;
  model?: string | null;
  reasoning?: string | null;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        border: "1px solid rgba(128,128,128,0.25)",
        borderRadius: 7,
        padding: "2px 7px",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          background: llmColor(llm),
          color: "#fff",
          borderRadius: 5,
          padding: "1px 6px",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {llm ?? "—"}
      </span>
      <span style={{ opacity: 0.9 }}>{modelLabel(llm, model)}</span>
      {reasoning ? <span style={{ opacity: 0.55 }}>· {reasoning}</span> : null}
    </span>
  );
}

function defaultSpec(llm: Llm): ModelSpec {
  return { llm, model: MODELS[llm][0], reasoning: REASONING[llm][0] };
}

// Reusable llm/model/reasoning select group. Used by both the inline editor and
// the custom-template builder. Calls onChange with a fully-consistent spec.
function ModelSelects({
  spec,
  onChange,
  idPrefix,
}: {
  spec: ModelSpec;
  onChange: (next: ModelSpec) => void;
  idPrefix?: string;
}) {
  return (
    <>
      <select
        aria-label={`${idPrefix ?? ""} llm`}
        style={sel}
        value={spec.llm}
        onChange={(e) => onChange(defaultSpec(e.target.value as Llm))}
      >
        {LLMS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <select
        aria-label={`${idPrefix ?? ""} model`}
        style={sel}
        value={spec.model}
        onChange={(e) => onChange({ ...spec, model: e.target.value })}
      >
        {MODELS[spec.llm].map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      {REASONING[spec.llm].length > 0 && (
        <select
          aria-label={`${idPrefix ?? ""} reasoning`}
          style={sel}
          value={spec.reasoning ?? REASONING[spec.llm][0]}
          onChange={(e) => onChange({ ...spec, reasoning: e.target.value })}
        >
          {REASONING[spec.llm].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Editor modal state — used by Duplicate / Edit / "new template"
// ---------------------------------------------------------------------------
interface EditorState {
  open: boolean;
  // The original key being edited in place (custom Edit). null => save as new key.
  editingKey: string | null;
  key: string;
  label: string;
  description: string;
  teams: Record<string, ModelSpec>;
  // Which teams the template actually sets. undefined => all teams (a fresh template).
  enabled?: Set<string>;
}

function blankEditor(): EditorState {
  return {
    open: false,
    editingKey: null,
    key: "",
    label: "",
    description: "",
    teams: Object.fromEntries(TEAM_ORDER.map((t) => [t, defaultSpec("codex")])),
  };
}

function editorFromTemplate(
  t: TeamTemplate,
  opts: { duplicate: boolean },
): EditorState {
  const teams: Record<string, ModelSpec> = Object.fromEntries(
    TEAM_ORDER.map((tk) => [
      tk,
      t.teams[tk] ? { ...t.teams[tk] } : defaultSpec("codex"),
    ]),
  );
  // track which teams the template actually sets (preserve "omitted => unchanged")
  const enabled = new Set(TEAM_ORDER.filter((tk) => !!t.teams[tk]));
  // We store all teams in the editor but only emit the enabled ones on save.
  return {
    open: true,
    editingKey: opts.duplicate ? null : t.key,
    key: opts.duplicate ? `${t.key}-copy` : t.key,
    label: opts.duplicate ? `${t.label} (copy)` : t.label,
    description: t.description ?? "",
    teams,
    enabled,
  };
}

// ===========================================================================
// Inline (in-page) template editor — per-team base + per-worker overrides.
// Rendered directly inside a card (no popup) when that card is being edited.
// ===========================================================================
function InlineTemplateEditor({
  template,
  busy,
  onSave,
  onCancel,
}: {
  template: TeamTemplate;
  busy: boolean;
  onSave: (draft: {
    label: string;
    description: string;
    teams: Record<string, ModelSpec>;
    workers: Record<string, ModelSpec>;
  }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(template.label);
  const [description, setDescription] = useState(template.description ?? "");
  const [teams, setTeams] = useState<Record<string, ModelSpec>>(() =>
    Object.fromEntries(
      TEAM_ORDER.filter((tk) => template.teams[tk]).map((tk) => [
        tk,
        { ...template.teams[tk] },
      ]),
    ),
  );
  const [workers, setWorkers] = useState<Record<string, ModelSpec>>(() => ({
    ...(template.workers ?? {}),
  }));

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      <input
        value={label}
        placeholder="label"
        onChange={(e) => setLabel(e.target.value)}
        style={{ ...sel, padding: "5px 8px" }}
      />
      <input
        value={description}
        placeholder="description (optional)"
        onChange={(e) => setDescription(e.target.value)}
        style={{ ...sel, padding: "5px 8px" }}
      />
      {TEAM_ORDER.filter((tk) => teams[tk]).map((tk) => {
        const roles = TEAM_ROLES[tk] ?? [];
        return (
          <div
            key={tk}
            style={{
              display: "grid",
              gap: 5,
              borderTop: "1px solid rgba(128,128,128,0.15)",
              paddingTop: 6,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 600 }}>{TEAM_LABELS[tk]}</span>
              <span style={{ opacity: 0.45, fontSize: 11 }}>whole team</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <ModelSelects
                  spec={teams[tk]}
                  idPrefix={`${tk}-team`}
                  onChange={(next) => {
                    setTeams((p) => ({ ...p, [tk]: next }));
                    // Setting the whole team clears its per-worker overrides.
                    setWorkers((p) => {
                      const nx = { ...p };
                      for (const role of roles) delete nx[role];
                      return nx;
                    });
                  }}
                />
              </span>
            </div>
            {roles.map((role) => {
              const wspec = workers[role] ?? teams[tk];
              return (
                <div
                  key={role}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    paddingLeft: 16,
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      opacity: 0.85,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {role}
                    {role.endsWith("-lead") && <span style={tag}>lead</span>}
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <ModelSelects
                      spec={wspec}
                      idPrefix={role}
                      onChange={(next) =>
                        setWorkers((p) => ({ ...p, [role]: next }))
                      }
                    />
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button style={btn} onClick={onCancel}>
          Cancel
        </button>
        <button
          style={{
            ...btn,
            background: "rgba(80,200,120,0.18)",
            ...(busy ? btnDisabled : {}),
          }}
          disabled={busy}
          onClick={() => onSave({ label, description, teams, workers })}
        >
          {busy ? "Saving\u2026" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Page
// ===========================================================================
export function TeamTemplatesPage({ context }: PluginPageProps) {
  const companyId = context?.companyId ?? null;
  const params = useMemo(
    () => (companyId ? { companyId } : undefined),
    [companyId],
  );

  const {
    data: stateData,
    loading,
    error,
    refresh,
  } = usePluginData<StateData>("state", params);

  const apply = usePluginAction("apply");
  const saveTemplate = usePluginAction("save-template");
  const del = usePluginAction("delete-template");
  const setThrottle = usePluginAction("set-throttle");

  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [capInput, setCapInput] = useState<string>("");

  // Editor modal
  const [editor, setEditor] = useState<EditorState>(blankEditor);
  // Per-card collapsible teams — collapsed by default; key is `${templateKey}:${teamKey}`.
  const [cardExpanded, setCardExpanded] = useState<Set<string>>(() => new Set());
  // Which card is being edited inline, in the page (no popup).
  const [editCard, setEditCard] = useState<string | null>(null);

  if (!companyId)
    return <div style={pad}>Select a company to manage team templates.</div>;
  if (loading) return <div style={pad}>Loading team templates…</div>;
  if (error) return <div style={pad}>Error: {error.message}</div>;
  const d = stateData!;

  // Active template first.
  const sortedTemplates = [...d.templates].sort((a, b) => {
    const aw = a.key === d.activeTemplate ? 0 : 1;
    const bw = b.key === d.activeTemplate ? 0 : 1;
    return aw - bw;
  });

  async function run<T = unknown>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    setBusy(label);
    setMsg(null);
    try {
      const r = await fn();
      refresh?.();
      return r;
    } catch (e: any) {
      setMsg(`${label} failed: ${e?.message ?? String(e)}`);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function onApply(t: TeamTemplate) {
    const r: any = await run(`apply:${t.key}`, () =>
      apply({ companyId, templateKey: t.key }),
    );
    if (r)
      setMsg(
        `Applied "${t.label}": ${r.patched} agents set${
          r.running?.length
            ? `, ${r.running.length} mid-run (switch on next run)`
            : ""
        }${r.errors?.length ? `, ${r.errors.length} errors` : ""}.`,
      );
  }

  function openDuplicate(t: TeamTemplate) {
    setEditor(editorFromTemplate(t, { duplicate: true }));
  }
  function openNew() {
    setEditor({ ...blankEditor(), open: true });
  }
  function closeEditor() {
    setEditor((e) => ({ ...e, open: false }));
  }

  function toggleCardTeam(key: string) {
    setCardExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function onSaveEditor() {
    const key = editor.key.trim() || `custom-${Date.now()}`;
    const enabled = editor.enabled;
    const teams: Record<string, ModelSpec> = {};
    for (const tk of TEAM_ORDER) {
      // If we tracked an "enabled" subset (from an existing template), honour it;
      // otherwise (a brand-new template) include every team.
      if (!enabled || enabled.has(tk)) teams[tk] = editor.teams[tk];
    }
    const template: TeamTemplate = {
      key,
      label: editor.label.trim() || key,
      description: editor.description.trim() || undefined,
      teams,
      builtin: false,
    };
    const r = await run("save", () => saveTemplate({ companyId, template }));
    if (r !== undefined) {
      setMsg(`Saved template "${key}".`);
      closeEditor();
    }
  }

  async function onSaveInline(
    t: TeamTemplate,
    draft: {
      label: string;
      description: string;
      teams: Record<string, ModelSpec>;
      workers: Record<string, ModelSpec>;
    },
  ) {
    const workers =
      Object.keys(draft.workers).length > 0 ? draft.workers : undefined;
    const template: TeamTemplate = {
      key: t.key,
      label: draft.label.trim() || t.key,
      description: draft.description.trim() || undefined,
      teams: draft.teams,
      workers,
      builtin: false,
    };
    const r = await run("save", () => saveTemplate({ companyId, template }));
    if (r !== undefined) {
      setMsg(`Saved "${t.key}".`);
      setEditCard(null);
    }
  }

  async function onDelete(t: TeamTemplate) {
    const r = await run(`del:${t.key}`, () =>
      del({ companyId, templateKey: t.key }),
    );
    if (r !== undefined) setMsg(`Deleted "${t.label}".`);
  }

  return (
    <div style={{ ...pad, display: "grid", gap: "1.1rem", maxWidth: 940 }}>
      <div>
        <h2 style={{ margin: 0 }}>Team Model Templates</h2>
        <div style={{ opacity: 0.7, fontSize: 13, marginTop: 4 }}>
          Pick a template to set every team's agents to a model. Each call
          routes through that LLM's CLI (codex / claude / gemini). Active:{" "}
          <strong>{d.activeTemplate ?? "none"}</strong>
        </div>
      </div>

      {/* -------- Pi concurrency cap (global FIFO throttle on real `pi` processes) -------- */}
      <div
        style={{
          ...card,
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 14 }}>Pi concurrency cap</strong>
        <input
          type="number"
          min={1}
          max={64}
          value={capInput === "" ? String(d.throttle ?? 8) : capInput}
          onChange={(e) => setCapInput(e.target.value)}
          style={{
            width: 64,
            padding: "4px 6px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.2)",
            background: "transparent",
            color: "inherit",
          }}
        />
        <span style={{ opacity: 0.7, fontSize: 12 }}>
          max real <code>pi</code> processes at once — machine-wide, the rest queue FIFO
        </span>
        <button
          style={{ ...btn, ...(busy === "throttle" ? btnDisabled : {}) }}
          disabled={busy === "throttle"}
          onClick={async () => {
            const n = Math.max(
              1,
              Math.floor(Number(capInput === "" ? (d.throttle ?? 8) : capInput)) || 8,
            );
            const r: any = await run("throttle", () =>
              setThrottle({ companyId, maxConcurrent: n }),
            );
            if (r) {
              setCapInput(String(r.maxConcurrent));
              setMsg(`Pi concurrency cap set to ${r.maxConcurrent}.`);
            }
          }}
        >
          {busy === "throttle" ? "Saving…" : "Save cap"}
        </button>
      </div>

      {msg && (
        <div
          style={{ ...card, borderColor: "rgba(80,160,255,0.5)", fontSize: 13 }}
        >
          {msg}
        </div>
      )}

      {/* -------- Template cards (active first) -------- */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 14 }}>Templates</strong>
        <button
          style={{ ...btn, background: "rgba(80,200,120,0.18)" }}
          onClick={openNew}
        >
          + New template
        </button>
      </div>
      <div style={{ display: "grid", gap: "0.7rem" }}>
        {sortedTemplates.map((t) => {
          const isActive = d.activeTemplate === t.key;
          const isBuiltin = t.builtin === true;
          return (
            <div
              key={t.key}
              style={{
                ...card,
                borderColor: isActive
                  ? "rgba(58,170,136,0.6)"
                  : "rgba(128,128,128,0.25)",
              }}
            >
              {/* header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <strong>{t.label}</strong>
                  <span style={tag}>{isBuiltin ? "built-in" : "custom"}</span>
                  {isActive && (
                    <span
                      style={{
                        background: "#3a8",
                        color: "#fff",
                        borderRadius: 6,
                        padding: "1px 8px",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      ● active
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    style={{
                      ...btn,
                      background: "rgba(80,160,255,0.15)",
                      ...(busy === `apply:${t.key}` ? btnDisabled : {}),
                    }}
                    disabled={busy === `apply:${t.key}`}
                    onClick={() => onApply(t)}
                  >
                    {busy === `apply:${t.key}` ? "Applying…" : "Apply"}
                  </button>
                  <button style={btn} onClick={() => openDuplicate(t)}>
                    Duplicate
                  </button>
                  <button
                    style={{
                      ...btn,
                      ...(editCard === t.key
                        ? { background: "rgba(80,160,255,0.18)" }
                        : {}),
                    }}
                    title="Edit inline"
                    onClick={() =>
                      setEditCard(editCard === t.key ? null : t.key)
                    }
                  >
                    {editCard === t.key ? "Editing\u2026" : "Edit"}
                  </button>
                  <button
                    style={{
                      ...btn,
                      ...(busy === `del:${t.key}` ? btnDisabled : {}),
                    }}
                    disabled={busy === `del:${t.key}`}
                    title="Delete"
                    onClick={() => onDelete(t)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {t.description && (
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                  {t.description}
                </div>
              )}
              {editCard === t.key ? (
                <InlineTemplateEditor
                  template={t}
                  busy={busy === "save"}
                  onCancel={() => setEditCard(null)}
                  onSave={(draft) => onSaveInline(t, draft)}
                />
              ) : (
                <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                {TEAM_ORDER.filter((tk) => t.teams[tk]).map((tk) => {
                  const spec = t.teams[tk];
                  const roles = TEAM_ROLES[tk] ?? [];
                  const ckey = `${t.key}:${tk}`;
                  const open = cardExpanded.has(ckey);
                  return (
                    <div key={tk} style={{ display: "grid", gap: 4 }}>
                      {/* clickable team header — toggles this team's member list */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleCardTeam(ckey)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleCardTeam(ckey);
                          }
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          cursor: "pointer",
                          userSelect: "none",
                          fontSize: 13,
                        }}
                      >
                        <span style={{ width: 12, opacity: 0.6, fontSize: 11 }}>
                          {open ? "▼" : "▶"}
                        </span>
                        <span style={{ fontWeight: 600 }}>{TEAM_LABELS[tk]}</span>
                        <span style={{ opacity: 0.5, fontSize: 12 }}>
                          ({roles.length})
                        </span>
                        <span style={{ marginLeft: "auto" }}>
                          <LlmChip
                            llm={spec.llm}
                            model={spec.model}
                            reasoning={spec.reasoning}
                          />
                        </span>
                      </div>
                      {/* expanded: every member of this team */}
                      {open && (
                        <div
                          style={{
                            display: "grid",
                            gap: 3,
                            paddingLeft: 20,
                            marginLeft: 5,
                            borderLeft: "1px solid rgba(128,128,128,0.2)",
                          }}
                        >
                          {roles.map((r) => {
                            const wspec =
                              (t.workers && t.workers[r]) || spec;
                            return (
                            <div
                              key={r}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                fontSize: 13,
                              }}
                            >
                              <span
                                style={{
                                  flex: 1,
                                  opacity: 0.85,
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                }}
                              >
                                {r}
                                {r.endsWith("-lead") && (
                                  <span style={tag}>lead</span>
                                )}
                              </span>
                              <LlmChip
                                llm={wspec.llm}
                                model={wspec.model}
                                reasoning={wspec.reasoning}
                              />
                            </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* -------- Editor modal (Duplicate / Edit / New) -------- */}
      {editor.open && (
        <div
          onClick={closeEditor}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "5vh 1rem",
            zIndex: 1000,
            overflowY: "auto",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              ...card,
              background: "#ffffff",
              backgroundColor: "#ffffff",
              color: "#1a1a1a",
              border: "1px solid rgba(0,0,0,0.14)",
              boxShadow: "0 12px 48px rgba(0,0,0,0.28)",
              width: "100%",
              maxWidth: 640,
              display: "grid",
              gap: "0.7rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <strong>
                {editor.editingKey
                  ? `Edit template — ${editor.editingKey}`
                  : "New / duplicate template"}
              </strong>
              <button style={btn} onClick={closeEditor}>
                Close
              </button>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <input
                placeholder="key (e.g. my-team-mix)"
                value={editor.key}
                disabled={!!editor.editingKey}
                onChange={(e) =>
                  setEditor((s) => ({ ...s, key: e.target.value }))
                }
                style={{
                  ...sel,
                  flex: 1,
                  padding: "5px 8px",
                  opacity: editor.editingKey ? 0.6 : 1,
                }}
              />
              <input
                placeholder="label"
                value={editor.label}
                onChange={(e) =>
                  setEditor((s) => ({ ...s, label: e.target.value }))
                }
                style={{ ...sel, flex: 2, padding: "5px 8px" }}
              />
            </div>
            <input
              placeholder="description (optional)"
              value={editor.description}
              onChange={(e) =>
                setEditor((s) => ({ ...s, description: e.target.value }))
              }
              style={{ ...sel, padding: "5px 8px" }}
            />

            <div style={{ display: "grid", gap: 6 }}>
              {TEAM_ORDER.map((tk) => {
                const enabled = editor.enabled;
                const isOn = !enabled || enabled.has(tk);
                const spec = editor.teams[tk];
                return (
                  <div
                    key={tk}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      opacity: isOn ? 1 : 0.45,
                    }}
                  >
                    {enabled && (
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={(e) =>
                          setEditor((s) => {
                            const next = new Set(s.enabled ?? TEAM_ORDER);
                            if (e.target.checked) next.add(tk);
                            else next.delete(tk);
                            return { ...s, enabled: next };
                          })
                        }
                      />
                    )}
                    <span style={{ width: 150 }}>{TEAM_LABELS[tk]}</span>
                    <ModelSelects
                      spec={spec}
                      idPrefix={`editor-${tk}`}
                      onChange={(nextSpec) =>
                        setEditor((s) => ({
                          ...s,
                          teams: { ...s.teams, [tk]: nextSpec },
                        }))
                      }
                    />
                  </div>
                );
              })}
            </div>

            <div
              style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
            >
              <button style={btn} onClick={closeEditor}>
                Cancel
              </button>
              <button
                style={{
                  ...btn,
                  background: "rgba(80,200,120,0.18)",
                  ...(busy === "save" ? btnDisabled : {}),
                }}
                disabled={busy === "save"}
                onClick={onSaveEditor}
              >
                {busy === "save" ? "Saving…" : "Save template"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Dashboard widget — preserved behaviour
// ===========================================================================
export function DashboardWidget(_props: PluginWidgetProps) {
  const companyId = _props.context?.companyId ?? null;
  const { data, refresh } = usePluginData<{
    activeTemplate: string | null;
    label: string | null;
    templates: Array<{ key: string; label: string }>;
  }>("active", companyId ? { companyId } : undefined);
  const apply = usePluginAction("apply");
  const [chosen, setChosen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const templates = data?.templates ?? [];
  const active = data?.activeTemplate ?? null;
  const selected = chosen || active || templates[0]?.key || "";

  async function activate() {
    if (!companyId || !selected) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = (await apply({ companyId, templateKey: selected })) as {
        patched?: number;
        running?: string[];
      } | null;
      setMsg(
        r
          ? `Activated \u2014 ${r.patched ?? 0} agents set${
              r.running?.length ? `, ${r.running.length} mid-run` : ""
            }`
          : "Activated.",
      );
      refresh?.();
    } catch (e: any) {
      setMsg(`Failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !selected || selected === active;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <strong>Team Model Template</strong>
      <div style={{ fontSize: 13 }}>
        Active: <strong>{data?.label ?? active ?? "none"}</strong>
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <select
          aria-label="active template"
          value={selected}
          onChange={(e) => setChosen(e.target.value)}
          style={sel}
        >
          {templates.length === 0 && <option value="">(none)</option>}
          {templates.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          onClick={activate}
          disabled={disabled}
          style={{
            ...btn,
            background: "rgba(80,160,255,0.15)",
            ...(disabled ? btnDisabled : {}),
          }}
        >
          {busy ? "Activating\u2026" : "Activate"}
        </button>
      </div>
      {msg && <div style={{ fontSize: 12, opacity: 0.7 }}>{msg}</div>}
    </div>
  );
}

// ===========================================================================
// Sidebar link — preserved behaviour (useHostNavigation().linkProps)
// ===========================================================================
export function SidebarLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  return (
    <a
      {...nav.linkProps("/team-templates")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        textDecoration: "none",
        fontSize: 13,
        color: "inherit",
      }}
    >
      <span>Team Templates</span>
    </a>
  );
}
