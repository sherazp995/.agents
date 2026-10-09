# Shared Configuration Ownership

Global rules and personal skills have one source: `~/.agents/AGENTS.md` (symlinked from `~/.claude/CLAUDE.md`) and `~/.agents/skills/`. All coding agents must use those sources.

## Guidelines

- Do not create agent-specific copies of global rules.
- Do not replace skill-directory symlinks with real directories.
- Do not install a separate Ponytail version.
- Add, edit, remove, and update personal skills in the shared directory (`~/.agents/skills/`) so changes reach every configured agent.
- Update Ponytail only in `~/.agents/plugins/ponytail`, preserving its native adapter links.
- Store Ponytail shared defaults in `~/.agents/ponytail.json`.
- Run `python3 ~/.agents/check.py` after changing setup or updating plugins.

## Ponytail

Ponytail is off by default in every coding agent. Use it only when the user explicitly requests it by name or command. Ordinary coding, review, simplification, or audit requests must not activate Ponytail. An explicit activation lasts only for the requested scope or current session; do not enable it by default for future sessions.

## Project-Specific Rules

Project rules may add project-specific instructions via a project-level `CLAUDE.md`. They must not fork the global setup.

## Application-Managed Resources

Application-managed credentials, sessions, native tools, and bundled runtime components retain the formats required by their host application.
