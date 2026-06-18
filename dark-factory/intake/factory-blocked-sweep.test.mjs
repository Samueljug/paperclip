import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBlockedPrompt,
  isProductivityReviewIssue,
  recentlySwept,
} from "./factory-blocked-sweep.mjs";

const config = {
  boardUrl: "http://paperclip.local",
  blockedSweepCooldownMs: 1800000,
};

function issue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "OPE-333",
    title: "Review productivity for OPE-270",
    description: "Manager decision needed.",
    status: "blocked",
    updatedAt: "2026-06-11T21:40:31.384Z",
    ...overrides,
  };
}

test("productivity-review cards are recognized by title", () => {
  assert.equal(isProductivityReviewIssue(issue()), true);
  assert.equal(isProductivityReviewIssue(issue({ title: "Fix login", originKind: "bug" })), false);
});

test("productivity-review cards are recognized by origin kind", () => {
  assert.equal(isProductivityReviewIssue(issue({
    title: "Manager review",
    originKind: "issue_productivity_review",
  })), true);
});

test("blocked prompt tells lanes to close or keep explicit owner/action", () => {
  const prompt = buildBlockedPrompt(config, issue(), "self-improvement-lead", "reactivate_productivity_review");

  assert.match(prompt, /Review whether the source issue is genuinely stalled/);
  assert.match(prompt, /notify Samuel visibly in Telegram/);
  assert.match(prompt, /hourly follow-up rule/);
});

test("recentlySwept respects fingerprint and cooldown", () => {
  const blockedIssue = issue();
  const now = Date.parse("2026-06-11T22:00:00.000Z");
  const state = {
    issues: {
      [blockedIssue.id]: {
        readyFingerprint: `blocked:${blockedIssue.id}`,
        lastSweepAt: "2026-06-11T21:45:00.000Z",
      },
    },
  };

  assert.equal(recentlySwept(config, state, blockedIssue, now), true);
  assert.equal(recentlySwept(config, state, issue({ updatedAt: "2026-06-11T22:01:00.000Z" }), now), true);
  assert.equal(recentlySwept(config, state, issue({ id: "issue-2" }), now), false);
});
