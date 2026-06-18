# Core Development Policy Protocol

Samuel's core development policy source is:

```text
https://github.com/aila-code/devpolicy-legal
branch: dev
local parent for policy update work: /Users/samuelimini/Development/Dev
```

The repo is private. GitHub access is expected through Samuel's authenticated
`gh` / HTTPS git credentials.

## How Agents Use It

- Treat `aila-code/devpolicy-legal` as the source of truth for development
  policy, Claude-style commands, review agents, reusable skills, React rules,
  pre-PR playbooks, and coding standards.
- Before significant coding, review, security, PR, or policy-improvement work,
  consult the latest relevant files from the `dev` branch when the local task
  could be affected by shared policy.
- Do not copy large policy sections into task prompts. Pull only the relevant
  guide, skill, command, or rule file needed for the task.
- When policy conflicts with a direct Samuel instruction, pause and ask
  OpenClaw/Samuel to resolve the conflict.

Useful current paths in the policy repo include:

```text
.claude/commands/
.claude/agents/
.claude/skills/
docs/guides/implementation-guide.md
docs/guides/pre-pr-quality-playbook.md
react/AGENTS.md
react/CLAUDE.md
react/skills/react-best-practices/
```

## Updating The Policy

When the team finds a better way of doing things, do not leave it only in chat
or local memory.

Use the review-to-skill protocol to collect evidence, then propose one of:

- Skill Workshop proposal for OpenClaw/Pi behavior.
- PR to `aila-code/devpolicy-legal` when the improvement should become core
  development policy.
- Both, when the same improvement affects agent behavior and the shared policy
  toolkit.

Policy repo update workflow:

1. Use a fresh folder under `/Users/samuelimini/Development/Dev`.
2. Clone `https://github.com/aila-code/devpolicy-legal`.
3. Checkout and pull `dev`.
4. Create a feature branch.
5. Update the narrowest relevant policy/skill/command/docs file.
6. Run any documented checks for that repo.
7. Open a PR back to `dev` and include the evidence that motivated the update.

Do not push direct changes to `dev` unless Samuel explicitly asks.
