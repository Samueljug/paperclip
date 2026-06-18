#!/usr/bin/env node
// conductor-build.mjs — safe Telegram/Dr-Claw entry point to the Conductor.
// Defaults the target to the private throwaway sandbox repo and prints a single
// PR-URL line. Production repos remain HARD-REFUSED by conductor.mjs itself
// (its PROD_REPOS guard) — this wrapper never passes --allow-prod.
//
// USAGE: node conductor-build.mjs <task text...>
//   (everything after the script name is the task)

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = "https://github.com/Samueljug/df-conductor-sandbox.git";
const BASE = "main";

const task = process.argv.slice(2).join(" ").trim();
if (!task) {
  console.log("usage: /build <what to build>  (e.g. /build add a slugify() helper to string.js with a test)");
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const conductor = path.join(HERE, "conductor.mjs");

console.log(`🏭 Building on df-conductor-sandbox: ${task}`);
try {
  const out = execFileSync(
    "node",
    [conductor, "--repo", SANDBOX, "--base", BASE, "--task", task, "--test", "node test.js"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  const m =
    out.match(/"url":\s*"(https:\/\/github\.com\/[^"]+)"/) ||
    out.match(/PR opened:\s*(https:\/\/\S+)/);
  if (m) console.log(`✅ Shipped a PR: ${m[1]}`);
  else console.log("✅ Build finished. Tail:\n" + out.slice(-500));
} catch (e) {
  const log = ((e.stdout || "") + (e.stderr || "")).slice(-500);
  console.log("❌ Build failed:\n" + log);
  process.exit(1);
}
