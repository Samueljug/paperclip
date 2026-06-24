import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDescription,
  buildMediaEvidenceSection,
  collectAttachmentFiles,
  mediaArtifactsFromArgs,
  normalizeMediaArtifact,
} from "./factory-intake.mjs";

test("media artifacts render transcript, frames, and notes into the issue description", () => {
  const artifact = normalizeMediaArtifact({
    kind: "video",
    label: "bug reproduction",
    source: "telegram:file/example",
    path: "/tmp/repro.mp4",
    transcript: "Clicking Save leaves the screen stuck.",
    screenshots: [
      { time: "10s", path: "/tmp/frame-10s.jpg", description: "Save button was clicked." },
      { time: "20s", path: "/tmp/frame-20s.jpg", description: "Spinner remains visible." },
    ],
  });

  const section = buildMediaEvidenceSection([artifact]);
  assert.match(section, /## Media Evidence/);
  assert.match(section, /Source: telegram:file\/example/);
  assert.match(section, /Clicking Save leaves the screen stuck/);
  assert.match(section, /Spinner remains visible/);

  const description = buildDescription(
    { brief: "TASK: Fix save flow", dedupKey: "dedup-1", index: 0 },
    {},
    [artifact],
  );
  assert.match(description, /## Media Evidence/);
  assert.match(description, /Downstream agents should rely on this written evidence first/);
});

test("media manifest args accept a JSON file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-intake-media-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    media: [
      { kind: "image", label: "screenshot", path: "/tmp/screenshot.png", ocr: "Error: save failed" },
    ],
  }));

  const artifacts = mediaArtifactsFromArgs({ "media-manifest": manifestPath });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "image");
  assert.equal(artifacts[0].ocr, "Error: save failed");
});

test("attachment collection includes originals, transcripts, frames, and extra files once", () => {
  const artifact = normalizeMediaArtifact({
    kind: "video",
    path: "/tmp/repro.mp4",
    transcriptPath: "/tmp/repro.txt",
    screenshots: [{ path: "/tmp/frame.jpg" }],
    attachments: ["/tmp/frame.jpg", "/tmp/notes.md"],
  });

  assert.deepEqual(
    collectAttachmentFiles([artifact]).map((file) => file.path),
    ["/tmp/repro.mp4", "/tmp/repro.txt", "/tmp/frame.jpg", "/tmp/notes.md"],
  );
});
