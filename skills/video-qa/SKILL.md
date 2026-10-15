---
name: video-qa
description: Record a captioned before and after video that proves a fix or feature works. Replays the same scripted user flow against the base version and the changed version, with a visible cursor, natural pauses, burned-in step captions saying what was done and what happened, and a verdict (FIXED, STILL BROKEN, NOT REPRODUCED, INCOMPLETE). Use when the user asks for a QA video, a demo or proof video of a fix, "record what was failing and now works", or a video to attach to a PR. For screenshot comparisons and a full QA report use branch-visual-qa; the two combine.
---

# Video QA

Produce two MP4s, one showing step by step how a bug was triggered on the base version and one showing the same steps working on the changed version, and with `--full` a combined film of both. Each step is captioned, and every check ends with PASS or FAIL in the caption. The video is evidence, so it must show what really happened.

## Who does what: the session coordinates, one runner records

The chat session states the claim to prove (bug and fix, or feature) and the versions to compare. One runner subagent (`general-purpose`) does steps 1 to 5: servers, flow discovery with the Playwright MCP, scenario, recording, contact sheet and full-size frame check, and server cleanup. Give it this skill's path and the claim. It returns only: verdict, exit code, absolute paths of `<id>-before.mp4` and `<id>-after.mp4` and both contact sheets (plus `<id>.mp4` only with `--full`), the trigger steps, console errors, whether every server it started was stopped, and anything it could not do. It also returns one full-size frame taken from each clip. The session looks at both contact sheets and those frames before reporting. When run with `branch-visual-qa`, the session starts the two runners as two agent calls, one after the other, so they share the single browser slot.

## 1. Run both versions

Follow the "Establish the comparison" and "Make both versions work" sections of [branch-visual-qa](../branch-visual-qa/SKILL.md): base and branch in separate checkouts on separate ports, isolated QA databases with identical fixtures, each server verified to run its own SHA. Record each SHA; `detail` on the video banner is `<ref> <short sha>`. Versions that are not git checkouts (static builds, deployed URLs) get a plain description in `detail`, such as `staging build 2026-10-10`. For a new feature with no "before", record the changed version alone.

Start each server in the background on a port you checked is free (`lsof -nP -iTCP:<port> -sTCP:LISTEN` on macOS, `ss -ltn` on Linux), record its PID, and when finished kill only those PIDs and confirm the ports are closed. Leave servers that were running before the run alone. Preserve the user's checkout: no edits, commits or branch changes.

A flow behind staff or IdP sign-in (admin, super admin, impersonation) is not blocked in cohabit-web: start the version with the `server-tunnel` skill, which brings up the portal and IdP, and tear it down afterwards (see `cohabit-local-browser-testing`).

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
| `captions` | Omit for step captions; `false` for a video without them (the `--captions` flag overrides it) |
| `full` | `true` also makes the combined film, banner clips and side-by-side (the `--full` flag sets it too) |
| `trimWaits` | Omit to cut page loads and check waits from the video; `false` keeps real time, for a slowness bug |
| `steps` | Ordered actions and checks, each with a `caption` |

A `selector` is any Playwright locator string: CSS (`#email`, `[data-testid=save]`), `text=Subscribe`, or `role=button[name="Subscribe"]`. The first match is used.

Actions: `goto` (`url`, relative to `baseUrl`), `click`, `fill` (clears the field, then types `value`), `type` (types `value` after what is there), `select`, `check`, `hover`, `scroll` (each with `selector`, and `value` where it applies), `press` (`key`), `wait` (`ms`), `wait_for` (`selector`). Both `fill` and `type` type one character at a time at human pace. Actions take `timeoutMs` (default 10 s, 30 s for `goto`); an action that cannot run stops that version and the rest of its steps are skipped.

Checks, which end with PASS or FAIL in the caption: `expect_visible`, `expect_hidden` (`selector`), `expect_text` (`text`, optional `selector`), `expect_url` (`contains`), `expect_count` (`selector`, `count`). Each takes `timeoutMs`, plus optional `pass` and `fail` captions written in plain words ("error message shown", "nothing happened, no error shown").

Write captions as a person narrating: what they do, and the step that triggers the bug ("Click Subscribe (this triggered the bug)"). Use at least one check per claim the video makes.

## 4. Record

Prerequisites: Node 18+, Playwright's Chromium, `fc-match` (fontconfig), and system `ffmpeg` and `ffprobe` built with libass (for the `subtitles` filter). Playwright's own ffmpeg install does not provide these.

```bash
cd <this skill's directory>/scripts && [ -d node_modules ] || npm install
node <this skill's directory>/scripts/record.mjs <run folder>/scenario.json <run folder> [--captions on|off] [--full]
```

`--captions off` records the same flow with no caption strip and shorter holds, for a clean video. The `.srt` files are still written. Use it when the user asks for a video without captions.

`--full` adds the combined `<id>.mp4` (title card, BEFORE, AFTER, verdict card, with version banners), `side-by-side.mp4` and the banner clips `before.mp4` and `after.mp4`. Use it only when the user asks for a combined film.

First run on a new machine: if Playwright reports a missing ffmpeg, run `node node_modules/playwright-core/cli.js install ffmpeg` in `scripts/`. On macOS, Homebrew's `ffmpeg` has no `drawtext` or `subtitles`; install `ffmpeg-full` and put `$(brew --prefix ffmpeg-full)/bin` first on `PATH`. It records with Playwright's Chromium: run `node node_modules/playwright-core/cli.js install chromium` in `scripts/` once. `VIDEO_QA_CHANNEL=chrome` uses installed Chrome instead, but its headless mode on macOS drew the page into only part of the video frame. `VIDEO_QA_HEADED=1` shows the browser while recording.

The recorder moves a visible cursor to each target in one quick eased glide, types at a brisk uneven rhythm (faster for long values) and pauses only briefly around each step, so the flow looks like a person who knows the app.

Waiting is cut from the video, keeping a short blink at each end: a `goto` page load, the whole wait of a `wait_for`, the page load or fetch/XHR traffic (a Turbo Drive or SPA visit) that any other action starts, including one sent just after it (an onchange auto-submit, a key press), and a check's polling, which keeps about 0.3s at each end. The cursor glide, the typing, `wait` steps and the holds stay. Caption times shift to match. A failed check's caption keeps the real wait, such as `FAIL: no error shown (waited 5.0s)`; `results.json` records `trimmedMs` per version and `waitedMs`, the real wait, for every check. When the claim is about speed (a slow page, a spinner that never ends), set `"trimWaits": false` so the video shows real time.

## 5. Read the verdict and check the video

The script prints JSON and writes `results.json`. Verdicts and exit codes:

- `FIXED` (exit 0): an `expect_*` check failed on BEFORE and every step passed on AFTER.
- `WORKING` (exit 0): one version only, every step passed.
- `STILL BROKEN` (exit 1): a check failed on AFTER.
- `NOT REPRODUCED ON BEFORE` (exit 1): every check passed on BEFORE too.
- `FAILING` (exit 1): one version only, a check failed.
- `INCOMPLETE` (exit 2): an action could not run on some version (server down, selector missing), or the page did not fill the video frame, so the video proves nothing. Fix the setup or scenario and record again.

The frame check: after the last step the recorder shows magenta markers on the bottom and right edges of the viewport, checks the raw recording shows them there, and ends the clip before them. `frameCheck` in `results.json` holds the result. A page that covers those edges at the end (a modal backdrop) skips the check (`frameCheck.skipped`); look at the full-size frames yourself. A failed check with `VIDEO_QA_CHANNEL=chrome` set means the browser: unset it and record again.

An invalid scenario (unknown action or role, no check, wrong version count, `captions`, `trimWaits` or `full` not `true` or `false`, an odd viewport width or height), a `--captions` value other than `on` or `off`, or a value on `--full` exits 2 before recording.

Before reporting, look at the video yourself: the recorder writes `before-sheet.png` and `after-sheet.png`, twelve frames spread across each whole clean clip (`<id>-before.mp4`, `<id>-after.mp4`). Read both, then pull one full-size frame from each clean clip (`ffmpeg -y -sseof -1 -i <id>-before.mp4 -frames:v 1 before-frame.png`, the same for after) and read it: at contact sheet size a grey band or a cut-off page is easy to miss. `*-final.png` is a page screenshot, not a video frame, so it cannot show this. Confirm the page fills the frame down to the caption strip, the captions match what is on screen, the bug is visible on BEFORE and the fix on AFTER. A wrong selector or a check that passes for the wrong reason makes the video misleading: fix the scenario and record again. Never edit captions or cut footage to change what a check showed.

## Outputs

Unless captions are off, every video, contact sheet and `*-final.png` shows the step captions in a dark strip below the page, sized for the longest caption, so a caption never covers the page. In the run folder:

- `<id>-before.mp4` and `<id>-after.mp4`: each version on its own, with its step captions but no version banner, title or verdict card. These are the deliverables to share, one video per version (a single-version run makes only its own, `<id>-<role>.mp4`, or `<id>-<slug>.mp4` without a role).
- `*-sheet.png` contact sheets of those clips, `*.srt` captions, `*-final.png` last frames.
- `results.json`: verdict, per step PASS or FAIL, console errors per version. It records that the run was automated. `video` and `sideBySide` are null without `--full`.
- Only with `--full`: `<id>.mp4` (title card, BEFORE clip, AFTER clip, verdict card, with the version banner), `side-by-side.mp4` (both banner clips next to each other; `"sideBySide": false` skips it), and the banner clips `before.mp4` and `after.mp4`.

Keep videos out of git. Report the verdict, the absolute paths of `<id>-before.mp4` and `<id>-after.mp4` first (then `<id>.mp4` when made with `--full`), the steps that trigger the bug, and any console errors. When run inside branch-visual-qa, add the videos to that report's `evidence` list.

## Honesty

The pacing and the cut waits make the video watchable; they are not a claim that a person tested it or that the app responded instantly. Do not add a named tester or text saying it was recorded manually. If the user wants that, say once that the video was automated and leave it out.
