import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { LEADS, PROJECT_ID, routeLead, shouldAssign } from "../src/routing.js";

describe("manifest", () => {
  it("declares the capabilities the worker uses", () => {
    for (const cap of ["events.subscribe", "issues.read", "issues.update"]) {
      expect(manifest.capabilities).toContain(cap);
    }
  });
});

describe("routeLead", () => {
  const cases: Array<[string, string]> = [
    ["Wiki drift: foreman-cli.md vs foreman.mjs", "docs-release-lead"],
    ["Security and privacy review for OPE-150", "security-lead"],
    ["Automated verification + regression tests", "verification-lead"],
    ["Fix backend API endpoint pagination bug", "implementation-lead"],
    ["Investigate feasibility of new approach", "research-lead"],
    ["Button modal layout broken on mobile", "browser-qa-lead"],
    ["Ops alert: review productivity", "planning-lead (default)"],
  ];
  for (const [title, expected] of cases) {
    it(`routes "${title.slice(0, 30)}" -> ${expected}`, () => {
      expect(routeLead(title, "").label).toBe(expected);
      expect(Object.values(LEADS)).toContain(routeLead(title, "").agentId);
    });
  }
});

describe("shouldAssign", () => {
  const base = { projectId: PROJECT_ID, status: "todo", assigneeAgentId: null };
  it("assigns an unassigned todo in the dark-factory project", () => {
    expect(shouldAssign(base)).toBe(true);
  });
  it("skips already-assigned", () => {
    expect(shouldAssign({ ...base, assigneeAgentId: "x" })).toBe(false);
  });
  it("skips non-todo", () => {
    expect(shouldAssign({ ...base, status: "in_progress" })).toBe(false);
  });
  it("skips other projects", () => {
    expect(shouldAssign({ ...base, projectId: "other" })).toBe(false);
  });
  it("skips null", () => {
    expect(shouldAssign(null)).toBe(false);
  });
});
