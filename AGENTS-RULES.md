# Development Rules — Details

All numbered rules referenced in [`AGENTS.md`](AGENTS.md).

## Ruby / Rails

### 1. Follow Ruby naming conventions
Use `snake_case` for methods/variables, `CamelCase` for classes/modules, `SCREAMING_SNAKE_CASE` only for true constants.

**Don't:** `MAX_BATCH_SIZE = ENV.fetch('BATCH_SIZE', 100).to_i` (config, not const) | **Do:** `def max_batch_size; ENV.fetch('BATCH_SIZE', 100).to_i; end`

### 2. Prefer composition over inheritance
Use modules/concerns. Keep inheritance chains shallow (max 2–3 levels).

**Don't:** `class Admin < Reporter < Exporter < Base; end` | **Do:** `class Admin; include Exportable; include Auditable; end`

### 3. Keep controllers thin
Controllers: params → service/model → respond. Business logic in models, services, or form objects.

### 4. Use strong parameters
Never `params.permit!`. Always explicitly whitelist.

**Don't:** `def user_params; params.require(:user).permit!; end` | **Do:** `params.require(:user).permit(:name, :email, ...)`

### 5. Avoid N+1 queries
Use `includes`, `preload`, or `eager_load` for accessed associations.

**Don't:** `Post.all.each { |p| puts p.author.name }` | **Do:** `Post.includes(:author).each { |p| puts p.author.name }`

### 6. Use scopes and query objects
Prefer named scopes over raw `where` chains.

**Don't:** `User.where(active: true).where('created_at > ?', 30.days.ago)` | **Do:** `scope :active, -> { where(active: true) }`

### 7. Validate at the model level
Models are the last line of defense.

**Do:** `validates :email, presence: true, uniqueness: true`

### 8. Use `frozen_string_literal: true`
Add the magic comment to every Ruby file.

**Do:** `# frozen_string_literal: true` at the top of each file.

### 9. Prefer `find_by` over `where(...).first`
More readable, returns single record or `nil`.

**Don't:** `User.where(email: e).first` | **Do:** `User.find_by(email: e)`

### 10. Don't `rescue Exception`
Rescue `StandardError` or specific error classes. `Exception` catches `SignalException`, `SystemExit`, etc.

**Don't:** `rescue Exception => e` | **Do:** `rescue Net::HTTPError, Timeout::Error => e`

### 11. Use `present?` / `blank?` idiomatically
Don't chain `present?` on booleans; use direct checks.

**Don't:** `return if admin.present?` (admin is boolean) | **Do:** `return if admin`

### 12. Keep migrations reversible
Use `change` over `up`/`down` when possible. Implement both halves if needed.

**Don't:** `def up; execute "UPDATE ..."; end` (no down) | **Do:** `def change; add_column :users, :status, :string, default: 'active'; end`

## ViewComponent

### 13. Never use `raw` or `html_safe`
Use slots, partials, and `tag.*` helpers. HTML-as-strings is brittle and an XSS vector.

**Don't:** `<%= raw "<span class='badge'>#{user.name}</span>" %>` | **Do:** `<%= tag.span(user.name, class: 'badge') %>`

### 14. Use polymorphic slots for multi-content components
Use `renders_one` / `renders_many` with `types:`. Don't manually instantiate and call `render_in`.

**Do:** `renders_many :items, types: { text: TextItemComponent, link: LinkItemComponent }`

### 15. No constants for controller names
Use a private method that returns the string.

**Don't:** `CONTROLLER_NAME = 'components--dropdowns--select-list'` | **Do:** `private def controller_name; 'components--dropdowns--select-list'; end`

### 16. Clear, use-case-driven naming
Method names describe *why* they exist, not just *what* they return.

**Don't:** `inline?` | **Do:** `within_filters?`

## Frontend / JavaScript

### 17. No double-wiring of Stimulus actions
If A internally calls B, don't wire both to the same event. B will execute twice.

**Don't:** `data-action="input->filter#apply input->filter#refresh"` with `apply() { this.refresh() }` | **Do:** Wire only `apply`; let it call `refresh` internally.

### 18. Scope DOM queries
Don't use broad selectors like `[aria-expanded="true"]`. Scope to component targets.

**Don't:** `document.querySelectorAll('[aria-expanded="true"]')` | **Do:** `this.triggerTargets.filter(t => t.getAttribute('aria-expanded') === 'true')`

### 19. Always return a visible display value
Never return `null` or empty string for displayed text. Truncate instead.

**Don't:** `v.length > 40 ? null : v` | **Do:** `v.length > 40 ? v.slice(0, 37) + '...' : v`

### 20. Avoid hard-coded locales
Use `undefined` to respect browser locale, or the app's locale config.

**Don't:** `new Date().toLocaleDateString('en-US')` | **Do:** `new Date().toLocaleDateString(undefined)`

### 21. Use `const` by default
Only `let` when reassignment is needed. Never `var`.

**Don't:** `let result = fn()` (never reassigned) | **Do:** `const result = fn()`

### 22. Prefer early returns
Avoid deep nesting with guard clauses.

**Don't:**
```js
if (user) { if (user.active) { if (user.sub) { work() } } }
```
**Do:**
```js
if (!user?.active) return; if (!user.sub) return; work()
```

### 23. No `console.log` in production code
Remove debug statements before committing.

**Don't:** `console.log('got', data)` in committed code | **Do:** Remove it or route through a logger.

### 24. Use semantic HTML
Prefer `<button>` over `<div onclick>`. Use proper ARIA and keyboard navigation.

**Don't:** `<div class="btn" onclick="submit()">Save</div>` | **Do:** `<button type="button" data-action="click->form#submit">Save</button>`

### 25. CSS: utility-first with Tailwind
Prefer utility classes. Keep custom CSS for complex animations or reusable patterns only.

**Don't:** One-off `.card-wrapper { padding: 16px; }` | **Do:** `class="tw-p-4 tw-rounded-lg"`

## Security

### 26. Never commit secrets
No API keys, passwords, tokens, or credentials in code. Use env vars or Rails credentials.

**Don't:** `STRIPE_KEY = 'sk_live_...'` | **Do:** `Rails.application.credentials.stripe[:secret_key]`

### 27. Sanitize user input
Escape user-provided content in views. Use Rails' built-in escaping (`<%= %>`). Never bypass with `raw`/`html_safe` on user data.

**Don't:** `<%= raw @comment.body %>` | **Do:** `<%= @comment.body %>`

### 28. Use parameterized queries
Never interpolate user input into SQL. Use ActiveRecord methods or parameterized `where`.

**Don't:** `User.where("name = '#{params[:name]}'")` | **Do:** `User.where(name: params[:name])`

### 29. Validate file uploads
Check content type, size, and filename. Don't trust client MIME types alone.

**Do:** `validates :avatar, content_type: { in: %w[image/png image/jpeg] }, size: { less_than: 5.megabytes }`

## Testing

### 30 to 34, 49 to 53. Follow the `writing-specs` skill
The rules live in the `writing-specs` skill (`~/.agents/skills/writing-specs/SKILL.md`), which keeps their numbers. Load it before writing, changing or reviewing any test. In Claude Code and Codex the `spec-guard` hook delivers it the first time a session edits a test file and reports the breaks a script can detect after every test edit; the judgment rules no script can detect are yours to apply.

## General

### 35. Clean up the dead code your change leaves
Remove the files, partials, methods, imports and variables your change made unused. Dead code that was already there: mention it in the report and delete it only when the user asks or the task is a cleanup (rule 55).

**Don't:** Leave the old helper behind after replacing its only caller | **Do:** `grep -r 'old_helper'`; if zero hits outside its definition, delete it with the change that orphaned it.

### 36. Don't leave TODO/FIXME without tickets
If you must leave a TODO, reference a ticket number. Otherwise fix it now.

**Don't:** `# TODO: fix this later` | **Do:** `# TODO(SCO-1234): paginate once result set exceeds 10k`

### 37. Prefer explicit over clever
Write code a new team member understands without context. Avoid metaprogramming unless it truly simplifies.

**Don't:** `%i[...].each { |attr| define_method("formatted_#{attr}") { ... } }` | **Do:** Write each method explicitly.

### 55. Change only what the request needs, as simply as possible
Every changed line traces to the request or the approved plan. Write the minimum code that solves it: no features, options or configurability nobody asked for, no abstraction for a single use, no error handling for cases that cannot happen. Match the surrounding style. Do not reformat, rename or refactor neighbouring code that works. If unrelated code looks wrong, mention it instead of changing it. When the task cannot be done without an adjacent fix (broken setup, a bug that blocks the test), make it and name it in the report.

Reuse before writing: code already in the repo, then the standard library, then a native platform feature (a DB constraint over app code, CSS over JS, a native input over a library), then a dependency already installed. Write new code or add a dependency only after those. Fix a bug at its root cause: grep the callers of the function you touch and fix it once in the shared function all callers route through, not only on the path the ticket names. Simplicity never shortens the reading: understand the whole flow before choosing the smallest change. Never simplify away input validation at trust boundaries, error handling that prevents data loss, security measures, accessibility basics, or anything the user asked for.

**Why:** Unrequested edits hide the real change in the diff, widen what can break, and are the most common way an agent overcomplicates a task.

**Don't:** Fix a typo and also rename three variables and reflow the file | **Do:** Fix the typo; mention the naming in the report if it matters.

### 56. Check the official docs before using an API you are not sure of
Before writing code against a library, framework or service API you have not confirmed for the version the project uses, read its official docs (context7 first, then the vendor's site). Read the version from the lockfile (`Gemfile.lock`, `package.json`/lockfile). Name the doc and version in the report when the choice was not obvious. Blog posts and memory are leads, not sources.

**Why:** APIs change between versions, and code from memory is the most common source of deprecated or invented calls.

**Don't:** Write a Rails 8 `normalizes` call from memory of a Rails 6 pattern | **Do:** Check the Rails 8 API docs for `normalizes`, then write it.

### 58. Save the lesson from every mistake, and fix the instruction when it repeats
A mistake is any of: the user corrects you, a review finds a bug you introduced, a fix fails twice, or a check you said passed actually fails. At the mistake, without being asked:

- Search memory first (`agents-hub memory show`, plus the promoted ones in `~/.agents/memory/.promotions.json`).
- No match: save a `feedback` memory with **Why:**, **How to apply:** and an `Incidents:` list (date, repo, what happened). Claude Code writes its memory file; other agents use `agents-hub memory add --type feedback`.
- A match from a different incident with the same cause (the same incident twice does not count): write the fix into the owning rule, skill or test yourself with a scoped edit, add the incident and a `Promoted: <file> <date>` line to the memory (Claude Code edits the file; other agents add a new one with `--supersedes`, carrying the incidents over), and list the edit under "Learned" in your report. The user can undo it.
- Read-only agents (reviewers, advisors, checkers) report lesson evidence to the agent that started them, which saves it. `done-check` audits that every incident in a finished turn has its lesson.

**Why:** A lesson nobody writes down is learned again at the user's expense, and one that repeats belongs in the instruction itself, not in a note.

**Don't:** Apologise for pushing to the wrong branch and move on | **Do:** Save the lesson; if it happened before, add the check to the rule that should have caught it.

## Forms & Turbo (Rails + Hotwire)

### 38. Default to Turbo + `form_with` for state-changing actions
For any mutation, use Rails form via Turbo (`<form_with>` in `<turbo_frame_tag>`, controller responds via `turbo_stream`). Reach for `@rails/request.js` or raw `fetch` only when no semantic form exists (AG Grid, lazy-loaded selectors, JSON read APIs).

Avoid reinventing form encoding, CSRF setup, error toasting, and DOM swap code that Turbo gives you for free.

### 39. One form, multiple submit buttons — don't split into N forms
Use one `<form>` with two `type="submit"` buttons differentiated by `name=...`. Two separate forms orphan inputs and break layout.

### 40. Gate `connect()`-time analytics behind a Stimulus value when the frame is replaced
`connect()` fires on every Turbo swap. If it reports an impression, gate it on a Boolean value from the server — otherwise original → follow-up → success fires three "seen" events for one actual impression.

**Do:** Pass `data-component-track-impression-value="<%= state == :original %>"` and check it in `connect()`.

## Tooling & Workflow

### 41. Cache test/build output instead of re-running unchanged commands
Long-running commands (cargo test, rspec, jest, etc.) run once per code state; output goes to `tmp/test-cache/`. Future questions read the cache, not re-run. Re-run with a new cache filename if code changes. (The `related-tests` hook keeps its own cache under `~/.agents/tmp/test-cache/related-tests/`; manual logs like these stay repo-local.)

**Why:** Inspecting a cached log is instant; re-running burns minutes and context.

**Do:** `mkdir -p tmp/test-cache && cargo test 2>&1 | tee tmp/test-cache/cargo-test-baseline.log`. Later: `grep "test result" tmp/test-cache/cargo-test-baseline.log`.

### 42. Incremental (additive) changes run only their own narrow tests, not the full suite
For purely additive diffs (new files, new functions, appended entries), run only tests exercising what you added. Don't run `cargo test --workspace`, `rspec`, `jest`, etc. on every loop. Additive changes rarely break existing tests (a new name can still shadow or collide, so the once-per-phase full run below catches those); rerunning everything each cycle wastes 5 to 10 minutes.

Full integration runs happen once per phase in a dedicated task, not in every intermediate loop.

### 43. Run git from inside the repo, never with `git -C <path>`
`cd` into the repo once, then run git there. (The `git-guard` hook enforces this in Claude Code and Codex: it denies `git -C` with the same command rewritten as `cd <dir> && git ...`, so the agent reruns it without asking the user.)

### 44. Review every code change; the full protocol runs on request
Every code change gets one end check before it is "done": `done-check` (doing-substantial-work step 7), or its checker prompt run once by hand where the hook is not installed. The Unified Review Protocol is the `general-review` skill, sections 1 to 6 of its SKILL.md (phases P0 to P6, verdict and report template); it runs when the user asks for a review or before a PR is opened.

Review feedback from a person, Copilot or another agent is a claim to verify against the code before acting. When it is wrong, push back with the evidence; never apply a suggestion only because a reviewer made it.

**Three fix rounds, then rethink.** A round is: the reviewer reports, you fix, the reviewer rechecks. If a reviewer still reports a high or medium finding after three rounds (new or repeated), stop patching: the approach is likely wrong, not the details. Re-read the request, list what the reviewers keep finding and the cause those findings share, and weigh a simpler or different design, a narrower scope, or keeping the change with the risk named. Tell the user the open findings, the options and your recommendation, and wait. Lows and nits never extend the loop.

**Why:** A second, evidence-bound pass catches what you miss, and one written protocol cannot drift from a copy of itself.

### 54. Keep exactly one unpushed commit per branch
Before committing, count unpushed commits with `git rev-list --count HEAD --not --remotes`. If one exists and it holds this same work (git-guard's deny names its subject), fold the new work into it with `git commit --amend --no-edit` (or `--amend -m` to update the one-line message) without asking; if it holds unrelated work, do not amend: leave the change uncommitted and report that the branch already holds it; if several exist, do not commit or squash: leave the change uncommitted and tell the user the branch needs squashing first. Never rewrite a commit that is already on a remote. (The `git-guard` hook enforces this for commits and amends in Claude Code and Codex; resets, rebases and force-pushes are on you.)

**Per-feature mode.** A repo whose root `.git-guard.json` says `{"commits": "per-feature"}` keeps one unpushed commit per feature instead of one per branch: four features, four commits. Start every subject with its feature tag, `git commit -m "[login] Add OTP form"`. A new tag gets a new commit; work on a feature that already has an unpushed commit goes into that commit, with `git commit --amend --no-edit` when it is HEAD, else `git commit --fixup=<sha>` then `git rebase --autosquash --autostash <sha>~1` (git-guard's deny gives the exact commands). If a merge or a pushed commit is anywhere from it to HEAD (it included), do not rebase: leave the change uncommitted and tell the user. Use one tag per feature the user named; never invent a new tag to get an extra commit. An amend keeps its commit's tag, and pushed commits are never rewritten.

## Communication Style

### 45. Never use a dash to join clauses in prose
Use commas, periods, colons, semicolons, or parentheses instead. (Intra-word hyphens like `chat-style` are fine.)

**Don't:** "The fix works — I verified it." | **Do:** "The fix works. I verified it."

### 46. Bullet-point reports: one short point per bullet
Each bullet carries one point the user can take in at a glance; a point that needs more becomes two bullets. The user skims reports, and long bullets read as unresolved (rule 47). A skill that sets its own line format (status-update) overrides this.

**Don't:** "Unified the two evaluation comment modals into one consistent chat-style layout with a title, thread, and composer"
**Do:** "Unified both evaluation comment modals into one layout"

### 47. Talk like a normal junior developer: short messages, answer first
Lead with the answer (yes/no, "nothing to do"). Long replies read as unresolved even when settled. Detail belongs in PR descriptions or tickets, not chat.

**Don't:** Bury "no action needed" under two paragraphs of conditionals. | **Do:** "No, nothing to do. The fix is verified."

### 48. Commit messages are one line, and nothing in the repo mentions Claude
One subject line, no body, unless the user asks. Never add AI or assistant attribution anywhere: commit messages, PR titles or descriptions, code comments or docs (no `Claude-Session:`, no `Co-Authored-By: Claude`, no "Generated with Claude Code"). Attribute to the user. (The `git-guard` hook enforces the commit-message part in Claude Code and Codex.)

### 57. Sound like a colleague talking, not a report
Answer a chat question in plain sentences, the way a sharp coworker would in Slack. Match the user's length and tone. Headers, bold and bullet lists are for content that has real structure (a plan, a list of findings), never for a quick answer. No stock openers or closers ("Great question", "Let me know if"), no recap of what they asked. Never claim to be human. The `human-conversation` skill has the details and examples.

**Don't:** "**Status:** All tasks are complete. **Next steps:** ..." for "is it done?" | **Do:** "Yes, it's done and committed. Only the push is left."
