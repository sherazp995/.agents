# Shared Configuration Ownership

Global rules and personal skills have one source: `~/.agents/AGENTS.md` (symlinked from `~/.claude/CLAUDE.md`) and `~/.agents/skills/`. All coding agents must use those sources.

## Guidelines

- Do not create agent-specific copies of global rules.
- Do not replace skill-directory symlinks with real directories.
- Add, edit, remove, and update personal skills in the shared directory (`~/.agents/skills/`) so changes reach every configured agent.
- Slash commands in `~/.agents/commands/` reach Claude only. Codex does not load custom prompts, so a workflow Codex needs too goes in a skill.
- Shared MCP servers go in `~/.agents/mcp/servers.json`, then run `install.py` (see `AGENTS-MCP.md`).
- Machine-specific shared config lives in the git-ignored `~/.agents/local/`. Change Codex model, plugin and marketplace settings in `~/.agents/local/codex/config.shared.toml` (the keys `registry.toml` lists as `shared_config`), then run `install.py`. `install.py` adds a shared key a login lacks and backs up `config.toml` into `~/.agents/backup/` before every write. A login value that differs from the shared file (from before the merge, or changed later, including by Codex's own `/model`) is a conflict, never overwritten; make the two match. Keys Codex rewrites itself (`marketplaces.*.last_updated`, `tui.model_availability_nux`, `notice`) are never shared. Sign-in state, trusted projects and download caches stay per login.
- Run `python3 ~/.agents/check.py` after changing setup or updating plugins.

## Project-Specific Rules

Project rules may add project-specific instructions via a project-level `CLAUDE.md`. They must not fork the global setup.

## Related Tests on Stop (`.agents/project.toml`)

The `related-tests` Stop hook runs only the tests for files changed in the finished turn. On Claude, `related-tests-snapshot` (UserPromptSubmit) records the tracked files as a git tree object through a throwaway index (`git add -u`, so untracked files never become git objects) and the untracked, not-ignored files as path, size and mtime (above 20,000 only their count) when the turn starts; a prompt queued mid-turn keeps the pending snapshot, and snapshots older than a day are deleted. At Stop the turn's files are the tracked diff from that tree plus untracked files that are new, changed or gone, so shell edits, new files and deleted files count. Files another writer changes in the same working tree during the turn are tested too. While a background agent or workflow from the turn has not sent a task notification (matched by its agent or task id, any status), Stop waits for a later Stop; a launch older than 45 minutes stops holding the turn. Without a usable snapshot (Codex, first turn after install, a snapshot past the transcript's end) it falls back to the files the transcript shows this session edited since the last prompt; above the untracked cap, untracked files count only when the transcript shows them edited. Failing tests block the stop once with the output tail and mark the snapshot blocked, so the next prompt starts a fresh one. Results are cached by file hashes in `~/.agents/tmp/test-cache/related-tests/`, snapshots in its `snapshots/` folder.

Without a project file it uses conventions: Ruby `app|lib/**/x.rb` to `x_spec.rb` / `x_test.rb`, JS/TS `x.ts` to `x.test.*`, `x.spec.*`, `__tests__/x.*`, Python `a/b.py` to `tests/test_b.py`, `a/test_b.py`. A repo can override both mapping and runner:

```toml
# <repo>/.agents/project.toml
[tests]
command = "bin/rails test {files}"   # {files}: matched test paths, shell-quoted
timeout = 300                        # seconds for the whole run
[tests.map]
"app/**/*.rb" = ["test/**/{stem}_test.rb"]   # {stem}: changed file name without extension
```

## Application-Managed Resources

Application-managed credentials, sessions, native tools, and bundled runtime components retain the formats required by their host application.
