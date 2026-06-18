#!/usr/bin/env node

import test from "node:test";
import assert from "node:assert/strict";
import { paperclipImproverCommentPresent, hasNonEmptyValue } from "./pr-task-sweeper.mjs";

test("sweeper blocker text does not satisfy improver Paperclip visibility", () => {
  const comments = [{
    authorType: "agent",
    authorAgentId: "agent-sweeper-id",
    body: [
      "<!-- pr-task-sweeper-v2:abc -->",
      "PR is merged but this ticket is not eligible for Done yet",
      "- self-improvement evidence missing: no Paperclip-visible improver review/no-op/not-applicable comment",
      "- Owner/action: self-improvement-lead must review the run, record improver_review evidence and a self_improvement PASS/no-op/not-applicable gate, and post the Paperclip-visible improvement comment before Done/ship.",
    ].join("\n"),
    presentation: { kind: "system_notice", title: "PR/task sweeper" },
    metadata: null,
  }];
  const agentsMap = new Map([
    ["agent-sweeper-id", "pr-task-sweeper"],
    ["agent-improver-id", "self-improvement-lead"]
  ]);
  assert.equal(paperclipImproverCommentPresent(comments, agentsMap), false);
});

test("generic prose about improver review does not satisfy improver visibility", () => {
  const comments = [{
    authorType: "agent",
    authorAgentId: "agent-coord-id",
    body: "self-improvement-lead must post an improver review before close",
    presentation: { kind: "system_notice", title: "Coordination note" },
    metadata: null,
  }];
  const agentsMap = new Map([
    ["agent-coord-id", "coordinator"],
    ["agent-improver-id", "self-improvement-lead"]
  ]);
  assert.equal(paperclipImproverCommentPresent(comments, agentsMap), false);
});

test("structured Option B improver no-op comment satisfies improver visibility", () => {
  const comments = [{
    authorType: "agent",
    authorAgentId: "agent-improver-id",
    body: "[self-improvement-lead] Improver review complete: no reusable lesson found.\nEvent type: improvement_noop",
    presentation: { kind: "system_notice", title: "Dark Factory role comment: self-improvement-lead" },
    metadata: { sections: [{ rows: [
      { label: "role", value: "self-improvement-lead" },
      { label: "event_type", value: "improvement_noop" },
    ] }] },
  }];
  const agentsMap = new Map([
    ["agent-improver-id", "self-improvement-lead"]
  ]);
  assert.equal(paperclipImproverCommentPresent(comments, agentsMap), true);
});

test("empty improver fields are recognized as empty", () => {
  assert.equal(hasNonEmptyValue([]), false);
  assert.equal(hasNonEmptyValue("   "), false);
  assert.equal(hasNonEmptyValue({}), false);
  assert.equal(hasNonEmptyValue(["ledger"]), true);
  assert.equal(hasNonEmptyValue("none"), true);
  assert.equal(hasNonEmptyValue({ owner: "self-improvement-lead" }), true);
});
