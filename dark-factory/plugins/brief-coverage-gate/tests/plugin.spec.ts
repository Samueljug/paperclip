import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import {
  evaluate,
  evaluateCoverage,
  evaluateManifest,
  extractJsonBlock,
  resolveIssueId,
} from "../src/gate.js";

const manifestOk = [
  "# Brief & Artifact Manifest",
  "```json",
  JSON.stringify({
    complete: true,
    media_artifacts: [{ id: "A1", extracted_text_present: true }],
  }),
  "```",
].join("\n");

const coverageOk = [
  "# Coverage Matrix",
  "| item | status |",
  "| B1 | covered |",
  "```json",
  JSON.stringify({
    rows: [{ item_id: "B1", status: "covered", required: true }],
  }),
  "```",
].join("\n");

describe("manifest", () => {
  it("declares the capabilities the worker uses", () => {
    for (const cap of [
      "events.subscribe",
      "issue.documents.read",
      "issue.relations.write",
      "issue.comments.create",
      "issues.create",
    ]) {
      expect(manifest.capabilities).toContain(cap);
    }
  });
});

describe("extractJsonBlock", () => {
  it("parses a ```json fence", () => {
    expect(extractJsonBlock('x\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
  });
  it("returns null when there is no parseable block", () => {
    expect(extractJsonBlock("no fences here")).toBeNull();
    expect(extractJsonBlock("```json\nnot json\n```")).toBeNull();
  });
});

describe("evaluateManifest", () => {
  it("passes a complete manifest with transcribed media", () => {
    expect(evaluateManifest(manifestOk)).toEqual([]);
  });
  it("flags a missing json block", () => {
    expect(evaluateManifest("# manifest only prose")).toHaveLength(1);
  });
  it("flags complete:false", () => {
    const body = "```json\n" + JSON.stringify({ complete: false }) + "\n```";
    expect(evaluateManifest(body).join(" ")).toMatch(/not marked complete/);
  });
  it("flags un-transcribed media (the video problem)", () => {
    const body =
      "```json\n" +
      JSON.stringify({
        complete: true,
        media_artifacts: [{ id: "A1", extracted_text_present: false }],
      }) +
      "\n```";
    expect(evaluateManifest(body).join(" ")).toMatch(/A1.*no extracted_text/);
  });
});

describe("evaluateCoverage", () => {
  it("passes a clean matrix", () => {
    expect(evaluateCoverage(coverageOk)).toEqual([]);
  });
  it("blocks a missing coverage document", () => {
    expect(evaluateCoverage(null).join(" ")).toMatch(/missing/);
  });
  it("blocks an uncovered required item", () => {
    const body =
      "```json\n" +
      JSON.stringify({
        rows: [{ item_id: "B1", status: "uncovered", required: true }],
      }) +
      "\n```";
    expect(evaluateCoverage(body).join(" ")).toMatch(/uncovered/);
  });
  it("ignores an uncovered NON-required item", () => {
    const body =
      "```json\n" +
      JSON.stringify({
        rows: [{ item_id: "B9", status: "uncovered", required: false }],
      }) +
      "\n```";
    expect(evaluateCoverage(body)).toEqual([]);
  });
  it("blocks an unwaived off_track row but allows a waived one", () => {
    const blocked =
      "```json\n" +
      JSON.stringify({ rows: [{ item_id: "X", status: "off_track" }] }) +
      "\n```";
    expect(evaluateCoverage(blocked).join(" ")).toMatch(/off_track/);
    const waived =
      "```json\n" +
      JSON.stringify({
        rows: [{ item_id: "X", status: "off_track", waived: true }],
      }) +
      "\n```";
    expect(evaluateCoverage(waived)).toEqual([]);
  });
  it("does NOT trip on the column legend words in prose (markdown-parse safety)", () => {
    // The human table mentions 'uncovered' / 'off_track' as legend text; only the json block counts.
    expect(evaluate(manifestOk, coverageOk)).toEqual({ ok: true, reasons: [] });
  });
});

describe("resolveIssueId", () => {
  it("uses entityId for issue.* events", () => {
    expect(resolveIssueId({ entityType: "issue", entityId: "iss_1" })).toBe(
      "iss_1",
    );
  });
  it("falls back to payload.issueId for run.* events", () => {
    expect(
      resolveIssueId({
        entityType: "run",
        entityId: "run_1",
        payload: { issueId: "iss_2" },
      }),
    ).toBe("iss_2");
  });
});
