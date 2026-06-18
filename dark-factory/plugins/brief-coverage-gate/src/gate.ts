// Pure, host-independent gate logic. Kept separate from worker.ts so it can be
// unit-tested without the Paperclip runtime.

// Pull the first fenced code block that parses as JSON (prefer ```json).
export function extractJsonBlock(body: string | null | undefined): any | null {
  if (!body) return null;
  const fences = [...body.matchAll(/```(\w+)?\s*\n([\s\S]*?)```/g)];
  const ordered = [
    ...fences.filter((m) => (m[1] || "").toLowerCase() === "json"),
    ...fences.filter((m) => (m[1] || "").toLowerCase() !== "json"),
  ];
  for (const m of ordered) {
    try {
      return JSON.parse((m[2] || "").trim());
    } catch {
      /* try the next block */
    }
  }
  return null;
}

// Reasons the brief-artifact-manifest is incomplete (empty array === complete).
export function evaluateManifest(body: string | null): string[] {
  const reasons: string[] = [];
  const j = extractJsonBlock(body);
  if (!j || typeof j !== "object") {
    reasons.push(
      "brief-artifact-manifest has no machine-readable ```json block",
    );
    return reasons;
  }
  if (j.complete !== true) {
    reasons.push(
      "brief-artifact-manifest is not marked complete (brief / plan / scope not fully filled)",
    );
  }
  const media = Array.isArray(j.media_artifacts) ? j.media_artifacts : [];
  for (const a of media) {
    if (a && a.extracted_text_present !== true) {
      reasons.push(
        `media artifact ${a?.id ?? "(unknown)"} has no extracted_text — transcribe it before advancing`,
      );
    }
  }
  return reasons;
}

// Reasons the coverage-matrix is not clean (empty array === clean).
export function evaluateCoverage(body: string | null): string[] {
  const reasons: string[] = [];
  if (!body || !body.trim()) {
    reasons.push(
      "coverage-matrix document is missing — Implementation must produce it",
    );
    return reasons;
  }
  const j = extractJsonBlock(body);
  if (!j) {
    reasons.push("coverage-matrix has no machine-readable ```json block");
    return reasons;
  }
  const rows = Array.isArray(j) ? j : Array.isArray(j.rows) ? j.rows : null;
  if (!rows) {
    reasons.push("coverage-matrix ```json block has no `rows` array");
    return reasons;
  }
  let uncovered = 0;
  let offtrack = 0;
  for (const r of rows) {
    const status = String(r?.status ?? "").toLowerCase();
    const required = r?.required !== false; // default: required
    const waived = r?.waived === true;
    if (status === "uncovered" && required) uncovered++;
    if (status === "off_track" && !waived) offtrack++;
  }
  if (uncovered > 0)
    reasons.push(
      `${uncovered} required item(s) still \`uncovered\` in coverage-matrix`,
    );
  if (offtrack > 0)
    reasons.push(`${offtrack} \`off_track\` row(s) without a recorded waiver`);
  return reasons;
}

// Combined verdict for an issue's manifest + coverage document bodies.
export function evaluate(
  manifestBody: string | null,
  coverageBody: string | null,
): { ok: boolean; reasons: string[] } {
  const reasons = [
    ...evaluateManifest(manifestBody),
    ...evaluateCoverage(coverageBody),
  ];
  return { ok: reasons.length === 0, reasons };
}

// Resolve the issue id from a Paperclip domain event (issue.* vs run.*).
export function resolveIssueId(event: any): string | undefined {
  if (event?.entityType === "issue" && event?.entityId) return event.entityId;
  const p = event?.payload ?? {};
  return (
    p.issueId ||
    p.issue?.id ||
    (event?.entityType === "issue" ? event?.entityId : undefined)
  );
}
