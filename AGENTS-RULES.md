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
The rules live in the `writing-specs` skill (`~/.agents/skills/writing-specs/SKILL.md`), which keeps their numbers. Load it before writing, changing or reviewing any test. In Claude Code and Codex the `spec-guard` hook delivers it the first time a session edits a test file and reports the breaks a script can detect after every test edit; the completion-check hook reviews the judgment rules at the end of the turn.

## General

### 35. Clean up dead code
Remove unused files, partials, methods, and variables. If something has no references, delete it.

**Don't:** Leave `# TODO: remove after v2` on unreferenced helpers | **Do:** `grep -r 'method'`; if zero hits outside definition, delete it.

### 36. Don't leave TODO/FIXME without tickets
If you must leave a TODO, reference a ticket number. Otherwise fix it now.

**Don't:** `# TODO: fix this later` | **Do:** `# TODO(SCO-1234): paginate once result set exceeds 10k`

### 37. Prefer explicit over clever
Write code a new team member understands without context. Avoid metaprogramming unless it truly simplifies.

**Don't:** `%i[...].each { |attr| define_method("formatted_#{attr}") { ... } }` | **Do:** Write each method explicitly.

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
Long-running commands (cargo test, rspec, jest, etc.) run once per code state; output goes to `tmp/test-cache/`. Future questions read the cache, not re-run. Re-run with a new cache filename if code changes.

**Why:** Inspecting a cached log is instant; re-running burns minutes and context.

**Do:** `mkdir -p tmp/test-cache && cargo test 2>&1 | tee tmp/test-cache/cargo-test-baseline.log`. Later: `grep "test result" tmp/test-cache/cargo-test-baseline.log`.

### 42. Incremental (additive) changes run only their own narrow tests, not the full suite
For purely additive diffs (new files, new functions, appended entries), run only tests exercising what you added. Don't run `cargo test --workspace`, `rspec`, `jest`, etc. on every loop. Additive changes rarely break existing tests (a new name can still shadow or collide, so the once-per-phase full run below catches those); rerunning everything each cycle wastes 5 to 10 minutes.

Full integration runs happen once per phase in a dedicated task, not in every intermediate loop.

### 43. Run git from inside the repo, never with `git -C <path>`
`cd` into the repo once, then run git there. (The `git-guard` hook enforces this in Claude Code and Codex: it denies `git -C` with the same command rewritten as `cd <dir> && git ...`, so the agent reruns it without asking the user.)

### 44. Review every code change with the Unified Review Protocol (HARD REQUIREMENT)
No code change is "done" until reviewed under the protocol below with verdict **PASS**: every introduced blocker resolved, every introduced high and medium fixed. Protocol is identical for self-review, Codex, or dispatched subagents.

**Why:** A second, evidence-bound pass catches what you miss. Splitting findings by origin (introduced vs pre-existing) lets you gate regressions *this change* caused without holding it hostage to inherited debt.

**The phases:**

**P0: Load context.** Read intent/ticket. Establish diff scope (`git diff` for uncommitted, `git diff <base>...HEAD` for a branch, where `<base>` is the branch's actual base (for a PR, `origin/<its base branch>`), never assumed to be `main`). Open full touched files. Load conventions.

**P1: Understand intent.** Restate in one line what the change does and why this approach. Judge against *that*, not an imagined ideal.

**P2: Systematic dimension review:** correctness/logic, regressions/blast-radius, security, perf/N+1, data/migrations/concurrency, API/backward-compat, tests adequacy, design/smells, readability/conventions.

**P3: Classify every finding:** severity (`blocker | high | medium | low`) AND origin (`introduced | pre-existing`).

**P4: Verify every finding with evidence** before reporting. Cite `file:line`, quote code, back with code/command/source. No proof → drop it.

**P5: Apply gate.** Blockers must be fixed. High/medium introduced findings fixed now. Introduced low parked for user decision. Pre-existing never gates.

**P6: Emit template:**
```
## Review: <intent>
Verdict: PASS | CHANGES REQUIRED | BLOCKED
Counts (introduced / pre-existing): blocker A/B · high C/D · medium E/F · low G/H

### Introduced
**Blockers**: [I-1] file:line: what | evidence: code | why: impact | fix: action
**High**: [I-2] ...
**Medium**: [I-3] ...
**Low**: [I-4] ...

### Pre-existing
- [P-1] file:line: what | evidence: proof | why: impact | fix/ticket: suggestion

### Verification log
- [I-1] re-proof: read file / ran cmd / traced caller → upheld | discarded (reason)
```

When zero introduced blocker/high/medium findings, emit: `Verdict: PASS` + `✅ LGTM: No critical issues found.`

### 54. Keep exactly one unpushed commit per branch
Before committing, count unpushed commits with `git rev-list --count HEAD --not --remotes`. If one exists, fold the new work into it with `git commit --amend --no-edit` (or `--amend -m` to update the one-line message) without asking; if several exist, do not commit or squash: leave the change uncommitted and tell the user the branch needs squashing first. Never rewrite a commit that is already on a remote. (The `git-guard` hook enforces this for commits and amends in Claude Code and Codex; resets, rebases and force-pushes are on you.)

## Communication Style

### 45. Never use a dash to join clauses in prose
Use commas, periods, colons, semicolons, or parentheses instead. (Intra-word hyphens like `chat-style` are fine.)

**Don't:** "The fix works — I verified it." | **Do:** "The fix works. I verified it."

### 46. Bullet-point reports: 10 words maximum per bullet
Count strictly. No exceptions. If a point needs more, split into two bullets.

**Don't:** "Unified the two evaluation comment modals into one consistent chat-style layout with a title, thread, and composer" (17 words)
**Do:** "Unified both evaluation comment modals into one layout" (8 words)

### 47. Talk like a normal junior developer: short messages, answer first
Lead with the answer (yes/no, "nothing to do"). Long replies read as unresolved even when settled. Detail belongs in PR descriptions or tickets, not chat.

**Don't:** Bury "no action needed" under two paragraphs of conditionals. | **Do:** "No, nothing to do. The fix is verified."

### 48. Commit messages are one line, and nothing in the repo mentions Claude
One subject line, no body, unless the user asks. Never add AI or assistant attribution anywhere: commit messages, PR titles or descriptions, code comments or docs (no `Claude-Session:`, no `Co-Authored-By: Claude`, no "Generated with Claude Code"). Attribute to the user. (The `git-guard` hook enforces the commit-message part in Claude Code and Codex.)
