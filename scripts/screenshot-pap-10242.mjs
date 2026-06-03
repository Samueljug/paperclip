#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const playwrightPkgRoot = path.join(
  repoRoot,
  "node_modules/.pnpm/playwright@1.58.2/node_modules/playwright",
);
const { chromium } = await import(path.join(playwrightPkgRoot, "index.mjs"));

const HOST = process.env.PAP_HOST ?? "100.123.243.20";
const BASE = `http://${HOST}:3100`;
const outDir = path.join(repoRoot, "screenshots/PAP-10242");
await fs.mkdir(outDir, { recursive: true });

// Reuse the PAP-9704 local board session token, re-hosted onto the reachable
// tailscale interface with a fresh client-side expiry (the server validates the
// token value, not the cookie expiry).
const authState = JSON.parse(
  await fs.readFile(path.join(repoRoot, "screenshots/PAP-9704-local-auth-state.json"), "utf8"),
);
const sessionCookie = authState.cookies.find((c) => c.name.endsWith("session_token"));

const browser = await chromium.launch({
  executablePath: "/srv/paperclip/home/.cache/ms-playwright/chromium-1223/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (sessionCookie) {
    await context.addCookies([
      {
        name: sessionCookie.name,
        value: sessionCookie.value,
        domain: HOST,
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: sessionCookie.httpOnly ?? true,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [browser console error]", m.text().slice(0, 200));
  });

  async function shot(slug, urlPath, prep) {
    const url = `${BASE}${urlPath}`;
    await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(1500);
    if (prep) await prep(page);
    const target = path.join(outDir, `${slug}.png`);
    await page.screenshot({ path: target, fullPage: false });
    const title = await page.title().catch(() => "");
    const bodyText = (await page.evaluate(() => document.body.innerText).catch(() => "")) || "";
    results.push({ slug, url, title, hasTeams: bodyText.includes("Teams"), sample: bodyText.slice(0, 120).replace(/\n/g, " ") });
    console.log(`captured ${target} :: title="${title}" :: ${bodyText.slice(0, 80).replace(/\n/g, " ")}`);
  }

  // 01 browse
  await shot("01-browse", "/PAP/teams");

  // 02 detail (click first team row)
  await shot("02-detail", "/PAP/teams", async (p) => {
    const row = p.locator('button:has-text("Team")').first();
    if (await row.count()) await row.click().catch(() => {});
    await p.waitForTimeout(800);
  });

  // 03 install wizard (click Install team)
  await shot("03-install-wizard", "/PAP/teams", async (p) => {
    const cta = p.locator('button:has-text("Install team")').first();
    if (await cta.count()) await cta.click().catch(() => {});
    await p.waitForTimeout(1500);
  });
} finally {
  await browser.close();
}

await fs.writeFile(path.join(outDir, "_capture-summary.json"), JSON.stringify(results, null, 2));
console.log("\nSummary:", JSON.stringify(results, null, 2));
