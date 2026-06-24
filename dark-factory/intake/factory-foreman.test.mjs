import test from "node:test";
import assert from "node:assert/strict";

import {
  activeExecutionConflictId,
  activeWorkConflict,
  alreadyHandedOffForCurrentTodoState,
  buildHandoffPrompt,
  chooseHandoffTarget,
  isInboxFullError,
  isTelegramIntakeIssue,
  issueSourceName,
  preferredHandoffTargets,
  readyFingerprint,
  targetInboxHasCapacity,
} from "./factory-foreman.mjs";

const config = {
  boardUrl: "http://paperclip.local",
};

function issue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "OPE-1",
    title: "Route Todo card",
    description: "Manual board task",
    updatedAt: "2026-06-09T02:00:00.000Z",
    labels: [],
    ...overrides,
  };
}

test("manual Todo cards are treated as Paperclip Todo source", () => {
  const manualIssue = issue();

  assert.equal(isTelegramIntakeIssue(manualIssue), false);
  assert.equal(issueSourceName(manualIssue), "Paperclip Todo");

  const prompt = buildHandoffPrompt(config, manualIssue);
  assert.match(prompt, /New Paperclip Todo-ready Dark Factory ticket: OPE-1/);
  assert.match(prompt, /Source: Paperclip Todo/);
  assert.match(prompt, /Review this ticket/);
  assert.doesNotMatch(prompt, /New Telegram-intake/);
});

test("Telegram intake cards still keep their source identity", () => {
  const telegramIssue = issue({
    description: "Original brief\n\n- Marker: [factory-intake:v1]",
  });

  assert.equal(isTelegramIntakeIssue(telegramIssue), true);
  assert.equal(issueSourceName(telegramIssue), "Telegram factory intake");
  assert.match(buildHandoffPrompt(config, telegramIssue), /Source: Telegram factory intake/);
});

test("ClickUp sync cards keep their source identity", () => {
  const clickupIssue = issue({
    description: "Original ClickUp ticket\n\n- Marker: [clickup-sync:v1]",
  });

  assert.equal(issueSourceName(clickupIssue), "ClickUp sync");
  assert.match(buildHandoffPrompt(config, clickupIssue), /Source: ClickUp sync/);
});

test("handoff state is idempotent for the same Todo state", () => {
  const todoIssue = issue();
  const state = {
    issues: {
      [todoIssue.id]: {
        status: "handed_off",
        readyFingerprint: readyFingerprint(todoIssue),
      },
    },
  };

  assert.equal(alreadyHandedOffForCurrentTodoState(state, todoIssue), true);
});

test("active Paperclip execution state is idempotent for the same Todo state", () => {
  const todoIssue = issue();
  const state = {
    issues: {
      [todoIssue.id]: {
        status: "active_execution",
        readyFingerprint: readyFingerprint(todoIssue),
        executionRunId: "run-1",
      },
    },
  };

  assert.equal(alreadyHandedOffForCurrentTodoState(state, todoIssue), true);
});

test("a later Todo requeue is eligible for another handoff", () => {
  const firstTodoState = issue({ updatedAt: "2026-06-09T02:00:00.000Z" });
  const requeuedTodoState = issue({ updatedAt: "2026-06-09T02:10:00.000Z" });
  const state = {
    issues: {
      [firstTodoState.id]: {
        status: "handed_off",
        readyFingerprint: readyFingerprint(firstTodoState),
      },
    },
  };

  assert.equal(alreadyHandedOffForCurrentTodoState(state, requeuedTodoState), false);
});

test("target inbox soft limit leaves headroom before claiming Todo cards", () => {
  const foremanConfig = { targetInboxSoftLimit: 80 };

  assert.equal(targetInboxHasCapacity(foremanConfig, { queue_depth: 79 }, 1), true);
  assert.equal(targetInboxHasCapacity(foremanConfig, { queue_depth: 80 }, 1), false);
  assert.equal(targetInboxHasCapacity(foremanConfig, { queue_depth: 75 }, 5), true);
  assert.equal(targetInboxHasCapacity(foremanConfig, { queue_depth: 76 }, 5), false);
});

test("coms-net inbox_full is treated as receiver backpressure", () => {
  const err = new Error('POST /v1/messages -> 429: {"ok":false,"error":"inbox_full"}');
  err.status = 429;
  err.body = { ok: false, error: "inbox_full" };
  err.errorCode = "inbox_full";

  assert.equal(isInboxFullError(err), true);
  assert.equal(isInboxFullError(Object.assign(new Error("rate limited"), { status: 429 })), false);
});

test("Paperclip checkout conflict with executionRunId is treated as active execution", () => {
  const err = new Error("checkout conflict");
  err.status = 409;
  err.body = { details: { executionRunId: "run-active" } };

  assert.equal(activeExecutionConflictId(err), "run-active");
  assert.equal(activeExecutionConflictId(Object.assign(new Error("conflict"), { status: 409 })), null);
});

test("Paperclip checkout conflict with checkoutRunId is treated as active work", () => {
  const err = new Error("checkout conflict");
  err.status = 409;
  err.body = { details: { checkoutRunId: "checkout-active" } };

  assert.deepEqual(activeWorkConflict(err), { kind: "checkout", id: "checkout-active" });
  assert.equal(activeExecutionConflictId(err), null);
});

test("review-productivity Todo cards route to the self-improvement lane first", () => {
  const targets = preferredHandoffTargets(issue({ title: "Review productivity for OPE-159" }));

  assert.equal(targets[0], "self-improvement-lead");
  assert.ok(targets.includes("pi-orchestrator"));
});

test("security Todo cards prefer the security lane", () => {
  const targets = preferredHandoffTargets(issue({
    title: "[SEC][HIGH] Cross-tenant document takeover",
    description: "IDOR and authorization failure",
  }));

  assert.equal(targets[0], "security-lead");
});

test("lane-aware route bypasses a saturated primary orchestrator", () => {
  const foremanConfig = { targetInboxSoftLimit: 80 };
  const targets = new Map([
    ["pi-orchestrator", { name: "pi-orchestrator", session_id: "pi", queue_depth: 126 }],
    ["self-improvement-lead", { name: "self-improvement-lead", session_id: "improve", queue_depth: 0 }],
  ]);

  const route = chooseHandoffTarget(foremanConfig, issue({ title: "Review productivity for OPE-159" }), targets, {});

  assert.equal(route.target.name, "self-improvement-lead");
  assert.match(route.routingReason, /lane-aware route/);
});

test("lane-aware route returns null when all preferred lanes are saturated", () => {
  const foremanConfig = { targetInboxSoftLimit: 80 };
  const targets = new Map([
    ["pi-orchestrator", { name: "pi-orchestrator", session_id: "pi", queue_depth: 80 }],
    ["self-improvement-lead", { name: "self-improvement-lead", session_id: "improve", queue_depth: 80 }],
    ["planning-lead", { name: "planning-lead", session_id: "planning", queue_depth: 80 }],
    ["implementation-lead", { name: "implementation-lead", session_id: "implementation", queue_depth: 80 }],
    ["verification-lead", { name: "verification-lead", session_id: "verification", queue_depth: 80 }],
    ["security-lead", { name: "security-lead", session_id: "security", queue_depth: 80 }],
  ]);

  const route = chooseHandoffTarget(foremanConfig, issue({ title: "Review productivity for OPE-159" }), targets, {});

  assert.equal(route, null);
});
