#!/usr/bin/env node
import { mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const outDir = resolve(pkgRoot, "dist", "screenshots");
const screensDir = resolve(pkgRoot, "screenshots");

mkdirSync(outDir, { recursive: true });
mkdirSync(screensDir, { recursive: true });

const entry = resolve(__dirname, "entry.tsx");
const repoRoot = resolve(pkgRoot, "..", "..", "..");
const reactPath = resolve(repoRoot, "node_modules/.pnpm/react@19.2.4/node_modules/react");
const reactDomPath = resolve(repoRoot, "node_modules/.pnpm/react-dom@19.2.4_react@19.2.4/node_modules/react-dom");

console.log("Bundling triage screenshot harness…");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: resolve(outDir, "bundle.js"),
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  alias: {
    react: reactPath,
    "react-dom": reactDomPath,
    "react-dom/client": resolve(reactDomPath, "client.js"),
    "react/jsx-runtime": resolve(reactPath, "jsx-runtime.js"),
  },
});

copyFileSync(resolve(__dirname, "index.html"), resolve(outDir, "index.html"));

const desktopViewport = { width: 1440, height: 920 };
const mobileViewport = { width: 390, height: 844 };

const desktopTargets = [
  { slug: "01-queue-list", path: "/PAP/triage", view: "page" },
  { slug: "02-queue-overview", path: "/PAP/triage/q/content-training", view: "page" },
  { slug: "03-item-workbench", path: "/PAP/triage/q/content-training/i/item-142", view: "page" },
  { slug: "04-workflow", path: "/PAP/triage/q/content-training/workflow", view: "page" },
  { slug: "05-guidance", path: "/PAP/triage/q/content-training/guidance", view: "page" },
  { slug: "06-transitions", path: "/PAP/triage/q/content-training/transitions", view: "page" },
  { slug: "07-settings", path: "/PAP/triage", view: "settings" },
  { slug: "08-sidebar-link", path: "/PAP/triage", view: "sidebar" },
  { slug: "09-route-sidebar", path: "/PAP/triage/q/content-training", view: "route-sidebar" },
];

const mobileTargets = desktopTargets.map((target) => ({
  ...target,
  slug: `mobile/${target.slug}`,
  viewport: mobileViewport,
}));

const targets = [
  ...desktopTargets.map((target) => ({ ...target, viewport: desktopViewport })),
  ...mobileTargets,
];

const playwrightPrimary = resolve(pkgRoot, "node_modules/playwright/index.mjs");
const playwrightFallback = resolve(repoRoot, "node_modules", ".pnpm", "playwright@1.58.2", "node_modules", "playwright", "index.mjs");
let playwrightModuleHref = pathToFileURL(playwrightPrimary).href;
if (!existsSync(playwrightPrimary)) {
  if (existsSync(playwrightFallback)) {
    playwrightModuleHref = pathToFileURL(playwrightFallback).href;
  } else {
    throw new Error("Cannot locate playwright module — install dev deps first");
  }
}
const { chromium } = await import(playwrightModuleHref);

const mimeFor = (ext) => ({
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
})[ext] ?? "application/octet-stream";

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const ext = extname(requestedPath);
  // Always serve index.html for SPA routes (no extension)
  const candidate = ext ? resolve(outDir, "." + requestedPath) : resolve(outDir, "./index.html");
  try {
    const body = readFileSync(candidate);
    res.writeHead(200, { "Content-Type": mimeFor(extname(candidate)) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found: " + candidate);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: desktopViewport, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") {
    console.log(`  [console.${msg.type()}]`, msg.text());
  }
});
page.on("pageerror", (err) => console.error("  [pageerror]", err.message));

for (const target of targets) {
  const url = `${baseUrl}${target.path}#${target.view}`;
  console.log(`→ rendering ${target.slug} (${url})`);
  await page.setViewportSize(target.viewport);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(150);
  const outFile = resolve(screensDir, `${target.slug}.png`);
  mkdirSync(dirname(outFile), { recursive: true });
  await page.screenshot({ path: outFile, fullPage: true });
  console.log(`  saved ${outFile}`);
}

await browser.close();
server.close();
console.log("Done. Screenshots in", screensDir);
