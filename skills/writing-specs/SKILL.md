---
name: writing-specs
description: Rules for writing, reviewing and trimming tests (RSpec, Minitest, request specs, policy specs, model and service specs). Use whenever you add or change a spec, write tests for a fix or feature, review a PR's tests, or the user asks to cut spec size or duplication. Defaults to minimal but strong regression coverage. Reuse existing examples, justify each added scenario, and keep request specs small without losing distinct authorization or failure paths.
---

# Writing specs

Part 0 is how much to test and whose advice this follows. Part 1 is how each
example is written. Part 2 is how many examples exist and at which layer, which
is where size and duplication come from. Part 3 is the trim checklist. Apply all
of it to every spec you write or review.

**Two modes.** When you are *writing or fixing* specs as an authorized task,
edit the specs that task covers: the ones your change adds or touches, plus any
existing spec the user explicitly asked you to trim. When you are *reviewing* (a
PR, a self-review under the global review protocol, general-review), don't edit.
Keep the keep/move/duplicate/padding marks as working notes and report only real
defects (a move, a duplicate, padding, dead code, a denial missing a half) with
their evidence; an example marked keep is not a finding. Never fix a
pre-existing spec you weren't asked to touch; surface it for the user (global
review protocol, rule 44).

Running specs (caching output, narrow runs) is covered by global rules 41 and 42.

---

## Part 0: how much to test

Test what the code does, not how it does it. Skip tests that only repeat a
framework declaration, and spend the effort on real logic and edge cases.

### Default: minimal but strong

Choose the smallest set of examples that protects the changed contract and its
credible regressions. Start by strengthening an existing example, not adding a
new file or a case for every line touched.

Before adding an example, name the distinct failure it catches and why existing
coverage cannot catch it. An untested line or a reviewer's request for more tests
is not sufficient by itself. Keep separate cases for distinct authorization
mechanisms, boundary conditions, and real crashes; remove repeated setup and
assertions that protect the same behavior.

When a shared lookup changes, use one representative conflicting-data case at
the layer that consumes it. Do not enumerate every unchanged presentation branch
just because each can be independently mutated. For example, a banner switched
to the acting company's membership needs a conflicting-membership regression,
not another test for every pre-existing banner state. Add another state only if
its changed logic or known risk requires it.

Combine assertions for the response, write, and controller-owned side effects of
the same request scenario. Do not combine unrelated scenarios merely to lower
the example count. Ratios trigger a trim review, not an arbitrary deletion quota.
Stop once meaningful changed behavior is protected; report retained distinct
cases and before/after counts when trimming.

### DHH's 7 don'ts ("Testing like the TSA")
1. Don't aim for 100% coverage.
2. Code-to-test ratios above 1:2 is a smell, above 1:3 is a stink.
3. You're probably doing it wrong if testing is taking more than 1/3 of your time. You're definitely doing it wrong if it's taking up more than half.
4. Don't test standard Active Record associations, validations, or scopes. (Rule 49.)
5. Reserve integration testing for issues arising from the integration of separate elements (aka don't integration test things that can be unit tested instead). (Rule 53, Part 2.)
6. Don't use Cucumber unless you live in the magic kingdom of non-programmers-writing-tests.
7. Don't force yourself to test-first every controller, model, and view (his ratio is typically 20% test-first, 80% test-after).

### Expert positions
Most rules in this skill trace back to one of these sources; the rest are house
conventions. Cite the source when a reviewer asks "why".

| Who | Position | Where it shows up here |
|---|---|---|
| **DHH / Rails core** (rails#18950) | Controller tests assert the response code, cookies, rendered DOM (`assert_select`) and DB changes. Never `assigns` or `assert_template`: "That's grossly overstepping the boundaries of what the test should know about." | Rule 30, S5, S6 |
| **DHH**, "System tests have failed" (2024) | Model and controller tests "do better and cheaper". Keep system tests to a small smoke test layer and check look and feel by hand. | S1, rule 53 |
| **DHH**, "Testing like the TSA" | The 7 don'ts above. No tests for associations, validations or scopes. | Rule 49 |
| **Rails team and RSpec core team** (RSpec 3.5 release) | Write request specs, not controller specs. Request specs "involve the router, the middleware stack, and both rack requests and responses". | S2 |
| **Kent Beck** | Test as little as possible to reach a given level of confidence. | Rule 52 |
| **Ham Vocke** (martinfowler.com) | Test pyramid: "The more high-level you get the fewer tests you should have." Set up, call, assert. "If a higher-level test spots an error and there's no lower-level test failing, you need to write a lower-level test." | Rule 53, S1, S3 |
| **Evil Martians** (Action Policy testing guide) | Controller tests check *that* authorization happened; the rules themselves are tested in policy specs. | S1, S3 |
| **Jason Swett** | Shoulda matchers test implementation; test behaviour. Separately, he skips request specs by default and relies on model specs plus a few feature specs. | Rule 49, S2 |
| **thoughtbot** | "Let's Not": helper methods over `let` (avoids the "Mystery Guest"). Defends Shoulda matchers: each matcher "builds an isolated setup focused only on the behavior under test", so it can't pass for the wrong reason, and specs read like documentation. | Rule 34, rule 49 |

### When the experts disagree
Precedence: **project convention, then this skill and `~/.agents/AGENTS.md`, then the experts.** Project convention means what the project's instruction files and existing spec files already do; it decides style, not whether to test. Known splits:
- **Fixtures vs factories.** DHH and the Rails default use fixtures. Rule 31 below says FactoryBot. Use factories unless the project is built on fixtures.
- **Request specs at all.** The Rails and RSpec teams recommend them; Swett mostly skips them. Write them, but only within the S2 budget.
- **Shoulda matchers.** thoughtbot says keep them; DHH and Swett say skip them. New specs skip them (rule 49); a file that already uses them keeps its style.
- **`let`.** RSpec docs use it; thoughtbot says don't. New examples use helper methods (rule 34). In a file built on `let`, reuse its existing `let`s instead of rebuilding the same setup.

---

## Part 1: writing each example

### 30. Test behavior, not implementation
Verify what the code does, not how. Avoid testing private methods directly; exercise them through the public API.

**Don't:**
```ruby
it 'calls #normalize_email internally' do
  expect(user).to receive(:normalize_email)
  user.save
end
```

**Do:**
```ruby
it 'stores the email lowercased' do
  user = User.create!(email: 'Foo@Bar.COM')
  expect(user.reload.email).to eq('foo@bar.com')
end
```

### 31. Use factories, not fixtures
Prefer FactoryBot for test data. Keep factories minimal: only set attributes the test cares about.

**Don't:** fixtures committed in `test/fixtures/users.yml` with 40 fields
**Do:**
```ruby
FactoryBot.define do
  factory :user do
    email { 'test@example.com' }
    name  { 'Jane' }
  end
end
```

### 32. One assertion concept per test
Each test verifies one logical behavior. Multiple `expect` calls are fine when they verify the same concept.

**Don't:** one giant `it 'works'` with 12 unrelated expectations
**Do:**
```ruby
it 'creates the user with the given email'
it 'sends a welcome email'
it 'enqueues an onboarding job'
```

### 33. Name tests descriptively
Test names should read as sentences.

**Don't:** `it 'test subscription'`
**Do:** `it 'returns nil when the user has no subscription'`

### 34. Use helper methods, not `let` / `let!` (thoughtbot convention)
Prefer plain methods over `let` for test setup. Explicit methods make dependencies visible at the call site, avoid memoization surprises across examples, and stay greppable.

**Don't:**
```ruby
describe Foo do
  let(:user)    { create(:user) }
  let(:company) { create(:company, owner: user) }

  it 'does something' do
    expect(described_class.new(company).call).to be_truthy
  end
end
```

**Do:**
```ruby
describe Foo do
  it 'does something' do
    expect(described_class.new(build_company).call).to be_truthy
  end

  def build_company
    create(:company, owner: create(:user))
  end
end
```

### 49. Don't test framework declarations
Don't write tests whose only job is to restate a declaration: associations, validations, scopes, enumerations, callbacks. Rails already tests those. If a declaration drives real behaviour, test that behaviour through the public API instead. (DHH, "Testing like the TSA": "Don't test standard Active Record associations, validations, or scopes.")

**Don't:**
```ruby
it { is_expected.to belong_to(:building) }
it { is_expected.to validate_numericality_of(:occurrence_financial_year).only_integer.allow_nil }
```

**Do:**
```ruby
it 'falls back to the financial year when there is no date' do
  expect(next_encounter_text(next_encounter: nil, occurrence_financial_year: 2013)).to eq('FY 2013')
end
```

When a spec file already uses matchers and the team keeps them, match the file's style rather than mixing two styles for the same kind of check.

### 50. Every new test must be able to fail
A test that cannot fail is noise. Before calling a test done, break the code it covers once (remove the guard, flip the boundary, drop the config) and watch the test go red, then restore. Record the mutation in the review or PR.

A mutation counts when the example fails *because of the behaviour you changed*: an assertion failure, or a runtime error the change itself causes (turning `user&.name` into `user.name` and getting `NoMethodError` on nil is a valid result). Judge by the failure's cause, not the count: a single-example run is supposed to go fully red. The mutation is invalid, so redo it and don't report it, when the output is a `SyntaxError`, a load error, RSpec's "errors occurred outside of examples", or an error unrelated to the behaviour (a dangling `.first` after deleting part of a chain, a stray `end`, a typo'd name). Run `ruby -c <file>` on the mutated file when in doubt.

When a mutation survives, trace whether the line can run at all before writing a test. If no caller can reach it (a flag nothing reads later, a callback whose condition the path never meets), it is dead code. In an authorized task, delete it (rule 35) and correct any PR claim that relied on it; in a review, report it. Don't write a test to prove dead code works.

**Don't:** ship a spec that passed on the first run and was never seen failing.
**Do:**
```bash
# drop the guard, run, expect a failure, restore byte-identical, rerun green
bundle exec rspec spec/models/schedule_spec.rb -e 'hides the inferred year'
```

### 51. When testing a change, prove the transition
If a test asserts that something changed (cleared, updated, withdrawn), assert the state before the change too. Otherwise the test passes when the "before" never happened.

**Don't:**
```ruby
sync(id, year: 2013)
sync(id, year: nil)
expect(Schedule.find(id).occurrence_financial_year).to be_nil # passes even if 2013 was never stored
```

**Do:**
```ruby
sync(id, year: 2013)
expect(Schedule.find(id).occurrence_financial_year).to eq(2013)

sync(id, year: nil)
expect(Schedule.find(id).occurrence_financial_year).to be_nil
```

### 52. Test as little as possible to reach confidence
Spend tests on logic that can be wrong: conditionals, fallbacks, boundaries, data transitions, and the mistakes the team has actually made. Skip trivial code (getters, pass-through wrappers, unchanged paths already covered). One example per behaviour, not one per line. (Kent Beck: "test as little as possible to reach a given level of confidence.")

**Don't:** add a spec for every method the diff touched.
**Do:** list the behaviours the change introduces and cover each once, including the edge case a reviewer found.

### 53. Structure: set up, call, assert
Each example sets up its data, runs one behavioural scenario, and asserts the result (Ham Vocke, The Practical Test Pyramid). One scenario usually means one call; a transition (rule 51), a retry or an idempotency check needs the sequence of calls that scenario is made of, with the "before" asserted in between. Reserve integration and request specs for problems that only appear when pieces are combined; unit test what can be unit tested.

**Don't:** a request spec that only proves a model method's return value.
**Do:** unit test the model method; add an integration spec only for the wiring (config plus engine, controller plus view).

---

## Part 2: size and duplication

The Rails and RSpec teams recommend request specs over controller specs. That
settles *how* to test a controller. It does not mean every rule belongs in a
request spec. Most oversized spec files come from testing the same rule at two
layers, or testing a whole permission matrix over HTTP.

### S1. Put each rule at its lowest layer
| What the code decides | Where the examples go |
|---|---|
| Who may do what (roles, membership states, ownership) | Policy spec: `permissions` blocks and `Scope#resolve` |
| Business logic (calculations, state changes, side effects) | Model or service spec |
| Which rows a query returns, and in what order | Model scope or query object spec |
| What a partial or component shows | View or component spec |
| The controller wires these together correctly | Request spec |

**Don't:** a request spec per role and per membership state.
**Do:** the matrix in the policy spec; the request spec proves the controller calls the policy.

### S2. Request spec budget per action
For each controller action, write only:
1. One happy path: status or redirect, plus the main DB change.
2. One denial per *distinct mechanism* the action uses. A scope miss (404), a policy `false` (redirect or 403), and no sign in are three mechanisms. Five roles that all hit the same policy `false` are one.
3. Side effects the controller itself owns (a job it enqueues, a flash, a param it strips or ignores).
4. Each failure response the controller renders itself, once: invalid input (422 with the errors the page shows), a stale state it refuses (e.g. an already paid order), a provider error it hides.

Anything beyond this needs a reason: a distinct integration contract the four above don't reach, or a bug that only showed up when the pieces were combined.

### S3. Never test the same behaviour twice
Before adding an example, name the behaviour and the line or branch in app code it protects. Two examples are duplicates only when they protect the same behaviour **and** no mutation breaks one without breaking the other. Sharing one failing mutation is not enough:
- `age >= 18` tested with 18 and with 19: removing the guard breaks both, but flipping `>=` to `>` breaks only 18. Both stay; 18 is the boundary.
- A policy spec and a request spec both go red when the policy rule breaks, but only the request spec goes red when the controller stops calling `authorize`. Both stay; they protect different things.

When two examples really are duplicates, keep the one at the lower layer.

**Don't:** `schedule_policy_spec.rb` denies a pending manager, and `schedule_access_spec.rb` also denies a pending, an invited and an archived manager.
**Do:** the membership states live in the policy spec; the request spec keeps one denial that proves `authorize` is wired.

### S4. Table-driven examples only when each row can fail on its own
`{ approve: ..., reject: ..., archive: ... }.each` is fine when each action has its own code path. Going through the same guard is not enough to call a row padding: with `%i[approve reject archive].include?(action)`, removing `reject` from the list breaks only the `reject` row. Apply S3 to each row; a row is padding only when no mutation can break it without breaking another row too.

### S5. A denial of a write asserts both halves
In a request or service spec, a denial of an action that could write checks the outcome (status, redirect, raised error, failed result) **and** that nothing changed (no DB write, no job, no provider call). Checking only one half lets a wrong response or a silent write pass. A policy spec has no response or write; it asserts the decision (`not_to permit`) or the scope result.

### S6. Assert what the user gets
Prefer the HTTP result (`have_http_status(:not_found)`, `redirect_to`) over an exception. What a request spec sees depends on two things; check both before choosing the assertion:
1. A `rescue_from` in the controller or `ApplicationController` handles the exception first and renders its own response (e.g. `Pundit::NotAuthorizedError` redirecting with a flash). Assert that response.
2. Otherwise `config.action_dispatch.show_exceptions` in `config/environments/test.rb` decides. The Rails 7.1+ default `:rescuable` renders the real 404, so assert the status. Under `:none` the exception reaches the spec, and `raise_error(ActiveRecord::RecordNotFound)` is the assertion. Follow the project's setting; don't change it inside a feature PR.

### S7. One file per behaviour area, and keep it small
Name request spec files after one area (`schedule_access_spec.rb`), and keep permissions, page markup and sort order in separate files or lower layers. Measure size against the code it covers, not a fixed line count: compare the spec's lines with the lines of app code it exercises. DHH gives this ratio for a whole codebase: "Code-to-test ratios above 1:2 is a smell, above 1:3 is a stink." Using it per file is this skill's rule of thumb, not his. Past 1:2, stop and apply S1 to S4 before adding more; a request spec several times longer than its controller action usually means the permission matrix belongs in a policy spec.

### S8. Stubs stay at the boundary
Stub external services (payment provider, mailers that call out, Sidekiq workers) once in a `before` block. Don't stub the app's own policies, services or models inside a request spec; that turns it into an implementation test (rule 30).

---

## Part 3: trim checklist

Run this on every spec file you add or touch, and on any PR's specs when reviewing. In review mode, run steps 1 to 4, 6, 7 and 8 without editing the PR, and report only the defects (see "Two modes" above).

Review mode still runs mutations (step 7). Do it in a throwaway worktree on the PR's head commit, never in the author's checkout or yours. Restore each mutated file byte-identical, and confirm `git status` is clean before reporting. Breaking a line and restoring it is not editing the PR. Skipping mutations is how a review passes dead code and untested branches: every example looks like a keep until something is broken.

1. List every example with the framework's own runner, not a text search. RSpec: `bundle exec rspec <file> --dry-run --format documentation` (includes `specify`, `example`, shared and generated examples). Minitest: `bin/rails test <file> -v` (or `ruby -Itest <file> -v`), which prints every test it runs, including `describe`/`it` spec style. Use grep only as a supplement.
2. For each, write the behaviour and the app line or branch it protects, and its layer.
3. Mark each one: **keep**, **move** (belongs lower, S1), **duplicate** (S3), or **padding** (S4).
4. Plan any production code the moves need (folding a concern into a model, extracting a service). Check the destination's size against the project's rubocop limits (`Metrics/ClassLength` and friends) *with the moved code counted*; if it would go over, pick another destination before editing anything.
5. Move the examples and code; delete duplicates and padding.
6. Check every remaining denial of a write has both halves (S5).
7. Mutation check each new or changed example (rule 50): break the line from step 2, see it fail for that reason, restore. Also break each new branch or guard in the app code the change adds, even when no example claims to cover it; a mutation nothing catches is a coverage gap or dead code (rule 50). Mutating untouched examples is only for an audit the user asked for; otherwise run just the narrow tests (global rule 42).
8. Check every behaviour claim in the PR description, ticket or commit messages against the code. Each claim needs an example that fails when you break the line that makes it true. A claim with no such example is a finding: a missing test if the line matters, or a false claim if the line is dead or the behaviour doesn't happen.
9. Run rubocop and the moved and edited spec files on the final state.
10. Report the before and after counts, e.g. "31 examples to 14; 9 moved to the policy spec, 8 deleted as duplicates".

---

## Mistakes already made (don't repeat)
- **Declared a test gap for dead code.** A line that sets a skip flag survived mutation. The code that reads the flag only runs on a path the change never takes, and the flag isn't persisted. The right fix was deleting the line, not adding a test (rule 50).
- **Reported a broken mutation as a result.** Deleting one link of a query chain left a dangling method call, so every example errored. Check the failure type before reading the result (rule 50).
- **Recommended folding a single-use concern into its model without checking size.** The model then went over `Metrics/ClassLength`. Check size before moving code (Part 3, step 4). A single-model concern is allowed by the Rails sources (Rails guide `Product::Notifications` in `app/models/product/`, DHH's `Dropboxed`, mixed "into just the Person model"), but only when it is a real trait: 37signals' "Good concerns" says a concern needs "has trait" or "acts as" semantics and should not be used as an arbitrary container "to split a large model into smaller parts". So: if the code is a trait, keep it as `Model::Trait` under `app/models/<model>/` (or the folder the project already uses, e.g. `app/models/concerns/<model>/`); if it only exists to dodge `ClassLength`, extract a plain object (service, form or value object) instead. A top-level concern shared across models follows the user's own rule, the Rule of Three (Don Roberts, in Fowler's *Refactoring*): don't extract shared code into a concern until it is repeated in three or more places. Two models with similar code keep the duplication (Sandi Metz: "duplication is far cheaper than the wrong abstraction").
- **Reviewed without mutations or checking the PR's claims.** Review mode once skipped mutations, so every example looked like a keep. Mutations then found a dead line, an untested error branch and a lookup whose `.downcase` no example needed, and the PR description claimed a protection that didn't exist (Part 3, steps 7 and 8).
- **Denial asserted only one half.** A locked request that "ignores a change" must also assert the response status (S5).

## Sources
- DHH, Rails issue #18950 (deprecating `assigns` and `assert_template`): https://github.com/rails/rails/issues/18950
- RSpec 3.5 release, request specs as the Rails and RSpec recommendation: https://rspec.info/blog/2016/07/rspec-3-5-has-been-released/
- DHH, "Testing like the TSA": https://signalvnoise.com/posts/3159-testing-like-the-tsa
- Ham Vocke, "The Practical Test Pyramid": https://martinfowler.com/articles/practical-test-pyramid.html
- Kent Beck, "How deep are your unit tests": https://stackoverflow.com/questions/153234/how-deep-are-your-unit-tests
- Jason Swett, "Don't use Shoulda matchers": https://www.codewithjason.com/dont-use-shoulda-matchers/
- thoughtbot, "What Shoulda Matchers is actually doing for you": https://thoughtbot.com/blog/what-shoulda-matchers-is-actually-doing-for-you
- thoughtbot, "Let's Not": https://thoughtbot.com/blog/lets-not
- Pundit README, testing policies: https://github.com/varvet/pundit
- Action Policy testing guide, authorization in controllers vs policy specs: https://actionpolicy.evilmartians.io/guide/testing
- DHH, "System tests have failed": https://world.hey.com/dhh/system-tests-have-failed-d90af718
- Rails guide, Getting Started, extracting a concern: https://guides.rubyonrails.org/getting_started.html
- DHH, "Put chubby models on a diet with concerns": https://signalvnoise.com/posts/3372-put-chubby-models-on-a-diet-with-concerns
- Jorge Manrubia (37signals), "Good concerns": https://dev.37signals.com/good-concerns/
- Jason Swett, on skipping request specs: https://www.codewithjason.com/use-controller-request-specs-rails-dont/
- Rule of Three (Don Roberts, via Fowler's *Refactoring*): https://en.wikipedia.org/wiki/Rule_of_three_(computer_programming)
- Sandi Metz, "The Wrong Abstraction": https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction
- Rails, controller `rescue_from` handling (`rescue_with_handler(exception) || raise`): https://github.com/rails/rails/blob/main/actionpack/lib/action_controller/metal/rescue.rb
