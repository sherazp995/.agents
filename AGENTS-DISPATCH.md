# Agent Dispatch Policy

There are no per-language agents. Expertise lives in skills, which load only when the work needs them, in the session or in any subagent. This applies in Claude Code and in Codex: skills live once in `~/.agents/skills/` and both see them.

**Blocked:** do not use `ruflo-*` subagent types or claude-flow (`npx @claude-flow/cli@latest ...`); memory persists through the shared hub instead (`agents-hub memory`, see AGENTS.md).

## Stack skills (Claude and Codex)

| Task signal | Skill |
|---|---|
| Ruby/Rails code, ActiveRecord, migrations, service objects, ViewComponent, Hotwire/Turbo/Stimulus wiring, RSpec, gems, Rails upgrades | `rails-engineering` |
| React/Next.js, Stimulus, TypeScript, CSS/Tailwind, accessibility, bundle and render performance, UI architecture | `frontend-engineering` |
| Service boundaries, API contracts, jobs and queues, Postgres schema, indexes and query plans, caching, consistency, observability | `backend-engineering` |
| Rust systems, unsafe, FFI, lifetimes, performance-critical Rust, compiler and runtime work (riven) | `rust-engineering` |
| CI/CD, infrastructure as code, containers, deploy strategies, secrets, monitoring, SLOs, incidents | `devops-sre` |
| Writing or trimming tests | `writing-specs` |
| Any planning phase (before a plan, plan mode, work-council), or "interview me"; it runs in the session, before any `Plan` agent | `interview-me` |
| A failing test, broken build, regression or bug report | `debugging` |
| Setting or guarding a project's quality bar, or a repo with `CONSTRAINTS.md` | `constraint-driven` |
| Writing any chat reply to the user, or "sound more human", "less robotic" | `human-conversation` |
| Messaging the user on Slack (`relay notify`): done, blocked or a decision while they are away | `relay` |
| "autonomous", `/autonomous`, "build the approved plans while I'm away", from the terminal or a Slack thread | `autonomous` |
| iOS or Android UI | `mobile-design` |

A change across stacks loads each matching skill. A subagent you start gets the skill names in its brief.

## Claude Code only

These are built into Claude Code. In Codex, do the same work directly or with a read-only sub-agent.

| Task signal | Agent |
|---|---|
| Locating code, "where is X", grep across repo (3 lookups or fewer: do it yourself) | `Explore` |
| Drafting an implementation plan once the session has settled the intent | `Plan` |
| Claude Code, Claude Agent SDK, or Anthropic API questions | `claude-code-guide` |
| Genuinely cross-cutting research no skill covers | `general-purpose` |

## Working across Claude and Codex

- **Second opinion from the other model:** from Claude, `codex exec --sandbox read-only -` with the prompt on stdin; from Codex, `claude -p "<prompt>"`. Treat its findings as candidates and re-prove them.
- **Several models on one task:** the `llm-council` skill (independent opinions, then a synthesis) and the `work-council` skill (Claude and Codex as one team: one plan shaped by both, each builds its own parts, each reviews the other, both sign off).
- **Handing work to another session or agent:** `agents-hub handoff <agent> <session>` writes a brief the other side can read; long-running parallel builds each get their own git worktree.
- **Shared state:** every session reads and writes the same memory (`agents-hub memory`) and can search every other session's chats (`agents-hub search`).

## How to Apply

**Detect stack from repo, not memory.** `Gemfile` / `*.rb` → `rails-engineering`. `Cargo.toml` / `*.rs` → `rust-engineering`. `package.json` with React/Next, or Stimulus controllers → `frontend-engineering`. Service-shaped repos → `backend-engineering`. Pipelines and infrastructure → `devops-sre`.

**Parallel work:** a build split into parallel parts follows `doing-substantial-work` step 3; each part is a general-purpose subagent told which stack skill to load.

**Code review:** use the `general-review` skill (rule 44). It always spawns a fresh lead agent to do the review, so the reviewer never wrote or discussed the change; the invoking session only coordinates.

**If unsure which skill applies,** load both. Don't ask the user to triage routing.
