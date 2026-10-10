---
name: video-qa
description: Record a captioned before and after video that proves a fix or feature works. Replays the same scripted user flow against the base version and the changed version, with a visible cursor, natural pauses, burned-in step captions saying what was done and what happened, title cards and a verdict (FIXED, STILL BROKEN, NOT REPRODUCED, INCOMPLETE). Use when the user asks for a QA video, a demo or proof video of a fix, "record what was failing and now works", or a video to attach to a PR. For screenshot comparisons and a full QA report use branch-visual-qa; the two combine.
---

# Video QA

Produce one MP4 that shows, step by step, how a bug was triggered on the base version, then the same steps working on the changed version. Each step is captioned, and every check ends with PASS or FAIL in the caption. The video is evidence, so it must show what really happened.

## Who does what: the session coordinates, one runner records

The chat session states the claim to prove (bug and fix, or feature) and the versions to compare. One runner subagent (`general-purpose`) does steps 1 to 5: servers, flow discovery with the Playwright MCP, scenario, recording, contact sheet check and server cleanup. Give it this skill's path and the claim. It returns only: verdict, exit code, absolute path of `<id>.mp4`, both contact sheet paths, the trigger steps, console errors, whether every server it started was stopped, and anything it could not do. The session looks at both contact sheets before reporting. When run with `branch-visual-qa`, the session starts the two runners as two agent calls, one after the other, so they share the single browser slot.

## 1. Run both versions

Follow the "Establish the comparison" and "Make both versions work" sections of [branch-visual-qa](../branch-visual-qa/SKILL.md): base and branch in separate checkouts on separate ports, isolated QA databases with identical fixtures, each server verified to run its own SHA. Record each SHA; `detail` on the video banner is `<ref> <short sha>`. Versions that are not git checkouts (static builds, deployed URLs) get a plain description in `detail`, such as `staging build 2026-10-10`. For a new feature with no "before", record the changed version alone.

Start each server in the background on a port you checked is free (`ss -ltn`), record its PID, and when finished kill only those PIDs and confirm the ports are closed. Leave servers that were running before the run alone. Preserve the user's checkout: no edits, commits or branch changes.

## 2. Find the flow with the Playwright MCP

Use the `playwright` MCP (headless) to walk the flow once on the base version: find stable selectors (`#id`, `[data-testid]`, `role=button[name="Save"]`, `text=Subscribe`) and confirm where the bug shows. For a bug, the flow must end with a check that fails on base. If it cannot be made to fail, say so; do not record a video that pretends it did.

The recorder does not use the MCP: it replays a script so captions line up with each action and the same flow runs on both versions. Close the MCP browser when done, and delete any snapshot or console files the MCP wrote for this run (they land in its output folder, see `~/.agents/AGENTS-MCP.md`).

## 3. Write the scenario

Create the run folder `<repo root>/tmp/video-qa/<YYYYMMDD-HHMMSS>/` (add a numeric suffix if it exists) and write `scenario.json` there. If `tmp/` is not already ignored, add it to `.git/info/exclude`, never to the tracked `.gitignore`. Outside a repository, use the agent's scratchpad directory. [examples/scenario.json](examples/scenario.json) shows the format only; discover the real flow and selectors for each task.

| Field | Meaning |
|---|---|
| `id` | Slug used for the final file name |
| `title`, `subtitle` | Title card text; the subtitle states the bug or feature in one line |
| `viewport` | Default `{"width": 1280, "height": 800}` |
| `versions` | One or two of `{label, detail, baseUrl, role?, storageState?}`. A label containing `BEFORE` or `AFTER` sets `role` (red or green banner); otherwise set `role` to `before` or `after`. Two versions need one of each. `detail` is `<ref> <short sha>` |
| `storageState` | Path to a Playwright storage state for a signed-in session (keep it out of the repo and report) |
| `pace` | Omit for human pacing; `"fast"` for quick debugging runs |
| `steps` | Ordered actions and checks, each with a `caption` |

A `selector` is any Playwright locator string: CSS (`#email`, `[data-testid=save]`), `text=Subscribe`, or `role=button[name="Subscribe"]`. The first match is used.

Actions: `goto` (`url`, relative to `baseUrl`), `click`, `fill` (clears the field, then types `value`), `type` (types `value` after what is there), `select`, `check`, `hover`, `scroll` (each with `selector`, and `value` where it applies), `press` (`key`), `wait` (`ms`), `wait_for` (`selector`). Both `fill` and `type` type one character at a time at human pace. Actions take `timeoutMs` (default 10 s, 30 s for `goto`); an action that cannot run stops that version and the rest of its steps are skipped.

Checks, which end with PASS or FAIL in the caption: `expect_visible`, `expect_hidden` (`selector`), `expect_text` (`text`, optional `selector`), `expect_url` (`contains`), `expect_count` (`selector`, `count`). Each takes `timeoutMs`, plus optional `pass` and `fail` captions written in plain words ("error message shown", "nothing happened, no error shown").

Write captions as a person narrating: what they do, and the step that triggers the bug ("Click Subscribe (this triggered the bug)"). Use at least one check per claim the video makes.

## 4. Record

Prerequisites: Node 18+, Google Chrome (or Playwright's chromium), `fc-match` (fontconfig), and system `ffmpeg` and `ffprobe` built with libass (for the `subtitles` filter). Playwright's own ffmpeg install does not provide these.

```bash
cd <this skill's directory>/scripts && [ -d node_modules ] || npm install
node <this skill's directory>/scripts/record.mjs <run folder>/scenario.json <run folder>
```

First run on a new machine: if Playwright reports a missing ffmpeg, run `node node_modules/playwright-core/cli.js install ffmpeg` in `scripts/`. It uses installed Chrome when `/usr/bin/google-chrome` exists; otherwise run `node node_modules/playwright-core/cli.js install chromium`, or set `VIDEO_QA_CHANNEL`. `VIDEO_QA_HEADED=1` shows the browser while recording.

The recorder moves a visible cursor to each target, types with an uneven rhythm and pauses briefly before each step, so the flow is easy to follow.

## 5. Read the verdict and check the video

The script prints JSON and writes `results.json`. Verdicts and exit codes:

- `FIXED` (exit 0): an `expect_*` check failed on BEFORE and every step passed on AFTER.
- `WORKING` (exit 0): one version only, every step passed.
- `STILL BROKEN` (exit 1): a check failed on AFTER.
- `NOT REPRODUCED ON BEFORE` (exit 1): every check passed on BEFORE too.
- `FAILING` (exit 1): one version only, a check failed.
- `INCOMPLETE` (exit 2): an action could not run on some version (server down, selector missing), so the video proves nothing. Fix the setup or scenario and record again.

An invalid scenario (unknown action or role, no check, wrong version count) exits 2 before recording.

Before reporting, look at the video yourself: the recorder writes `before-sheet.png` and `after-sheet.png`, twelve frames spread across each whole clip. Read both. Confirm the captions match what is on screen, the bug is visible on BEFORE and the fix on AFTER. A wrong selector or a check that passes for the wrong reason makes the video misleading: fix the scenario and record again. Never edit captions or cut footage to change what a check showed.

## Outputs

In the run folder:

- `<id>.mp4`: title card, BEFORE clip, AFTER clip, verdict card. This is the deliverable.
- `side-by-side.mp4`: both clips next to each other (set `"sideBySide": false` to skip).
- `before.mp4`, `after.mp4`, `*-sheet.png` contact sheets, `*.srt` captions, `*-final.png` last frames.
- `results.json`: verdict, per step PASS or FAIL, console errors per version. It records that the run was automated.

Keep videos out of git. Report the verdict, the absolute path of `<id>.mp4`, the steps that trigger the bug, and any console errors. When run inside branch-visual-qa, add the videos to that report's `evidence` list.

## Honesty

The pacing makes the video watchable; it is not a claim that a person tested it. Do not add a named tester or text saying it was recorded manually. If the user wants that, say once that the video was automated and leave it out.
