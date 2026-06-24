#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const workspace = resolve(new URL("../..", import.meta.url).pathname);
const foreman = resolve(workspace, "tools/dark-factory/foreman.mjs");
const driftScript = resolve(workspace, "tools/dark-factory/wiki-drift-check.mjs");
const templatePath = resolve(workspace, "tools/dark-factory/examples/minimal-workorder.json");

// Wiki drift gate: HARD wiki drift (broken link, undocumented orchestration
// tool, LaunchAgent state contradiction) fails conformance. Warnings (a source
// changed after its doc) do not — they are surfaced for review only.
function runWikiDriftCell() {
  const result = spawnSync("node", [driftScript, "--json", "--no-launchagent"], { cwd: workspace, encoding: "utf8" });
  let report = { ok: false, hard: [{ id: "exec", msg: "wiki-drift-check did not produce JSON" }], warn: [] };
  try {
    report = JSON.parse(result.stdout);
  } catch {
    /* keep the failed default */
  }
  return {
    checks: [{ name: "wikiNoHardDrift", ok: report.ok === true }],
    report,
  };
}

function run(args, options = {}) {
  const result = spawnSync("node", [foreman, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`foreman ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function runAsync(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [foreman, ...args], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(`foreman ${args.join(" ")} failed\n${stdout}\n${stderr}`));
        return;
      }
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function jsonFrom(result) {
  return JSON.parse(result.stdout);
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function makeRepo(root, suffix) {
  const repo = resolve(root, `repo-${suffix}`);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--initial-branch", "stage"]);
  git(repo, ["config", "user.email", "dark-factory-conformance@example.local"]);
  git(repo, ["config", "user.name", "Dark Factory Conformance"]);
  writeFileSync(resolve(repo, "README.md"), `# Dark Factory conformance ${suffix}\n`);
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "seed conformance repo"]);
  git(repo, ["checkout", "-b", `dark-factory-conformance-${suffix}`]);
  return repo;
}

function syncTaskRoute(workOrder, repo) {
  const browserQa = workOrder.gates?.browserQa === true || workOrder.changeType === "ui" || workOrder.changeType === "fullstack";
  const prBacked = workOrder.gates?.pr === true;
  const evidenceRequirements = Array.isArray(workOrder.evidenceRequirements) && workOrder.evidenceRequirements.length > 0
    ? workOrder.evidenceRequirements
    : (workOrder.changeType === "process" ? ["review"] : ["test"]);
  workOrder.taskRoute = {
    schemaVersion: 1,
    kind: "core_policy",
    source: `Dark Factory conformance cell ${workOrder.workOrderId}`,
    decision: "Conformance uses a temporary local repo for Foreman contract verification.",
    repoUrl: workOrder.repo.url,
    baseBranch: workOrder.repo.baseBranch,
    branch: workOrder.repo.branch,
    localPath: repo,
    difficulty: workOrder.changeType === "process" ? "D1" : "D2",
    mode: workOrder.changeType === "process" ? "mode0" : "mode2",
    changeType: workOrder.changeType,
    prBacked,
    browserQa,
    userFlow: browserQa,
    userVisible: browserQa,
    requiredLanes: [
      "foreman",
      ...(workOrder.changeType === "process" ? [] : ["planning", "implementation", "verification"]),
      ...(browserQa ? ["browser_qa"] : []),
      ...(workOrder.gates?.securityReview ? ["security"] : []),
      ...(prBacked ? ["no_mistakes", "pr"] : []),
      "self_improvement",
    ],
    evidenceRequirements,
  };
  workOrder.evidenceRequirements = evidenceRequirements;
}

function makeWorkOrder(root, suffix, options = {}) {
  const repo = options.repo || makeRepo(root, suffix);
  const workOrder = JSON.parse(readFileSync(templatePath, "utf8"));
  workOrder.workOrderId = `DF-CONFORMANCE-${suffix}`;
  workOrder.issue = `DF-CONFORMANCE-${suffix}`;
  workOrder.title = `Dark Factory conformance cell ${suffix}`;
  workOrder.repo.url = repo;
  workOrder.repo.workingDir = repo;
  workOrder.repo.baseBranch = "stage";
  workOrder.repo.branch = `dark-factory-conformance-${suffix}`;
  if (options.mutate) options.mutate(workOrder);
  syncTaskRoute(workOrder, repo);
  if (options.afterRouteMutate) options.afterRouteMutate(workOrder);
  const path = resolve(root, `${workOrder.workOrderId}.json`);
  writeFileSync(path, `${JSON.stringify(workOrder, null, 2)}\n`);
  return path;
}

function runRouteContractCell(root) {
  const missingRoutePath = makeWorkOrder(root, "ROUTE-MISSING", {
    afterRouteMutate(workOrder) {
      delete workOrder.taskRoute;
    },
  });
  const wrongOrgPath = makeWorkOrder(root, "ROUTE-WRONG-ORG", {
    afterRouteMutate(workOrder) {
      workOrder.repo.url = "https://github.com/aila-code/backend-legal";
      workOrder.taskRoute.kind = "main_app_stage";
      workOrder.taskRoute.repoUrl = workOrder.repo.url;
    },
  });
  const staleReferencePath = makeWorkOrder(root, "ROUTE-STALE-REF", {
    afterRouteMutate(workOrder) {
      workOrder.taskRoute.repoUrl = "https://github.com/aila-quillio/quillio-frontend";
    },
  });
  const missingMandatoryGatePath = makeWorkOrder(root, "ROUTE-MANDATORY-GATE", {
    mutate(workOrder) {
      workOrder.changeType = "code";
      workOrder.gates.tests = false;
      workOrder.gates.securityReview = false;
      workOrder.gates.noMistakes = false;
      workOrder.gates.pr = false;
      workOrder.testExpectation = { required: false };
      workOrder.loops = [
        {
          id: "plan-adversarial-review",
          kind: "plan_adversarial_review",
          owner: "planning team",
          trigger: "Ask the planning team exactly once what was missed, what errors exist, and what conflicts exist.",
          maxIterations: 1,
          timeBudgetMinutes: 10,
          judge: "Foreman verifies the planning team response or lack of response was recorded.",
          memory: "recorded response or lack of response",
          evidence: ["plan_adversarial_review"],
          exitCondition: "record planning team response or lack of response",
          escalation: "return to planning team for missed work, errors, or conflicts",
          escalateOnExhaustion: true,
        },
      ];
    },
  });
  const ambiguousStagePath = makeWorkOrder(root, "ROUTE-AMBIGUOUS", {
    afterRouteMutate(workOrder) {
      workOrder.taskRoute.kind = "ambiguous_stage";
    },
  });
  return {
    checks: [
      { name: "missingTaskRouteRejected", ok: run(["validate", "--workorder", missingRoutePath], { allowFailure: true }).status !== 0 },
      { name: "wrongOrgMainStageRejected", ok: run(["validate", "--workorder", wrongOrgPath], { allowFailure: true }).status !== 0 },
      { name: "staleRouteReferenceRejected", ok: run(["validate", "--workorder", staleReferencePath], { allowFailure: true }).status !== 0 },
      { name: "mandatoryGateDerivationRejected", ok: run(["validate", "--workorder", missingMandatoryGatePath], { allowFailure: true }).status !== 0 },
      { name: "ambiguousStageRejected", ok: run(["validate", "--workorder", ambiguousStagePath], { allowFailure: true }).status !== 0 },
    ],
  };
}

function runStageTokenCell(root) {
  const workOrderPath = makeWorkOrder(root, "STAGE-TOKEN");
  const start = jsonFrom(run(["start", "--workorder", workOrderPath]));
  const blockedAdvance = run([
    "advance",
    "--run",
    start.runDir,
    "--stage",
    "In Progress",
    "--summary",
    "should require PLAN token",
  ], { allowFailure: true });
  run([
    "stage-token",
    "--run",
    start.runDir,
    "--token",
    "PLAN",
    "--verdict",
    "PASS",
    "--summary",
    "Planning token recorded",
  ]);
  run([
    "advance",
    "--run",
    start.runDir,
    "--stage",
    "In Progress",
    "--summary",
    "PLAN token present",
  ]);
  const manifest = JSON.parse(readFileSync(resolve(start.runDir, "run-manifest.json"), "utf8"));
  return {
    runDir: start.runDir,
    checks: [
      { name: "advanceRequiresPlanToken", ok: blockedAdvance.status !== 0 },
      { name: "planTokenRecorded", ok: manifest.stageTokens?.plan?.verdict === "PASS" },
      { name: "advanceAfterPlanToken", ok: manifest.currentStage === "In Progress" },
    ],
  };
}

function runBrowserQaCell(root) {
  const workOrderPath = makeWorkOrder(root, "BROWSER-QA", {
    mutate(workOrder) {
      workOrder.changeType = "ui";
      workOrder.gates.tests = false;
      workOrder.gates.securityReview = false;
      workOrder.gates.browserQa = true;
      workOrder.gates.noMistakes = false;
      workOrder.gates.pr = false;
      workOrder.evidenceRequirements = ["browser_qa", "screenshot", "video"];
      workOrder.loops = [
        {
          id: "plan-adversarial-review",
          kind: "plan_adversarial_review",
          owner: "orchestra, Foreman, and planning team",
          trigger: "Immediately after the planning team returns a plan and before implementation starts, ask the planning team exactly once what was missed, what errors exist, and what conflicts exist.",
          maxIterations: 1,
          timeBudgetMinutes: 10,
          judge: "Foreman verifies the one planning-team challenge was sent once and the response or lack of response was recorded before implementation proceeds.",
          memory: "Ticket comments, Foreman loop event, run manifest, and evidence/source of truth for the planning-team response or lack of response.",
          evidence: ["plan_adversarial_review"],
          exitCondition: "The one adversarial plan challenge is recorded with the planning team response or lack of response.",
          escalation: "If the challenge finds missed work, errors, or conflicts, return to the planning team for correction before implementation proceeds.",
          escalateOnExhaustion: true,
        },
      ];
    },
  });
  const start = jsonFrom(run(["start", "--workorder", workOrderPath]));
  const report = resolve(root, "browser-qa-report.md");
  const screenshot = resolve(root, "browser-qa-shot.png");
  const video = resolve(root, "browser-qa-flow.mp4");
  writeFileSync(report, "# Browser QA\n\nPASS\n");
  writeFileSync(screenshot, "fake screenshot bytes\n");
  writeFileSync(video, "fake video bytes\n");
  const manualBrowserGate = run([
    "record-gate",
    "--run",
    start.runDir,
    "--gate",
    "browser_qa",
    "--verdict",
    "PASS",
    "--summary",
    "manual browser gate should be rejected",
  ], { allowFailure: true });
  const missingVideo = run([
    "browser-qa",
    "--run",
    start.runDir,
    "--report",
    report,
    "--screenshot",
    screenshot,
    "--summary",
    "missing video should be rejected",
  ], { allowFailure: true });
  run([
    "browser-qa",
    "--run",
    start.runDir,
    "--report",
    report,
    "--screenshot",
    screenshot,
    "--video",
    video,
    "--summary",
    "browser qa evidence complete",
  ]);
  const manifest = JSON.parse(readFileSync(resolve(start.runDir, "run-manifest.json"), "utf8"));
  const evidencePack = JSON.parse(readFileSync(manifest.paths.evidencePack, "utf8"));
  const evidenceKinds = new Set((evidencePack.items || []).map((item) => item.kind));
  return {
    runDir: start.runDir,
    checks: [
      { name: "manualBrowserQaGateRejected", ok: manualBrowserGate.status !== 0 },
      { name: "browserQaRequiresVideoForFlow", ok: missingVideo.status !== 0 },
      { name: "browserQaGateRecorded", ok: manifest.gates?.browser_qa?.verdict === "PASS" },
      { name: "browserQaEvidenceRecorded", ok: ["browser_qa", "screenshot", "video"].every((kind) => evidenceKinds.has(kind)) },
    ],
  };
}

function runStartFromPaperclipCell(root) {
  const repo = makeRepo(root, "PAPERCLIP");
  const issue = {
    id: "issue-paperclip",
    identifier: "OPE-PAPERCLIP",
    title: "API parser returns empty string for malformed response",
    description: "Backend API bug. Add tests and verification evidence.",
    labels: [{ name: "source: telegram-dev-intake" }],
  };
  const issuePath = resolve(root, "paperclip-issue.json");
  const workOrderPath = resolve(root, "paperclip-workorder.json");
  writeFileSync(issuePath, `${JSON.stringify(issue, null, 2)}\n`);
  run([
    "start-from-paperclip",
    "--issue-json",
    issuePath,
    "--workorder-out",
    workOrderPath,
    "--repo-url",
    repo,
    "--working-dir",
    repo,
    "--repo-name",
    "paperclip-conformance",
    "--change-type",
    "api",
    "--pr-backed",
    "false",
    "--start",
    "true",
  ]);
  const generated = JSON.parse(readFileSync(workOrderPath, "utf8"));
  return {
    workOrderPath,
    checks: [
      { name: "startFromPaperclipCreatesWorkOrder", ok: generated.issue === "OPE-PAPERCLIP" },
      { name: "startFromPaperclipRouteClassifier", ok: generated.taskRoute?.changeType === "api" && generated.taskRoute?.mode !== "mode0" },
      { name: "startFromPaperclipNoPrRoute", ok: generated.taskRoute?.prBacked === false && generated.gates?.pr === false },
    ],
  };
}

function runPublishIdentityCell(root) {
  const workOrderPath = makeWorkOrder(root, "PUBLISH-ID");
  const start = jsonFrom(run(["start", "--workorder", workOrderPath]));
  const blocked = run([
    "push",
    "--run",
    start.runDir,
    "--remote",
    "origin",
    "--branch",
    "dark-factory-conformance-PUBLISH-ID",
  ], {
    allowFailure: true,
    env: { DARK_FACTORY_GH_LOGIN: "not-Samueljug" },
  });
  return {
    runDir: start.runDir,
    checks: [
      { name: "pushRequiresSamueljugIdentity", ok: blocked.status !== 0 && /Samueljug/.test(`${blocked.stdout}\n${blocked.stderr}`) },
    ],
  };
}

function runHandoffWatchdogCell(root) {
  const oldClaimedAt = "2026-06-12T00:00:00.000Z";
  const now = "2026-06-12T00:30:00.000Z";
  const missingRunsDir = resolve(root, "watchdog-empty-runs");
  mkdirSync(missingRunsDir, { recursive: true });
  const missingIssue = {
    id: "issue-watchdog-missing",
    identifier: "DF-WATCHDOG-MISSING",
    title: "Claimed card without Foreman run",
    status: "in_progress",
    startedAt: oldClaimedAt,
    updatedAt: oldClaimedAt,
  };
  const missingIssuePath = resolve(root, "watchdog-missing-issue.json");
  writeFileSync(missingIssuePath, `${JSON.stringify(missingIssue, null, 2)}\n`);
  const missing = run([
    "handoff-watchdog",
    "--issue-json",
    missingIssuePath,
    "--runs-dir",
    missingRunsDir,
    "--max-age-minutes",
    "15",
    "--now",
    now,
  ], { allowFailure: true });
  const missingReport = JSON.parse(missing.stdout);

  const repo = makeRepo(root, "WATCHDOG-COVERED");
  const coveredIssue = {
    id: "issue-watchdog-covered",
    identifier: "DF-WATCHDOG-COVERED",
    title: "Claimed card with canonical Foreman run",
    description: "Factory process work that should create a canonical Foreman run.",
    status: "in_progress",
    startedAt: oldClaimedAt,
    updatedAt: oldClaimedAt,
  };
  const coveredIssuePath = resolve(root, "watchdog-covered-issue.json");
  const coveredWorkOrderPath = resolve(root, "watchdog-covered-workorder.json");
  writeFileSync(coveredIssuePath, `${JSON.stringify(coveredIssue, null, 2)}\n`);
  run([
    "start-from-paperclip",
    "--issue-json",
    coveredIssuePath,
    "--workorder-out",
    coveredWorkOrderPath,
    "--repo-url",
    repo,
    "--working-dir",
    repo,
    "--repo-name",
    "watchdog-covered",
    "--change-type",
    "process",
    "--paperclip-evidence",
    "false",
    "--start",
    "true",
  ]);
  const covered = run([
    "handoff-watchdog",
    "--issue-json",
    coveredIssuePath,
    "--max-age-minutes",
    "15",
    "--now",
    now,
  ]);
  const coveredReport = JSON.parse(covered.stdout);

  return {
    missing: missingReport,
    covered: coveredReport,
    checks: [
      { name: "handoffWatchdogBlocksMissingRun", ok: missing.status !== 0 && missingReport.status === "decision_needed" },
      { name: "handoffWatchdogPlansPaperclipBlock", ok: missingReport.action?.paperclip?.body?.status === "blocked" },
      { name: "handoffWatchdogPagesOrchestrator", ok: missingReport.action?.orchestratorPage?.target === "pi-orchestrator" },
      { name: "handoffWatchdogRecognizesCanonicalRun", ok: covered.status === 0 && coveredReport.status === "covered" && coveredReport.canonicalRuns.length > 0 },
    ],
  };
}

function runQuarantineCell(root) {
  const dirtyRepo = makeRepo(root, "QUARANTINE-DIRTY");
  const dirtyWorkOrderPath = makeWorkOrder(root, "QUARANTINE-DIRTY", { repo: dirtyRepo });
  const dirtyStart = jsonFrom(run(["start", "--workorder", dirtyWorkOrderPath]));
  writeFileSync(resolve(dirtyRepo, "dirty.txt"), "dirty worktree quarantine proof\n");
  const dirty = run([
    "quarantine",
    "--run",
    dirtyStart.runDir,
    "--apply",
    "true",
    "--max-active-minutes",
    "99999",
  ], { allowFailure: true });
  const dirtyReport = JSON.parse(dirty.stdout);
  const dirtyManifest = JSON.parse(readFileSync(resolve(dirtyStart.runDir, "run-manifest.json"), "utf8"));
  const blockedPr = run([
    "pr",
    "--run",
    dirtyStart.runDir,
    "--title",
    "fake quarantined PR",
    "--body",
    "fake quarantined PR",
  ], {
    allowFailure: true,
    env: {
      DARK_FACTORY_GH_LOGIN: "Samueljug",
      DARK_FACTORY_CONFORMANCE_FAKE_PUBLISH: "true",
    },
  });

  const staleRepo = makeRepo(root, "QUARANTINE-STALE");
  const staleWorkOrderPath = makeWorkOrder(root, "QUARANTINE-STALE", { repo: staleRepo });
  const staleStart = jsonFrom(run(["start", "--workorder", staleWorkOrderPath]));
  const stale = run([
    "quarantine",
    "--run",
    staleStart.runDir,
    "--apply",
    "true",
    "--max-active-minutes",
    "5",
    "--now",
    "2999-01-01T00:00:00.000Z",
  ], { allowFailure: true });
  const staleReport = JSON.parse(stale.stdout);

  const sharedRepo = makeRepo(root, "QUARANTINE-SHARED");
  const sharedAPath = makeWorkOrder(root, "QUARANTINE-SHARED-A", { repo: sharedRepo });
  const sharedBPath = makeWorkOrder(root, "QUARANTINE-SHARED-B", { repo: sharedRepo });
  const sharedA = jsonFrom(run(["start", "--workorder", sharedAPath]));
  const sharedB = jsonFrom(run(["start", "--workorder", sharedBPath]));
  const sharedReady = run(["ready", "--run", sharedB.runDir], { allowFailure: true });
  const sharedReadyReport = JSON.parse(sharedReady.stdout);

  return {
    dirtyRunDir: dirtyStart.runDir,
    staleRunDir: staleStart.runDir,
    sharedRunDirs: [sharedA.runDir, sharedB.runDir],
    checks: [
      { name: "dirtyWorktreeQuarantineApplied", ok: dirty.status !== 0 && dirtyReport.applied === true && dirtyManifest.quarantine?.status === "active" },
      { name: "quarantinedRunBlocksPr", ok: blockedPr.status !== 0 && /quarantine|dirty_worktree|worktree/.test(`${blockedPr.stdout}\n${blockedPr.stderr}`) },
      { name: "staleActiveRunQuarantineApplied", ok: stale.status !== 0 && staleReport.applied === true && staleReport.failures.some((failure) => failure.kind === "stale_active_run") },
      { name: "sharedWorktreeBlocksReadiness", ok: sharedReady.status !== 0 && sharedReadyReport.failures.some((failure) => failure.kind === "shared_worktree") },
    ],
  };
}

function runEndToEndFakeFactoryCell(root) {
  const repo = makeRepo(root, "E2E-FAKE-PR");
  const issue = {
    id: "issue-e2e-fake-pr",
    identifier: "DF-E2E-FAKE-PR",
    title: "Fake Telegram intake: user-visible API bug",
    description: "TASK: Backend API bug affects a user-visible screen. Create tests, browser smoke evidence, security review, No Mistakes, and a PR.",
    status: "todo",
    labels: [{ name: "source: telegram-dev-intake" }],
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
  };
  const issuePath = resolve(root, "e2e-paperclip-issue.json");
  const workOrderPath = resolve(root, "e2e-paperclip-workorder.json");
  writeFileSync(issuePath, `${JSON.stringify(issue, null, 2)}\n`);
  const start = jsonFrom(run([
    "start-from-paperclip",
    "--issue-json",
    issuePath,
    "--workorder-out",
    workOrderPath,
    "--repo-url",
    repo,
    "--working-dir",
    repo,
    "--repo-name",
    "e2e-fake-pr",
    "--change-type",
    "api",
    "--pr-backed",
    "true",
    "--user-visible",
    "true",
    "--user-flow",
    "false",
    "--browser-qa",
    "true",
    "--paperclip-evidence",
    "false",
    "--start",
    "true",
  ]));
  const generated = JSON.parse(readFileSync(workOrderPath, "utf8"));

  const blockedBeforePlan = run([
    "advance",
    "--run",
    start.runDir,
    "--stage",
    "In Progress",
    "--summary",
    "should require PLAN token",
  ], { allowFailure: true });
  run([
    "stage-token",
    "--run",
    start.runDir,
    "--token",
    "PLAN",
    "--verdict",
    "PASS",
    "--summary",
    "Plan approved for fake E2E",
  ]);
  const blockedBeforePlanReview = run([
    "advance",
    "--run",
    start.runDir,
    "--stage",
    "In Progress",
    "--summary",
    "should require one-shot planning challenge",
  ], { allowFailure: true });
  run([
    "iterate",
    "--run",
    start.runDir,
    "--loop",
    "plan-adversarial-review",
    "--verdict",
    "PASS",
    "--summary",
    "Planning team challenge recorded; no missing work found",
    "--feedback",
    "Planning team answered the one-shot challenge.",
  ]);
  run([
    "advance",
    "--run",
    start.runDir,
    "--stage",
    "In Progress",
    "--summary",
    "Implementation may begin after PLAN and one-shot review",
  ]);
  const blockedBeforeShipTokens = run([
    "advance",
    "--run",
    start.runDir,
    "--stage",
    "Ship to PR",
    "--summary",
    "should require typed build/verify/qa/security/no-mistakes tokens",
  ], { allowFailure: true });

  writeFileSync(resolve(repo, "feature.txt"), "fake e2e implementation\n");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "implement fake e2e feature"]);

  run([
    "run-tests",
    "--run",
    start.runDir,
    "--suite",
    "visible",
    "--phase",
    "post",
    "--expect",
    "pass",
    "--command-json",
    JSON.stringify(["node", "-e", "process.exit(0)"]),
  ]);
  const securityReport = resolve(root, "e2e-security-review.md");
  writeFileSync(securityReport, "# Security Review\n\nPASS\n");
  run([
    "evidence",
    "--run",
    start.runDir,
    "--kind",
    "security_review",
    "--path",
    securityReport,
    "--summary",
    "Security review evidence for fake E2E",
  ]);
  run([
    "record-gate",
    "--run",
    start.runDir,
    "--gate",
    "security_review",
    "--verdict",
    "PASS",
    "--summary",
    "Security review passed for fake E2E",
    "--path",
    securityReport,
  ]);
  const browserReport = resolve(root, "e2e-browser-smoke.md");
  const screenshot = resolve(root, "e2e-browser-smoke.png");
  writeFileSync(browserReport, "# Browser Smoke\n\nPASS\n");
  writeFileSync(screenshot, "fake browser smoke screenshot\n");
  run([
    "browser-qa",
    "--run",
    start.runDir,
    "--report",
    browserReport,
    "--screenshot",
    screenshot,
    "--summary",
    "Browser smoke evidence for user-visible API work",
    "--smoke",
    "true",
  ]);
  run([
    "no-mistakes",
    "--run",
    start.runDir,
    "--bin",
    "node",
    "--command-json",
    JSON.stringify(["-e", "process.exit(0)"]),
  ]);
  const improverReport = resolve(root, "e2e-improver.md");
  writeFileSync(improverReport, "# Improver no-op review E2E\n\nNo reusable lesson found for fake E2E conformance.\n");
  run([
    "evidence",
    "--run",
    start.runDir,
    "--kind",
    "improver_review",
    "--path",
    improverReport,
    "--summary",
    "Improver no-op review for fake E2E",
  ]);
  run([
    "record-gate",
    "--run",
    start.runDir,
    "--gate",
    "self_improvement",
    "--verdict",
    "PASS",
    "--summary",
    "Improver no-op review complete for fake E2E",
    "--details-json",
    JSON.stringify({ improverVerdict: "noop", owner: "self-improvement-lead", sourceCoverage: ["fake Telegram issue", "Foreman run", "gate evidence"], missingCoverage: "none" }),
    "--path",
    improverReport,
  ]);
  for (const token of ["BUILD", "VERIFY", "QA", "SECURITY", "NO_MISTAKES"]) {
    run([
      "stage-token",
      "--run",
      start.runDir,
      "--token",
      token,
      "--verdict",
      "PASS",
      "--summary",
      `${token} token passed for fake E2E`,
    ]);
  }
  run(["evidence-check", "--run", start.runDir]);
  run([
    "advance",
    "--run",
    start.runDir,
    "--stage",
    "Ship to PR",
    "--summary",
    "Fake E2E reached Ship to PR through typed Foreman tokens",
  ]);
  const manualPrGate = run([
    "record-gate",
    "--run",
    start.runDir,
    "--gate",
    "pr",
    "--verdict",
    "PASS",
    "--summary",
    "manual PR gate should be rejected",
  ], { allowFailure: true });
  const readyBeforePr = run(["ready", "--run", start.runDir]);
  const fakePr = run([
    "pr",
    "--run",
    start.runDir,
    "--title",
    "Fake E2E PR",
    "--body",
    "Fake E2E PR body",
    "--base",
    "stage",
    "--head",
    "dark-factory-conformance-E2E-FAKE-PR",
  ], {
    env: {
      DARK_FACTORY_GH_LOGIN: "Samueljug",
      DARK_FACTORY_CONFORMANCE_FAKE_PUBLISH: "true",
      DARK_FACTORY_FAKE_PR_URL: "https://github.com/dark-factory/conformance/pull/249",
    },
  });
  const readyWithPr = run(["ready", "--run", start.runDir, "--include-pr"]);
  const manifest = JSON.parse(readFileSync(resolve(start.runDir, "run-manifest.json"), "utf8"));

  return {
    runDir: start.runDir,
    checks: [
      { name: "fakeTelegramCreatesCanonicalWorkOrder", ok: generated.issue === issue.identifier && generated.taskRoute?.prBacked === true },
      { name: "fakeE2eRequiresBrowserSmokeForUserVisibleApi", ok: generated.evidenceRequirements?.includes("browser_smoke") && generated.gates?.browserQa === true },
      { name: "fakeE2eAdvanceRequiresPlanToken", ok: blockedBeforePlan.status !== 0 },
      { name: "fakeE2eAdvanceRequiresPlanChallenge", ok: blockedBeforePlanReview.status !== 0 },
      { name: "fakeE2eShipRequiresTypedTokens", ok: blockedBeforeShipTokens.status !== 0 },
      { name: "fakeE2eManualPrGateRejected", ok: manualPrGate.status !== 0 },
      { name: "fakeE2eReadyBeforePr", ok: readyBeforePr.status === 0 },
      { name: "fakeE2eForemanPrPathRecorded", ok: fakePr.status === 0 && manifest.gates?.pr?.verdict === "PASS" },
      { name: "fakeE2eReadyWithPr", ok: readyWithPr.status === 0 },
    ],
  };
}

function runCell(root, suffix) {
  const workOrderPath = makeWorkOrder(root, suffix);
  run(["validate", "--workorder", workOrderPath]);
  const start = jsonFrom(run(["start", "--workorder", workOrderPath]));
  const beforeReady = run(["ready", "--run", start.runDir], { allowFailure: true });
  if (beforeReady.status === 0) {
    throw new Error(`cell ${suffix} was ready before evidence was added`);
  }
  run([
    "evidence",
    "--run",
    start.runDir,
    "--kind",
    "review",
    "--path",
    "tools/dark-factory/README.md",
    "--summary",
    `Conformance evidence for cell ${suffix}`,
  ]);
  const invalidSelfImprovementGate = run([
    "record-gate",
    "--run",
    start.runDir,
    "--gate",
    "self_improvement",
    "--verdict",
    "PASS",
    "--summary",
    `Invalid empty improver gate for cell ${suffix}`,
    "--details-json",
    JSON.stringify({ improverVerdict: "noop", owner: " ", sourceCoverage: [], missingCoverage: "" }),
    "--path",
    "tools/dark-factory/README.md",
  ], { allowFailure: true });
  const improverReport = resolve(root, `improver-${suffix}.md`);
  writeFileSync(improverReport, `# Improver no-op review ${suffix}\n\nNo reusable lesson found for conformance cell ${suffix}.\n`);
  run([
    "evidence",
    "--run",
    start.runDir,
    "--kind",
    "improver_review",
    "--path",
    improverReport,
    "--summary",
    `Improver no-op review for cell ${suffix}`,
  ]);
  run([
    "record-gate",
    "--run",
    start.runDir,
    "--gate",
    "self_improvement",
    "--verdict",
    "PASS",
    "--summary",
    `Improver no-op review complete for cell ${suffix}`,
    "--details-json",
    JSON.stringify({ improverVerdict: "noop", owner: "self-improvement-lead", sourceCoverage: ["conformance run", "factory ledger", "run artifacts"], missingCoverage: "none" }),
    "--path",
    improverReport,
  ]);
  run(["evidence-check", "--run", start.runDir]);
  run(["ready", "--run", start.runDir]);
  const manifest = JSON.parse(readFileSync(resolve(start.runDir, "run-manifest.json"), "utf8"));
  return { suffix, workOrderPath, invalidSelfImprovementRejected: invalidSelfImprovementGate.status !== 0, ...start, manifest };
}

async function runParallelMutationCheck(runDir) {
  const browserReport = resolve(runDir, "parallel-browser-report.md");
  const browserShot = resolve(runDir, "parallel-browser-shot.png");
  writeFileSync(browserReport, "# Parallel Browser QA\n\nPASS\n");
  writeFileSync(browserShot, "fake screenshot bytes for conformance\n");
  const evidenceSummaries = [
    "parallel evidence one",
    "parallel evidence two",
    "parallel evidence three",
    "parallel evidence four",
  ];
  const gateSummaries = [
    ["security_review", "parallel security gate"],
    ["model_review", "parallel model review gate"],
  ];
  await Promise.all([
    ...evidenceSummaries.map((summary) => runAsync([
      "evidence",
      "--run",
      runDir,
      "--kind",
      "review",
      "--path",
      "tools/dark-factory/README.md",
      "--summary",
      summary,
    ])),
    ...gateSummaries.map(([gate, summary]) => runAsync([
      "record-gate",
      "--run",
      runDir,
      "--gate",
      gate,
      "--verdict",
      "PASS",
      "--summary",
      summary,
    ])),
    runAsync([
      "browser-qa",
      "--run",
      runDir,
      "--report",
      browserReport,
      "--screenshot",
      browserShot,
      "--summary",
      "parallel browser gate",
      "--smoke",
      "true",
    ]),
  ]);

  const manifest = JSON.parse(readFileSync(resolve(runDir, "run-manifest.json"), "utf8"));
  const evidencePack = JSON.parse(readFileSync(manifest.paths.evidencePack, "utf8"));
  const evidenceSummarySet = new Set((evidencePack.items || []).map((item) => item.summary));
  return {
    manifest,
    evidencePack,
    checks: [
      ...evidenceSummaries.map((summary) => ({
        name: `parallelEvidence:${summary}`,
        ok: evidenceSummarySet.has(summary),
      })),
      ...gateSummaries.map(([gate]) => ({
        name: `parallelGate:${gate}`,
        ok: Object.entries(manifest.gates || {}).some(([key, value]) => (
          (key === gate || key.startsWith(`${gate}_`)) && value?.verdict === "PASS"
        )),
      })),
      {
        name: "parallelGate:browser_qa",
        ok: manifest.gates?.browser_qa?.verdict === "PASS",
      },
    ],
  };
}

function runTestContractCell(root) {
  const repo = makeRepo(root, "TEST-CONTRACT");
  const workOrderPath = makeWorkOrder(root, "TEST-CONTRACT", {
    repo,
    mutate(workOrder) {
      workOrder.brief = "Prove Foreman-owned TestContracts block prose-only test gates and bind visible/holdout runs to the frozen oracle.";
      workOrder.gates.tests = true;
      workOrder.evidenceRequirements = ["test"];
      workOrder.allowedWriteScope = ["feature.txt"];
      workOrder.protectedPaths = ["holdouts/**", "test-contract.json"];
      workOrder.testExpectation = {
        required: true,
        baselineMustFail: true,
        authorBeforeImplementation: true,
        isolatedFromBuilder: true,
      };
      const command = [
        "node",
        "-e",
        "process.exit(require('node:fs').existsSync('feature.txt') ? 0 : 1)",
      ];
      workOrder.testContract = {
        schemaVersion: 1,
        required: true,
        frozen: true,
        authorRole: "verification-lead",
        createdAt: new Date().toISOString(),
        acceptanceCriteria: ["AC1"],
        suites: {
          visible: [
            {
              id: "visible-feature-file",
              level: "unit",
              summary: "Feature marker exists.",
              command,
              mapsTo: ["AC1"],
              redBeforeGreen: true,
            },
          ],
          holdout: [
            {
              id: "holdout-feature-file",
              level: "unit",
              summary: "Sealed holdout checks the same behavior through Foreman.",
              command,
              mapsTo: ["AC1"],
              sealed: true,
            },
          ],
        },
        expectedEvidence: ["test", "holdout_test"],
        protectedPaths: ["holdouts/**", "test-contract.json"],
      };
    },
  });
  run(["validate", "--workorder", workOrderPath]);
  const start = jsonFrom(run(["start", "--workorder", workOrderPath]));
  const manualTestGate = run([
    "record-gate",
    "--run",
    start.runDir,
    "--gate",
    "tests",
    "--verdict",
    "PASS",
    "--summary",
    "manual tests gate should be rejected",
  ], { allowFailure: true });
  run(["run-tests", "--run", start.runDir, "--suite", "visible", "--phase", "pre", "--expect", "fail"]);
  writeFileSync(resolve(repo, "feature.txt"), "implemented\n");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "implement feature marker"]);
  const missingHoldout = run(["ready", "--run", start.runDir], { allowFailure: true });
  run(["run-tests", "--run", start.runDir, "--suite", "visible", "--phase", "post", "--expect", "pass"]);
  run(["run-tests", "--run", start.runDir, "--suite", "holdout", "--phase", "post", "--expect", "pass"]);
  const improverReport = resolve(root, "improver-TEST-CONTRACT.md");
  writeFileSync(improverReport, "# Improver no-op review TEST-CONTRACT\n\nNo reusable lesson found for conformance test-contract cell.\n");
  run([
    "evidence",
    "--run",
    start.runDir,
    "--kind",
    "improver_review",
    "--path",
    improverReport,
    "--summary",
    "Improver no-op review for test-contract cell",
  ]);
  run([
    "record-gate",
    "--run",
    start.runDir,
    "--gate",
    "self_improvement",
    "--verdict",
    "PASS",
    "--summary",
    "Improver no-op review complete for test-contract cell",
    "--details-json",
    JSON.stringify({ improverVerdict: "noop", owner: "self-improvement-lead", sourceCoverage: ["conformance run", "test contract gates", "factory ledger", "run artifacts"], missingCoverage: "none" }),
    "--path",
    improverReport,
  ]);
  run(["evidence-check", "--run", start.runDir]);
  run(["ready", "--run", start.runDir]);
  const manifest = JSON.parse(readFileSync(resolve(start.runDir, "run-manifest.json"), "utf8"));
  return {
    runDir: start.runDir,
    checks: [
      { name: "manualTestsGateRejected", ok: manualTestGate.status !== 0 },
      { name: "holdoutRequiredBeforeReady", ok: missingHoldout.status !== 0 },
      { name: "testContractHashRecorded", ok: Boolean(manifest.testContractHash) },
      { name: "oracleBaselineGate", ok: manifest.gates?.oracle_baseline?.verdict === "PASS" },
      { name: "visibleTestsGate", ok: manifest.gates?.tests?.verdict === "PASS" },
      { name: "holdoutGate", ok: manifest.gates?.oracle_holdout?.verdict === "PASS" },
      { name: "selfImprovementGate", ok: manifest.gates?.self_improvement?.verdict === "PASS" },
    ],
  };
}

async function main() {
  const root = mkdtempSync(resolve(tmpdir(), "dark-factory-conformance-"));
  mkdirSync(root, { recursive: true });
  const a = runCell(root, "A");
  const b = runCell(root, "B");
  const parallelMutation = await runParallelMutationCheck(a.runDir);
  const testContract = runTestContractCell(root);
  const routeContract = runRouteContractCell(root);
  const stageToken = runStageTokenCell(root);
  const browserQa = runBrowserQaCell(root);
  const startFromPaperclip = runStartFromPaperclipCell(root);
  const publishIdentity = runPublishIdentityCell(root);
  const handoffWatchdog = runHandoffWatchdogCell(root);
  const quarantine = runQuarantineCell(root);
  const fakeE2e = runEndToEndFakeFactoryCell(root);
  const wikiDrift = runWikiDriftCell();
  const checks = [
    ["runDir", a.runDir !== b.runDir],
    ["evidencePack", a.manifest.paths.evidencePack !== b.manifest.paths.evidencePack],
    ["gatesDir", a.manifest.paths.gatesDir !== b.manifest.paths.gatesDir],
    ["noMistakesHome", a.manifest.paths.noMistakesHome !== b.manifest.paths.noMistakesHome],
    ["workOrderHash", a.workOrderHash === b.workOrderHash ? false : true],
    ["invalidSelfImprovementRejected", a.invalidSelfImprovementRejected && b.invalidSelfImprovementRejected],
    ...parallelMutation.checks.map((check) => [check.name, check.ok]),
    ...testContract.checks.map((check) => [check.name, check.ok]),
    ...routeContract.checks.map((check) => [check.name, check.ok]),
    ...stageToken.checks.map((check) => [check.name, check.ok]),
    ...browserQa.checks.map((check) => [check.name, check.ok]),
    ...startFromPaperclip.checks.map((check) => [check.name, check.ok]),
    ...publishIdentity.checks.map((check) => [check.name, check.ok]),
    ...handoffWatchdog.checks.map((check) => [check.name, check.ok]),
    ...quarantine.checks.map((check) => [check.name, check.ok]),
    ...fakeE2e.checks.map((check) => [check.name, check.ok]),
    ...wikiDrift.checks.map((check) => [check.name, check.ok]),
  ].map(([name, ok]) => ({ name, ok }));
  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    tempRoot: root,
    cells: [
      { suffix: a.suffix, runId: a.runId, runDir: a.runDir },
      { suffix: b.suffix, runId: b.runId, runDir: b.runDir },
    ],
    parallelMutation: {
      runDir: a.runDir,
      evidenceItems: parallelMutation.evidencePack.items.length,
      gates: Object.keys(parallelMutation.manifest.gates || {}).sort(),
    },
    testContract: {
      runDir: testContract.runDir,
    },
    routeContract,
    stageToken: {
      runDir: stageToken.runDir,
    },
    browserQa: {
      runDir: browserQa.runDir,
    },
    startFromPaperclip: {
      workOrderPath: startFromPaperclip.workOrderPath,
    },
    publishIdentity: {
      runDir: publishIdentity.runDir,
    },
    handoffWatchdog: {
      missingStatus: handoffWatchdog.missing.status,
      coveredRunCount: handoffWatchdog.covered.canonicalRuns.length,
    },
    quarantine: {
      dirtyRunDir: quarantine.dirtyRunDir,
      staleRunDir: quarantine.staleRunDir,
      sharedRunDirs: quarantine.sharedRunDirs,
    },
    fakeE2e: {
      runDir: fakeE2e.runDir,
    },
    wikiDrift: {
      ok: wikiDrift.report.ok,
      hard: wikiDrift.report.hard,
      warnCount: (wikiDrift.report.warn || []).length,
    },
    checks,
  }, null, 2));
  if (!ok) process.exit(1);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
