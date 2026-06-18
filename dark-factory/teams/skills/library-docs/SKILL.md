---
name: library-docs
description: Pull current, version-correct documentation for a library, framework, or API before coding against it, instead of relying on training-cutoff memory. Use whenever you are about to use or change a dependency (FastAPI, MongoEngine, Celery, Nuxt, Vue 3, PrimeVue, TanStack Query, a cloud SDK, a partner API) and want the real current signature/behavior. Keywords - docs, version, API, library, dependency, breaking change, current.
allowed-tools: Bash, Read
---

# Library Docs (current, not remembered)

Your training memory of fast-moving libraries drifts. Before you write or modify
code that calls a library, confirm the **current** API for the version this repo
actually uses. This single habit removes a whole class of "method doesn't exist /
signature changed / option renamed" bugs.

## Method

1. Pin the version. Read it from the repo, do not assume:
   - Python: `grep -i "<lib>" requirements*.txt pyproject.toml`
   - Node: `grep -i "<lib>" package.json` (and the lockfile for the resolved
     version).
2. Get the docs for **that** version:
   - Prefer the installed source as ground truth — inspect the package in
     `node_modules/<lib>` or the Python site-packages: read the actual signatures,
     types, and docstrings you will call.
   - Use web search for the official docs/changelog of that exact version when the
     installed source is not enough. Search like
     `"<lib> <version> <symbol>"` and read the primary/official source, not a
     blog.
3. Check the changelog/migration notes if the repo's version differs from what you
   remember — confirm the symbol still exists and the signature is unchanged.
4. Write against what you verified. If you could not verify a symbol, say so and
   do not guess it into the diff.

## When to use it

- New dependency usage, or a new call into an existing dependency.
- Any upgrade, or when behavior doesn't match your expectation.
- Partner/integration APIs (Clio, Smokeball, Actionstep, etc.) — read their
  current API docs before wiring a request or webhook.

Report the version you targeted and the source you confirmed against, so the
verifier can trust the call.
