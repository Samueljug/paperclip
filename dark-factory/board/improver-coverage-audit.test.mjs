#!/usr/bin/env node

import test from "node:test";
import assert from "node:assert/strict";
import { classifyComment, classifyVisibleImproverCoverage, evaluateIssue } from "./improver-coverage-audit.mjs";

function optionBComment({ role = "self-improvement-lead", eventType, body = "", extraRows = [] }) {
  return {
    id: `${eventType}-comment`,
    authorAgentId: "123b94fa-8452-45c4-b47e-071011b3372a",
    createdAt: "2026-06-11T00:00:00Z",
    body: body || `[${role}] Improver review complete.\nEvent type: ${eventType}\nOwner/reviewer: ${role}`,
    presentation: { kind: "system_notice", title: `Dark Factory role comment: ${role}` },
    metadata: { sections: [{ rows: [
      { label: "role", value: role },
      { label: "event_type", value: eventType },
      ...extraRows,
    ] }] },
  };
}

const okLedger = {
  exists: true,
  ok: true,
  count: 3,
  lastHash: "hash",
  failures: [],
  improverEventCount: 1,
  improverEventTypes: ["improvement_noop"],
  coverageType: "noop",
};

const issue = { id: "1", identifier: "OPE-999", title: "Test", status: "done", projectId: "project" };

test("structured improvement_review is classified as real review", () => {
  const classified = classifyComment(optionBComment({ eventType: "improvement_review" }));
  assert.equal(classified.coverageType, "review");
  assert.equal(classified.valid, true);
});

test("structured improvement_noop is classified as no-op", () => {
  const coverage = classifyVisibleImproverCoverage([optionBComment({ eventType: "improvement_noop" })]);
  assert.equal(coverage.present, true);
  assert.equal(coverage.coverageType, "noop");
});

test("structured improvement_not_applicable requires reason", () => {
  const valid = classifyComment(optionBComment({
    eventType: "improvement_not_applicable",
    body: "[self-improvement-lead] Not applicable.\nEvent type: improvement_not_applicable\nOwner/reviewer: self-improvement-lead\nNot applicable reason: cancelled before any factory work",
  }));
  assert.equal(valid.coverageType, "not_applicable");
  assert.equal(valid.valid, true);

  const invalid = classifyComment(optionBComment({
    eventType: "improvement_not_applicable",
    body: "[self-improvement-lead] Not applicable.\nEvent type: improvement_not_applicable\nOwner/reviewer: self-improvement-lead",
  }));
  assert.equal(invalid.coverageType, "not_applicable");
  assert.equal(invalid.valid, false);
});

test("sweeper/generic prose does not satisfy coverage", () => {
  const sweeper = {
    id: "sweeper",
    body: "<!-- pr-task-sweeper-v2:abc -->\nOwner/action: self-improvement-lead must post improver_review evidence.",
    presentation: { kind: "system_notice", title: "PR/task sweeper" },
    metadata: null,
  };
  const generic = {
    id: "generic",
    body: "self-improvement-lead must post an improver review before close",
    presentation: { kind: "system_notice", title: "Coordination note" },
    metadata: null,
  };
  assert.equal(classifyComment(sweeper), null);
  assert.equal(classifyComment(generic), null);
  assert.equal(classifyVisibleImproverCoverage([sweeper, generic]).present, false);
});

test("missing visible coverage fails even when ledger has improver event", () => {
  const result = evaluateIssue({ issue, comments: [], ledger: okLedger, requirements: { ledger: false } });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.coverageType, "missing");
  assert.ok(result.missing.some((item) => item.kind === "visible_improver_review"));
  assert.ok(result.missing.some((item) => item.kind === "visible_mirror_missing"));
});

test("visible noop plus ledger improver event passes", () => {
  const result = evaluateIssue({ issue, comments: [optionBComment({ eventType: "improvement_noop" })], ledger: okLedger, requirements: { ledger: true } });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.coverageType, "noop");
});

test("invalid not-applicable comment fails", () => {
  const result = evaluateIssue({
    issue,
    comments: [optionBComment({
      eventType: "improvement_not_applicable",
      body: "[self-improvement-lead] N/A\nEvent type: improvement_not_applicable\nOwner/reviewer: self-improvement-lead",
    })],
    ledger: { ...okLedger, improverEventTypes: ["improvement_not_applicable"], coverageType: "not_applicable" },
    requirements: { ledger: false },
  });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.coverageType, "not_applicable");
  assert.ok(result.missing.some((item) => item.kind === "invalid_improver_comment"));
});

test("gate_result:self_improvement is classified as review coverage", () => {
  const coverage = classifyVisibleImproverCoverage([optionBComment({ eventType: "gate_result:self_improvement" })]);
  assert.equal(coverage.present, true);
  assert.equal(coverage.coverageType, "review");
});

test("require-ledger fails when ledger is missing", () => {
  const result = evaluateIssue({
    issue,
    comments: [optionBComment({ eventType: "improvement_review" })],
    ledger: { exists: false, ok: false, count: 0, lastHash: null, failures: [{ reason: "missing" }], improverEventCount: 0, improverEventTypes: [], coverageType: "missing" },
    requirements: { ledger: true },
  });
  assert.equal(result.verdict, "FAIL");
  assert.ok(result.missing.some((item) => item.kind === "factory_ledger"));
});

test("spoofed or unauthorized author agent fails validation", () => {
  const spoofed = optionBComment({ eventType: "improvement_review" });
  spoofed.authorAgentId = "unauthorized-agent-uuid";
  const classified = classifyComment(spoofed);
  assert.equal(classified.valid, false);
  assert.equal(classified.invalidReason, "unauthorized author agent for self-improvement review");
});
