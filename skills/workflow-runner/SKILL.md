---
name: workflow-runner
description: Run a Claude Code Workflow script (the llm-council, work-council and doing-substantial-work workflows) from Codex or any terminal, with the same hooks and results as Claude Code's Workflow tool. Used by llm-council, work-council and doing-substantial-work when the host agent has no Workflow tool. Not for direct use; load the calling skill instead.
---

# Workflow runner

[run-workflow.mjs](run-workflow.mjs) gives a workflow script the same hooks Claude Code's Workflow tool gives it (`args`, `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`), so `llm-council/council-workflow.js`, `work-council/build-workflow.js` and `doing-substantial-work/build-workflow.js` run unchanged on both hosts.

```bash
node <skills folder>/workflow-runner/run-workflow.mjs <script.js> --args '<json>'    # or --args @file.json
```

Run it from inside the target repository, with an absolute script path. Progress goes to stderr. Stdout gets one JSON object, `{ "runId": "wf_...", "result": <what the script returned> }`. `runId` plays the part of the Workflow tool's Run ID. It can take several minutes. Each agent may run up to 30 minutes and phases run one after another, so use the host lifecycle below to retain the command until its result is collected. It runs only `llm-council/council-workflow.js`, `work-council/build-workflow.js`, `doing-substantial-work/build-workflow.js` and its own [second-opinion.js](second-opinion.js) (one read-only Claude agent, args `{ "prompt" }`, result `{ text }` or `{ error }`), and refuses any other script.

Each `agent()` call runs `claude -p` in the repository:

| Script asks for | Runner uses |
|---|---|
| `agentType: 'Plan'` | `--permission-mode plan` (read-only) |
| `isolation: 'worktree'` | a fresh worktree `.claude/worktrees/<runId>-<n>` on branch `worktree-<runId>-<n>`, with `--permission-mode bypassPermissions` inside it only; removed afterwards if unchanged |
| anything else | `--permission-mode auto` |
| specialist `agentType` (other than `Plan` / `general-purpose`) | `--agent <agentType>`; CLI errors are reported, never silently replaced by a generic agent |
| `model`, `effort`, `schema` | `--model`, `--effort`, `--json-schema` |

Each agent has a 30-minute timeout (override with `WORKFLOW_RUNNER_TIMEOUT_MS`, positive milliseconds). On timeout or parent interruption, the runner signals only its owned process groups, allows one second for shutdown, then sends SIGKILL and closes inherited pipes. Interrupted runs stop scheduling agents and exit unsuccessfully.

A failed or erroring agent returns `null`, and `parallel()` and `pipeline()` turn a thrown task into `null`, as in Claude Code. Nested `workflow()` calls are not supported.

## Host lifecycle and completion

Claude Code keeps its native Workflow tool and task notifications. These terminal instructions are for hosts using this runner instead.

In Codex, execute the exact runner command in the foreground of `exec_command` with a short `yield_time_ms` and an absolute `--out` path in this run's scratch directory. Save the returned `session_id`; use `write_stdin` to collect output until exit, with waits of at most 60 seconds and progress updates between waits. If `functions.exec` itself yields a cell ID, resolve it with `functions.wait` first, then use the process session ID returned inside it. Do not wrap the runner in `nohup`, `disown`, a trailing `&`, or another shell just to detach it. Do not end the turn expecting a terminal process to schedule a completion notification.

A run ID means started, not successful. After exit, read the `--out` JSON and inspect `result` using the calling skill's contract. Exit 0 can still contain `needs-attention`, failed cards, null agents, or `{ error }`. Collect required reports and relay actual failures before calling the task complete. On resuming an interrupted turn, inspect the saved session and output before launching again; if the session is gone and no terminal result exists, report the run as interrupted. Never infer success from an empty log or elapsed time.

## Codex setup (once per machine)

Codex's sandbox hides the Claude login (kept in the macOS Keychain) and blocks a nested `codex exec`, so the runner must run outside it. Add this line to `~/.codex/rules/default.rules`, with your real absolute home path:

```text
prefix_rule(pattern=["node", "/ABSOLUTE/HOME/.agents/skills/workflow-runner/run-workflow.mjs"], decision="allow")
```

It lets Codex start the runner outside its sandbox; workflow agents and second opinions use this runner. The dual-pr-review skill has its own launcher and must use that skill's tracked lifecycle instead; do not pass arbitrary review scripts to this runner. In Codex, call the runner with that exact absolute path (no `~`) and with nothing wrapped around the command (no pipe, redirect, subshell or `timeout`), so the rule matches. Without the rule, Codex has to run it as an approved escalated command.
