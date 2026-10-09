---
name: workflow-runner
description: Run a Claude Code Workflow script (the llm-council and work-council workflows) from Codex or any terminal, with the same hooks and results as Claude Code's Workflow tool. Used by llm-council and work-council when the host agent has no Workflow tool. Not for direct use; load the calling skill instead.
---

# Workflow runner

[run-workflow.mjs](run-workflow.mjs) gives a workflow script the same hooks Claude Code's Workflow tool gives it (`args`, `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`), so `llm-council/council-workflow.js` and `work-council/build-workflow.js` run unchanged on both hosts.

```bash
node <skills folder>/workflow-runner/run-workflow.mjs <script.js> --args '<json>'    # or --args @file.json
```

Run it from inside the target repository, with an absolute script path. Progress goes to stderr. Stdout gets one JSON object, `{ "runId": "wf_...", "result": <what the script returned> }`. `runId` plays the part of the Workflow tool's Run ID. It can take several minutes. Each agent may run up to 30 minutes and phases run one after another, so give the command the longest timeout the host allows, or run it in the background and wait for it. It runs only `llm-council/council-workflow.js`, `work-council/build-workflow.js` and its own [second-opinion.js](second-opinion.js) (one read-only Claude agent, args `{ "prompt" }`, result `{ text }` or `{ error }`), and refuses any other script.

Each `agent()` call runs `claude -p` in the repository:

| Script asks for | Runner uses |
|---|---|
| `agentType: 'Plan'` | `--permission-mode plan` (read-only) |
| `isolation: 'worktree'` | a fresh worktree `.claude/worktrees/<runId>-<n>` on branch `worktree-<runId>-<n>`, with `--permission-mode bypassPermissions` inside it only; removed afterwards if unchanged |
| anything else | `--permission-mode auto` |
| `model`, `effort`, `schema` | `--model`, `--effort`, `--json-schema` |

A failed or erroring agent returns `null`, and `parallel()` and `pipeline()` turn a thrown task into `null`, as in Claude Code. Nested `workflow()` calls are not supported.

## Codex setup (once per machine)

Codex's sandbox hides the Claude login (kept in the macOS Keychain) and blocks a nested `codex exec`, so the runner must run outside it. Add this line to `~/.codex/rules/default.rules`, with your real absolute home path:

```text
prefix_rule(pattern=["node", "/ABSOLUTE/HOME/.agents/skills/workflow-runner/run-workflow.mjs"], decision="allow")
```

It lets Codex start the runner outside its sandbox; every Claude call from Codex, including second opinions, goes through the runner. In Codex, call the runner with that exact absolute path (no `~`) and with nothing wrapped around the command (no pipe, redirect, subshell or `timeout`), so the rule matches. Without the rule, Codex has to run it as an approved escalated command.
