import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOAuthAccountUsageReport,
  oauthAccountUsageInternals,
} from "../services/oauth-account-usage.js";

let tmpRoot: string | null = null;

async function tempHome() {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-oauth-usage-"));
  return tmpRoot;
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, value: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
}

afterEach(async () => {
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe("oauth account usage service", () => {
  it("redacts secret-shaped evidence text", () => {
    const redacted = oauthAccountUsageInternals.safeEvidenceLine(
      'Authorization: Bearer sk-live-token and {"refresh_token":"secret-refresh"}',
    );
    expect(redacted).not.toContain("sk-live-token");
    expect(redacted).not.toContain("secret-refresh");
    expect(redacted).toContain("***REDACTED***");
  });

  it("classifies quota exhaustion and reset evidence from Antigravity logs", () => {
    const parsed = oauthAccountUsageInternals.parseLogEvidence([
      {
        path: "~/.gemini/antigravity-cli/log/cli.log",
        line: "I0613 OAuth: authenticated successfully as user@example.test",
        mtimeMs: 1,
      },
      {
        path: "~/.gemini/antigravity-cli/log/cli.log",
        line: 'I0613 model_config_manager.go:157] Propagating selected model override to backend: label="Gemini 3.5 Flash (High)"',
        mtimeMs: 2,
      },
      {
        path: "~/.gemini/antigravity-cli/log/cli.log",
        line: "E0613 RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h46m11s.",
        mtimeMs: 3,
      },
    ]);

    expect(parsed.accountIdentifier).toBe("user@example.test");
    expect(parsed.selectedModel).toBe("Gemini 3.5 Flash (High)");
    expect(parsed.quotaExhausted).toBe(true);
    expect(parsed.quotaResetInfo).toBe("Resets in 1h46m11s");
  });

  it("dedupes Gemini local chat-log rows without returning message text", async () => {
    const home = await tempHome();
    await writeJson(path.join(home, ".gemini", "tmp", "project-a", "logs.json"), [
      {
        sessionId: "session-1",
        messageId: 1,
        type: "user",
        message: "secret prompt should not be returned",
        timestamp: "2026-06-13T00:00:00.000Z",
        model: "gemini-2.5-pro",
      },
      {
        sessionId: "session-1",
        messageId: 1,
        type: "user",
        message: "duplicate",
        timestamp: "2026-06-13T00:00:00.000Z",
        model: "gemini-2.5-pro",
      },
    ]);

    const summary = await oauthAccountUsageInternals.summarizeGeminiLocalUsage(path.join(home, ".gemini"), home);

    expect(summary).toMatchObject({
      sessions: 1,
      messages: 1,
      dedupedRows: 1,
      models: ["gemini-2.5-pro"],
    });
    expect(JSON.stringify(summary)).not.toContain("secret prompt");
  });

  it("builds a deterministic report from local fixtures and quota snapshots", async () => {
    const home = await tempHome();
    await writeJson(path.join(home, ".gemini", "antigravity-cli", "settings.json"), {
      model: "Gemini 3.5 Flash (High)",
    });
    await writeText(
      path.join(home, ".gemini", "antigravity-cli", "log", "cli.log"),
      [
        "I0613 OAuth: authenticated successfully as agy@example.test",
        'I0613 model_config_manager.go:157] Propagating selected model override to backend: label="Gemini 3.5 Flash (High)"',
        "E0613 RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h14m17s.",
      ].join("\n"),
    );
    await writeJson(path.join(home, ".gemini", "settings.json"), {
      security: { auth: { selectedType: "oauth-personal" } },
    });
    await writeJson(path.join(home, ".gemini", "google_accounts.json"), {
      active: "gemini@example.test",
    });
    await writeJson(path.join(home, ".gemini", "oauth_creds.json"), {
      access_token: "must-not-leak",
      refresh_token: "must-not-leak",
    });

    const report = await buildOAuthAccountUsageReport({
      homeDir: home,
      now: new Date("2026-06-13T01:02:03.000Z"),
      quotaResults: [
        {
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [{ label: "5h limit", usedPercent: 42, resetsAt: null, valueLabel: null }],
        },
      ],
      readCodexInfo: async () => ({
        accountId: "acct_123",
        email: "codex@example.test",
        planType: "plus",
      }),
      readClaudeStatus: async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    });

    expect(report.checkedAt).toBe("2026-06-13T01:02:03.000Z");
    expect(report.accounts).toHaveLength(4);
    expect(report.accounts.find((row) => row.tool === "Antigravity agy")).toMatchObject({
      accountIdentifier: "agy@example.test",
      selectedModel: "Gemini 3.5 Flash (High)",
      usabilityStatus: "quota_exhausted",
      quotaResetInfo: "Resets in 2h14m17s",
    });
    expect(report.accounts.find((row) => row.tool === "Codex CLI")?.quotaWindows[0]?.usedPercent).toBe(42);
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
  });
});
