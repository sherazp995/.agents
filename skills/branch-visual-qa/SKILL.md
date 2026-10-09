---
name: branch-visual-qa
description: "Test a current branch against its base with real browser flows and matched before and after screenshots, and deliver one local index.html report with screenshots, tests and review comments. For cohabit-web, also run the cohabit_pr_review skill as part of the same workflow. Report only: it never edits the branch or commits. It tries fixes in a throwaway copy and reports how to fix each issue. Use for branch QA, visual regression comparisons, or requests to show what a branch fixes against develop or another base. Ordinary code review without browser comparison does not need this workflow."
---

# Branch Visual QA

Deliver working local pages and one browsable `index.html` containing browser QA, automated checks and code-review comments. For cohabit-web, invoking this skill also invokes `cohabit_pr_review`; the user does not need a separate review request. Before and after screenshots are mandatory for every claimed visual or user-flow comparison. This is execution work, not a test plan alone.

**Report only. Never fix.** This workflow never edits application code, specs, styles or JavaScript in the branch under test, never creates commits, and never rewrites, rebases or amends the branch. Every problem found, including ones that look trivial to fix, goes in the report as a finding with its evidence and a suggested fix. The user decides what gets applied and when.

## Establish the comparison

- Read relevant repository instructions. Record branch, HEAD, dirty files, base ref and exact SHA. Preserve existing work. Leave the branch exactly as you found it: same HEAD, same working tree.
- Use the requested base. Otherwise use the PR target, then the repository's documented development branch; for Cohabit, default to `origin/develop`. Fetch the base when possible. Disclose a stale/offline base rather than calling it latest.
- Use the merge-base diff to identify branch changes, but run the actual base tip as the before version. Note base-only changes that affect interpretation. Include a downloadable code diff.
- Inventory changed behavior, affected routes, shared components, relevant roles and neighboring flows. Make a coverage matrix before testing. Cover every affected behavior, including happy paths, rejection paths, retries, relevant states and permissions. For shared UI changes, test affected consumers; do not equate one page screenshot with testing everything.
- Default to desktop 1440px, narrow desktop/tablet 768–1024px, and phone 375px; include 320px when cramped controls or smallest-phone support matters. Use identical dimensions within each pair. Respect the project's supported devices.

## Run Cohabit PR review in the same workflow

For a repository whose origin is `cohabitplatforms/cohabit-web`, read the sibling [cohabit_pr_review skill](../cohabit_pr_review/SKILL.md) and run its full orchestration, not an informal replacement review. Use its lead, four reviewer lenses, proof tests, ledger/recheck rules, high-severity spot-checks and report style. Resolve its supporting files relative to that skill's actual directory. Schedule reviewers within available agent slots; only the visual-QA coordinator uses the browser. Other repositories retain ordinary visual QA without this Cohabit-specific dependency.

The review skill's context limits apply to its review orchestration; they do not prevent the visual-QA coordinator from inspecting code needed to run browser scenarios. The integration rules below take precedence over conflicting standalone-review instructions about output, target resolution, ledger reuse and cleanup.

Coordinate the two workflows:

- Resolve the current branch/PR and fetch the base once before starting either lane. Pass the explicit target, base ref, immutable head/base SHAs, relevant risks and `<run-directory>/review/` to the review lead. A remote PR head must not silently replace the local branch being tested. If they differ, review the pinned local snapshot and state that scope rather than approving a different remote head.
- Both lanes assess the same source snapshot. Include dirty changes in an isolated snapshot and record their diff/hash, or explicitly exclude them in both lanes. Dirty snapshots cannot reuse or update a committed-head ledger entry as though they were identical. Review's merge-into-latest-base checks remain required in its throwaway copy, using `git merge --no-commit --no-ff <BASE_SHA>` so no merge commit is created; record its integration result separately from browser results on the branch head. A merge conflict cannot become a combined pass.
- Reuse ledger results only when both reviewed head and base SHAs match, no dirty delta exists, and the stored review/proof artifacts are available. Copy the comments, their current statuses and proof artifacts into this run; label the review `reused`. Same head with a changed base requires a recheck: pass the previous base SHA, review the old-base/new-base delta and its interaction with the branch, and rerun integration plus existing proofs. Override the lead/reviewer focus on `PREV_SHA..HEAD_SHA` in this case, since that head diff is empty. Missing review evidence requires a fresh review, not an empty successful section.
- Share cached test output only when source, environment, fixtures and test command match. Keep proof specs, logs, the lead report and source-tagged comments under `review/` before cleanup. A code-only finding needs proof or the review skill's explicit design-review classification, not invented screenshots. Add a paired browser scenario when it has a reproducible UI consequence.
- Merge duplicate review and browser findings into one comment, preserving every source tag, severity, origin, location, proof and ledger status. Link its comparison case(s), suggested patch and trial evidence. Keep pre-existing visual findings even though the PR-review lane excludes unrelated inherited issues. Unconfirmed suspicions stay out of confirmed comments; blocked verification is visible as a limitation.
- Use the review skill's output format for the saved lead report, but deliver comments and verdict inline in this skill's `index.html`. Its terminal-only output rule is replaced by this local report destination for this combined invocation. Do not post GitHub comments, Slack messages or PR approvals. Never apply fixes to the tested branch. Review tests and trial fixes belong only in isolated copies; cleanup removes only resources created by this run, never other worktrees or databases.
- Include a `review` object and a Cohabit review coverage row even when the lane is blocked or skipped. Missing tools/skill, unavailable reviewers, closed/merged targets or unverified proofs cannot silently count as a passed review. Record the reason and finish independently possible browser work. Preserve required reviewer identities and disclose any fallback allowed by the review skill.

Show separate browser and code-review outcomes, then a combined conclusion. A combined pass requires completed or validly reused review, no unresolved introduced blockers/high/medium findings, successful integration and no failed, blocked or untested QA scenarios in the coverage matrix. A passing test suite alone is not approval. If the checkout moves during the run, keep evidence attached to its tested snapshot; disclose later commits/edits instead of silently mixing versions or overwriting another session's work.

## Make both versions work

Use separate local checkouts or snapshots and ports. Preserve the original working tree. Resolve missing dependencies, assets, local host routing and pending migrations within authorized local scope.

Use isolated databases with identical deterministic fixture IDs when tests mutate data or schemas differ. A base running against the new schema can conceal the original bug. Avoid modifying shared records to manufacture a before state. Do not run real outbound mail, payments or background integrations during fixtures. Keep setup and reset scripts restricted to the QA databases and owned fixture records.

Verify each server runs the intended SHA and loads its own assets. Absolute asset hosts and shared build directories can silently show the same version on both sides. Build independently. Record environment-only adjustments, such as disabling development warning popups, and apply them consistently. Never hide app errors or alter product DOM/CSS to stage a screenshot.

Keep test credentials local. Do not put secrets, `.env` files, database dumps or authenticated browser state in the report or repository. Use synthetic records for captures where practical.

## Execute and gather evidence

Use one browser window, one tab and one browser context throughout QA and report inspection. Reuse them sequentially for the base, current branch, roles and viewports. Do not pre-open windows, tabs or contexts for each version or role, and do not run parallel browser sessions through subagents. Switch accounts by clearing only the QA session or signing out and back in within the same context. Close only surplus browser resources created by this QA run; preserve the user's existing windows and tabs.

Use the available browser workflow and read its required skill before browser operations. If the preferred runtime is unavailable, follow its documented fallback. Do not declare browser testing complete from source inspection, HTTP checks or request specs alone.

For each scenario:

1. Start with equivalent data, account, role, input values and viewport on both versions. Record route and starting state. Reset only owned QA fixtures between independent runs, or explicitly document a sequential scenario and its cumulative state.
2. Perform the actual interaction on the base and current branch. Capture both resulting screens, including an original failure and fixed result when reproducible. A backend fix often needs a before success/duplicate versus after inline rejection, not an invented CSS difference.
3. Verify the underlying effect where necessary: response status, request count, record count, persisted state or prevented side effects. An error toast alone does not prove a rejected write. A successful click alone does not prove creation.
4. Wait for meaningful UI completion: network result, refreshed list, modal backdrop removed, final scroll position and fonts/images ready. Capture real screenshots, inspect them visually, and retain the originals. Full-page overflow must remain visible. Label crops and different resulting states.
5. Check console errors, broken assets, horizontal overflow, overlapping controls, readable warnings, reachable actions, internal table/menu scrolling and retained form values. Verify interactive controls at small widths, not just their appearance.

Run focused automated tests appropriate to the changes and cache their output. Follow the repository's testing skill when adding or reviewing tests. Browser evidence supplements model/request tests for migrations, data integrity, permissions and concurrency. State whether concurrency was actually exercised or only covered through constraints/mocks.

Maintain coverage statuses: `passed`, `failed`, `blocked`, `not-tested`. A missing baseline, login, role or environment cannot silently become a pass. Explain what remains unverified. Do not claim exhaustive testing beyond the matrix.

## Report findings, do not fix

Do not fix the branch. Record each confirmed issue as a finding: what is wrong, where (route, viewport, role, file:line when known), its screenshot for UI issues or execution/source proof for code-only issues, and whether it is caused by the branch or already on the base. Mark the scenario `failed`. Say which findings are inside the branch's scope and which are pre-existing or out of scope.

**Try the fix, but only in a throwaway copy.** For each actionable confirmed finding, try a fix in a separate detached worktree or snapshot inside the run directory (never the user's checkout or branch), rebuild assets there, and re-run the affected scenario to see whether it works. Then report how to fix it:
- the suggested change as a small unified diff, saved as `fixes/<case-id>.diff` in the run directory and linked from the finding;
- whether the trial fix worked, with its screenshot for UI issues or proof output for code-only issues, or why it could not be tried;
- any risk or wider effect the fix could have.

Remove the trial worktrees when done. Do not write or change tests in the user's checkout either. Before finishing, compare the branch HEAD and `git status` with the start. Confirm this run made no source changes; disclose external changes without reverting them. Never commit, push, merge into the user's branch or deploy. Only the uncommitted integration check in the review's throwaway copy is allowed.

## Report layout and formatting

This section is the complete formatting specification. Do not search for or depend on a previous report, a temporary HTML file, or a separate formatting reference. A temporary report may have been deleted. Build each report from these instructions and the current run's evidence.

Create a standalone `index.html` with embedded CSS, UTF-8 encoding and a responsive viewport meta tag. Use system fonts and relative links, with no CDN, remote fonts or JavaScript dependency. The page must open directly from disk.

### Visual design

- Center the page in a 1280px maximum-width container.
- Use 32px outer padding, reduced to 16px below 650px.
- Use a pale background (`#f5f7fb`) and dark text (`#14233b`).
- Set body text to 16px with 1.55 line height.
- Use white cards with 24px padding and 24px vertical spacing.
- Give cards a 1px `#d9e0eb` border and 12px radius.
- Use blue links (`#164ac4`) and muted metadata (`#526278`).
- Show explicit status words, with green passed, red failed, amber blocked/not-tested.

### Index page order

1. **Title and versions.** Name the base and current branch. Show their exact SHAs, capture date and comparison count.
2. **Capture method.** Describe fixture equivalence, roles, viewports, sequential state changes and environment-only adjustments. Explain any meaningful mismatch.
3. **Coverage.** Show a table with Scenario, Status and Evidence columns. Keep narrow-screen table overflow inside its own wrapper.
4. **Combined review, findings and checks.** Show the separate QA/review outcomes, combined conclusion, review mode and exact reviewed SHAs. Render the merged comments inline, with source tags, severity, origin, status, file:line, problem, proof and suggested fix. Link paired screenshots where relevant and local proof/patch/trial artifacts. Include earlier-comment statuses for rechecks and reasons for blocked/skipped review. Then list checks actually run and their results. The raw lead report is supporting evidence, not a substitute for readable comments on this page.
5. **Comparison cards.** One card per scenario, following the format below.
6. **Manual testing.** Give reproduction steps, local before/after URLs and fixture reset instructions when relevant.
7. **Limitations.** State unresolved issues, blocked or untested paths and environmental failures. Distinguish them from passing checks.

### Each comparison card

Show a descriptive heading, explicit status and muted metadata for viewport dimensions, role and route. Then show reproduction steps and three short paragraphs: **Before**, **After**, and **Why this matters**. Explain how the observed outcome proves or disproves the branch's claim; label unchanged outcomes as regression checks.

Display original screenshots in two equal-width columns with a 16px gap, aligned at the top. Label them **Before: base branch** and **After: current branch**. Below 650px, stack Before above After. Images use `width: 100%` and natural height, never a fixed crop or forced equal height. Make each image clickable to its original full-size file and use descriptive alt text. Preserve genuine screenshot overflow and disclose differing image dimensions.

Include a link to an individual comparison page. That page repeats the scenario details and screenshot pair, with an **All comparisons** link back to `index.html`. All pages and image links use relative paths inside the current report directory. Never link to evidence from an old temporary report.

## Build and validate the report

The manifest format is embedded below. The bundled `scripts/build_report.py` is an implementation helper installed with this skill, not an external design reference. Use it to generate the index and individual comparison pages. Apply any required presentation details from the specification above that the helper does not yet emit.

```bash
python3 <skill-directory>/scripts/build_report.py <new-report-directory>/manifest.json
```

Create every QA run under `<worktree-root>/tmp/visual-qa/<YYYYMMDD-HHMMSS>/`, using the root returned by `git rev-parse --show-toplevel` in the worktree being tested. Resolve this root before switching to a base checkout. Keep the manifest, original screenshots, supporting evidence and generated pages together in that run directory. If the timestamp already exists, append a numeric suffix; preserve earlier reports. Do not default to system `/tmp`, another worktree or an arbitrary output directory. Use another destination only when the user explicitly requests it. Reserve `index.html` and `comparisons/<id>.html` for generated pages; keep source screenshots and evidence at separate paths and never use output symlinks. The report is a disk-openable artifact: do not start an HTTP server to preview or deliver it, and do not publish it externally unless explicitly requested.

For Cohabit runs, the builder also renders the `review` summary and merged comments directly on the index. Code-only comments do not require screenshot cases. The builder arranges screenshots. It must not generate or alter evidence. Missing screenshots require blocked/not-tested status, not mockups. Coverage determines the number of comparisons.

Open `index.html` directly from disk in the same browser window and tab. Inspect the report and representative comparison pages, verify every local link and image, and check the mobile layout. If the browser tool blocks local-file navigation, validate local links and assets programmatically and disclose the browser-preview limitation; do not start a report server as a workaround.

Finish with the full, copyable file URL of the generated `index.html`, shown as inline code, such as `file:///absolute/path/to/report/index.html`. Use the actual absolute path for this run, with no ellipsis or placeholder; URL-encode spaces and other reserved path characters. Also include a clickable absolute filesystem link, such as `[Open visual QA report](/absolute/path/to/report/index.html)`, plus the combined outcome, review status and key findings. Link the one report rather than delivering separate visual and code-review destinations. State that no code was changed. Never substitute a localhost URL for the report file link. The HTML, screenshots and comparison pages must remain usable with all servers stopped. Before finishing, stop every application server and asset watcher started by this QA run, including base, current, and trial-fix processes. Track their PIDs and ports when starting them, stop only those owned processes, and verify that they have exited and their ports no longer have owned listeners. Perform the same cleanup when QA is blocked or fails. Preserve servers that were already running before the run. Record cleanup results in the report; do not leave QA servers running for reproductions unless the user explicitly asks.

## Embedded report manifest

Place `manifest.json`, original screenshots and evidence in the new report directory. The relative filenames below describe files to create for this run, not existing reference files to locate. The builder uses only Python's standard library and emits `index.html` plus `comparisons/<id>.html`. All text is escaped, image paths must resolve inside the report directory, and generated links are relative. Images remain unchanged.

Required top-level fields: `title`, `base`, `current`, `method`, `coverage`, `cases`. Base/current each contain `ref` and `sha`. Optional: `findings`, `checks`, `limitations`, `manual_steps`, `evidence`, `live_urls`, `review`. `review` is required by this workflow for Cohabit runs; old manifests and non-Cohabit runs remain supported without it.

Each coverage entry has `scenario`, `status` and `evidence` (plain text). Status is `passed`, `failed`, `blocked` or `not-tested`. This is the coverage ledger; include unexercised relevant scenarios here.

Each case requires `id` (lowercase slug), `title`, `status`, `viewport`, `role`, `route`, `steps` (list), `before_text`, `after_text`, and `why`. Supply `before_image` and `after_image` as relative paths for passed/failed comparisons. Blocked/not-tested cases may omit images and must explain the missing evidence. The builder refuses a passed/failed case without both images.

`evidence` is a list of `{ "label": "Code diff", "path": "branch.diff" }` local artifacts. `live_urls` is a list of `{ "label": "Base app", "url": "http://localhost:3030/" }`. Never include real credentials in the manifest; give local QA access instructions separately when needed.

### Cohabit review manifest

`review` contains `status` (`passed`, `failed`, `blocked`, `not-tested`), `mode` (`review`, `recheck`, `reused`, `skipped`), `verdict`, `combined_status` (the same four statuses), `combined_result` (explanation), `head_sha`, `base_sha`, `integration_status` (the same four statuses), `integration` (what actually ran and its outcome), `summary`, `comments`, and optional `evidence` (the same local label/path objects as above). The builder rejects a combined pass unless review and integration passed, all coverage passed, and no introduced critical/high/medium comment remains unresolved. SHAs must match the top-level comparison; a differently reviewed version is supporting historical evidence, not the current review.

Each merged comment requires `id` (stable lowercase slug), `title`, `severity`, `origin`, `status`, `location`, `sources` (list), `problem`, `proof`, `fix`. Preserve the review's severity and status labels. Optional `case_ids` links existing comparison cases; optional `evidence` links local proof logs, suggested diffs and trial screenshots. Evidence links must point inside the run directory. Do not repeat merged comments in the legacy `findings` list. Keep a code-only comment here without a screenshot case.

```json
"review": {
  "status": "failed",
  "mode": "review",
  "verdict": "Request changes",
  "combined_status": "failed",
  "combined_result": "Changes required: one confirmed introduced issue",
  "head_sha": "same-as-current-sha",
  "base_sha": "same-as-base-sha",
  "integration_status": "passed",
  "integration": "Head merged into pinned origin base without conflicts",
  "summary": "Four review lenses completed. Browser and code evidence merged below.",
  "comments": [{
    "id": "duplicate-write",
    "title": "Retry creates a duplicate record",
    "severity": "HIGH",
    "origin": "introduced",
    "status": "OPEN",
    "location": "app/services/example.rb:42",
    "sources": ["Codex", "visual QA"],
    "problem": "Submitting the same request twice creates two records.",
    "proof": "The isolated reproduction persisted two rows on head and one on base.",
    "fix": "Make the write idempotent; see the trial patch.",
    "case_ids": ["duplicate"],
    "evidence": [{"label": "Proof output", "path": "review/duplicate-proof.txt"}]
  }],
  "evidence": [{"label": "Full lead review", "path": "review/report.md"}]
}
```

Example shape, replace all example content with observations:

```json
{
  "title": "Develop vs current branch",
  "base": {"ref": "origin/develop", "sha": "exact-base-sha"},
  "current": {"ref": "fix/example", "sha": "exact-final-sha"},
  "method": "Separate checkouts and cloned QA databases. Identical records, role and inputs. Captured on YYYY-MM-DD.",
  "findings": ["New Business header overflows at 375px (pre-existing on develop); case header-375. Suggested fix: fixes/header-375.diff, trial worked."],
  "checks": ["Focused request specs: 12 examples, 0 failures."],
  "limitations": ["Concurrent HTTP requests were not exercised."],
  "coverage": [
    {"scenario": "Repeat creation", "status": "passed", "evidence": "422 and unchanged row count; case duplicate"}
  ],
  "cases": [{
    "id": "duplicate",
    "title": "Duplicate submission",
    "status": "passed",
    "viewport": "1440 × 1000",
    "role": "QA administrator",
    "route": "/opportunities",
    "steps": ["Open Add new.", "Choose the same building and submit valid values."],
    "before_text": "Base creates a second row.",
    "after_text": "Branch shows an inline error and retains one row.",
    "why": "The rejected write prevents duplicate open records.",
    "before_image": "before/duplicate.png",
    "after_image": "after/duplicate.png"
  }],
  "evidence": [{"label": "Complete branch diff", "path": "branch.diff"}],
  "live_urls": [{"label": "Current app", "url": "http://localhost:3031/"}],
  "manual_steps": ["Sign in using the local QA account.", "Repeat the scenario steps above."]
}
```

Distinguish the branch's intended fixes from regression checks that intentionally look unchanged. For sequential scenarios, describe state accumulation and when each screenshot was taken. List known environmental errors separately from application failures. For worktrees with dirty changes, identify exactly which changes were included.
