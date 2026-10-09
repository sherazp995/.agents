# Agent Dispatch Policy

Pick the specialist that matches the work. A generic agent is a last resort, not the default. This applies in Claude Code and in Codex: the specialists below are defined once in `~/.agents/agents/` and installed into both, under the same names.

**Blocked:** do NOT use `ruflo-*` subagent types or claude-flow (`npx @claude-flow/cli@latest ...`). Persist memory through the shared hub (`agents-hub memory`, see AGENTS.md).

## Specialists (Claude and Codex)

| Task signal | Agent |
|---|---|
| Ruby/Rails code, ActiveRecord, migrations, service objects, ViewComponent, Hotwire/Turbo/Stimulus, RSpec, Rails upgrades | `principal-rails-engineer` |
| React/Next.js, Stimulus, TypeScript, bundle/render perf, a11y, UI architecture, CSS/Tailwind | `principal-frontend-engineer` |
| Service decomposition, API contracts, queue/job design, Postgres schema/indexing/sharding, observability, consistency models | `principal-backend-engineer` |
| Rust systems, compilers, unsafe, FFI, performance-critical Rust, lifetimes/ABI decisions | `principal-rust-engineer` |

Other shared agents (`engineering-*`, `testing-api-tester`) cover narrower roles; their descriptions say when.

How to start one: in Claude Code, the Agent tool with that agent's name; in Codex, a sub-agent with that agent's name.

## Claude Code only

These are built into Claude Code. In Codex, do the same work directly or with a read-only sub-agent.

| Task signal | Agent |
|---|---|
| Locating code, "where is X", grep across repo (3 lookups or fewer: do it yourself) | `Explore` |
| Designing an implementation plan before touching code | `Plan` |
| Claude Code, Claude Agent SDK, or Anthropic API questions | `claude-code-guide` |
| Genuinely cross-cutting research with no specialist owner | `general-purpose` |

## Working across Claude and Codex

- **Second opinion from the other model:** from Claude, `codex exec --sandbox read-only -` with the prompt on stdin; from Codex, `claude -p "<prompt>"`. Treat its findings as candidates and re-prove them.
- **Several models on one task:** the `llm-council` skill (independent opinions, then a synthesis) and the `work-council` skill (plan, build, judge and verify across Claude and Codex).
- **Handing work to another session or agent:** `agents-hub handoff <agent> <session>` writes a brief the other side can read; long-running parallel builds each get their own git worktree.
- **Shared state:** every session reads and writes the same memory (`agents-hub memory`) and can search every other session's chats (`agents-hub search`).

## How to Apply

**Detect stack from repo, not memory.** `Gemfile` / `*.rb` → `principal-rails-engineer`. `Cargo.toml` / `*.rs` → `principal-rust-engineer`. `package.json` with React/Next → `principal-frontend-engineer`. Service-shaped repos → `principal-backend-engineer`.

**Frontend work in a server-rendered repo** still routes to `principal-frontend-engineer` for JS/Stimulus/ViewComponent/CSS specifics. Pair it with the server-side specialist rather than collapsing both into a generic agent.

**Parallel dispatch:** if a task spans backend and frontend, send two specialists in parallel, not one generalist. Give each a disjoint set of files.

**Code review:** use the `general-review` skill (rule 44). It always spawns a fresh lead agent to do the review, so the reviewer never wrote or discussed the change; the invoking session only coordinates.

**Don't fall back to a generic agent because the prompt feels small.** Small Rails tweaks still go to `principal-rails-engineer`; it knows the global rules 1 to 16 and 38 to 40 cold.

**If unsure between two specialists,** state the choice in one line and proceed. Don't ask the user to triage routing.
