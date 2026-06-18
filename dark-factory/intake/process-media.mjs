#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.join(SCRIPT_DIR, "state", "media-artifacts");

function parseArgs(argv) {
  const out = { inputs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out.inputs.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    if (key === "input") out.inputs.push(next);
    else out[key] = next;
    i += 1;
  }
  return out;
}

function enabled(value) {
  return value === "true" || value === "1" || value === "yes";
}

function disabled(value) {
  return value === "true" || value === "1" || value === "yes";
}

function cleanName(value) {
  return String(value || "media")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "media";
}

function resolvePath(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return path.resolve(text.startsWith("~") ? path.join(process.env.HOME || "", text.slice(1)) : text);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout || "";
}

function maybeRun(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function probe(input) {
  const output = run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    input,
  ]);
  return JSON.parse(output);
}

function hasVideo(probeData) {
  return (probeData.streams || []).some((stream) => stream.codec_type === "video");
}

function hasAudio(probeData) {
  return (probeData.streams || []).some((stream) => stream.codec_type === "audio");
}

function durationSeconds(probeData) {
  const raw = Number(probeData.format?.duration || 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function kindFor(input, probeData) {
  const ext = path.extname(input).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".avif"].includes(ext)) return "image";
  if (hasVideo(probeData)) return "video";
  if (hasAudio(probeData)) return "audio";
  return "document";
}

function frameTimes(duration, maxFrames) {
  if (!duration || duration <= 0) return [0];
  const count = Math.max(1, Math.min(maxFrames, Math.ceil(duration / 10)));
  if (count === 1) return [Math.min(1, duration / 2)];
  const last = Math.max(0, duration - 1);
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return 0;
    if (index === count - 1) return last;
    return Math.round((last * index) / (count - 1));
  });
}

function extractFrames(input, artifactDir, duration, maxFrames) {
  const framesDir = path.join(artifactDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true, mode: 0o700 });
  const frames = [];
  for (const seconds of frameTimes(duration, maxFrames)) {
    const label = `frame-${String(Math.round(seconds)).padStart(4, "0")}s`;
    const outPath = path.join(framesDir, `${label}.jpg`);
    run("ffmpeg", [
      "-y",
      "-ss", String(seconds),
      "-i", input,
      "-frames:v", "1",
      "-q:v", "2",
      outPath,
    ], { stdio: "pipe" });
    frames.push({
      label,
      time: `${Math.round(seconds)}s`,
      path: outPath,
      description: "Extracted key frame. Add a human/vision summary before orchestration when the visual detail matters.",
    });
  }
  return frames;
}

function transcribe(input, artifactDir, model) {
  const transcriptDir = path.join(artifactDir, "transcript");
  fs.mkdirSync(transcriptDir, { recursive: true, mode: 0o700 });
  const result = maybeRun("whisper", [
    input,
    "--model", model,
    "--output_format", "txt",
    "--output_dir", transcriptDir,
  ], { stdio: "pipe" });
  if (!result.ok) {
    return {
      transcript: null,
      transcriptPath: null,
      error: [result.stderr, result.stdout].filter(Boolean).join("\n").trim(),
    };
  }
  const txt = fs.readdirSync(transcriptDir)
    .filter((file) => file.endsWith(".txt"))
    .map((file) => path.join(transcriptDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!txt) return { transcript: null, transcriptPath: null, error: "Whisper completed but no txt output was found" };
  return {
    transcript: fs.readFileSync(txt, "utf8").trim(),
    transcriptPath: txt,
    error: null,
  };
}

function processInput(input, args, index) {
  const resolved = resolvePath(input);
  if (!resolved || !fs.existsSync(resolved)) throw new Error(`Input does not exist: ${input}`);
  const outRoot = resolvePath(args["out-dir"]) || DEFAULT_OUT_DIR;
  const artifactDir = path.join(outRoot, `${Date.now()}-${index + 1}-${cleanName(path.basename(resolved))}`);
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });

  const probeData = probe(resolved);
  const kind = kindFor(resolved, probeData);
  const duration = durationSeconds(probeData);
  const artifact = {
    kind,
    label: args.label || path.basename(resolved),
    source: args.source || null,
    path: resolved,
    description: args.description || null,
    attachments: [],
    screenshots: [],
  };

  if (kind === "video" && !disabled(args["no-frames"])) {
    artifact.screenshots = extractFrames(resolved, artifactDir, duration, Number(args["max-frames"] || 8));
  }

  if ((kind === "video" || kind === "audio") && hasAudio(probeData) && !disabled(args["no-transcribe"])) {
    const transcript = transcribe(resolved, artifactDir, args["whisper-model"] || "turbo");
    artifact.transcript = transcript.transcript;
    artifact.transcriptPath = transcript.transcriptPath;
    if (transcript.error) artifact.description = [artifact.description, `Transcription note: ${transcript.error}`].filter(Boolean).join("\n");
  }

  return artifact;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.inputs.length === 0) throw new Error("Usage: node tools/factory-intake/process-media.mjs --input /path/to/video.mp4 [--out-dir /path] [--no-transcribe] [--no-frames]");
  const artifacts = args.inputs.map((input, index) => processInput(input, args, index));
  const outRoot = resolvePath(args["out-dir"]) || DEFAULT_OUT_DIR;
  fs.mkdirSync(outRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(outRoot, `media-manifest-${Date.now()}.json`);
  const manifest = {
    schema: "openclaw.factory-intake.media-manifest.v1",
    createdAt: new Date().toISOString(),
    media: artifacts,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ manifestPath, ...manifest }, null, 2));
}

main();
