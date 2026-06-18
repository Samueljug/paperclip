# Copy And Content Lane Protocol

Use this lane when a Dark Factory task creates or materially changes:

- website copy, landing pages, pricing pages, service pages, or static marketing
  content
- blog posts, explainers, lead magnets, sales enablement, or campaign content
- headlines, CTAs, offer framing, objection handling, or conversion copy
- customer-facing claims where proof, positioning, or compliance risk matters

## Routing

- Keep the original ticket and accepted task scope as the authority.
- Route website and landing-page copy through the local Claude CLI
  `/quillio-website-copywriter` skill when available.
- Route blog/content work through `/quillio-blog-copywriter` when available.
- Route sales-offer, objection, and funnel copy through
  `/quillio-sales-orchestrator` when available.
- If the preferred skill is unavailable, record the degraded path and use a
  bounded copy review by `planning-lead`, `research-lead`, or a Claude/Codex
  reviewer instead of silently skipping copy review.

## Required Evidence

Before PR, save a copy proof packet in the run folder or as Foreman evidence:

```text
copy_brief:
target_audience:
offer_or_page_goal:
claims_made:
proof_or_source_for_each_claim:
unsupported_or_risky_claims:
positioning_assumptions:
compliance_or_ethics_notes:
recommended_human_review_items:
```

If the copy adds a factual, legal, pricing, customer-result, capability, or
comparison claim, the packet must say where the proof came from or mark the
claim as a gap. A claim gap is not automatically a blocker, but it must be
visible before PR/human review.

## Scope Boundary

Copy agents may suggest unrelated improvements, but they must not rewrite other
pages, broaden product positioning, change design, or edit implementation
outside the accepted task. Put useful out-of-scope ideas into the Foreman
`left-aside` artifact or a separate Paperclip ticket.
