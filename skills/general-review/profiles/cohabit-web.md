# Profile: cohabit-web

Values the PR batch mode and the ledger cannot detect for this repo. Fill the lead prompt's placeholders from here.

## Repo

- GH_REPO: `cohabitplatforms/cohabit-web`
- Match: a checkout counts when `cd <dir> && git remote get-url origin` contains `cohabitplatforms/cohabit-web`.
- Usual checkout locations to offer: `~/cohabitplatforms/cohabit-web`, `~/cohabit-web`, `~/code/cohabit-web` (only the ones that exist and pass the match).
- Base branches to offer for a branch with no PR: `staging` (Recommended), `develop`, `master`.
- Stack: Rails app with Postgres, Redis, Pundit, Stimulus, RSpec.

## TEST_SETUP

```
Right after step 1, build `{WORKDIR}/ruby-env.sh` once. Prefix every ruby/bundle/rails/rspec/rubocop command with `source {WORKDIR}/ruby-env.sh;`.
- Read the wanted version from the worktree's `.ruby-version` (drop any `ruby-` prefix).
- Find a Ruby manager that gives exactly that version. Test each in a fresh shell, in this order, and keep the first where `ruby -v` matches:
  1. Ruby already on PATH: nothing to add.
  2. mise: `eval "$(mise activate bash --shims)"`
  3. rbenv: `eval "$(rbenv init - bash)"`
  4. asdf: `. "$(brew --prefix asdf 2>/dev/null || echo ~/.asdf)/libexec/asdf.sh" 2>/dev/null || export PATH="$HOME/.asdf/shims:$PATH"`
  5. chruby: `for f in "$(brew --prefix 2>/dev/null)/opt/chruby/share/chruby/chruby.sh" /usr/local/share/chruby/chruby.sh /usr/share/chruby/chruby.sh; do [ -f "$f" ] && . "$f" && break; done; chruby <version>`
  6. rvm: `source ~/.rvm/scripts/rvm && rvm use <version>`
- Write the lines that worked into `ruby-env.sh`, plus `export RAILS_ENV=test TEST_ENV_NUMBER={TEST_ENV_NUMBER}`.
- If no manager has that version, stop and report: "Ruby <version> is not installed (checked: <managers found>). Install it and run again." Do not guess another version.
- This gives a private test DB, `cohabit_test{TEST_ENV_NUMBER}`. Postgres (user postgres) and Redis are running.
- Run `bundle check || bundle install` first. Then `bin/rails db:create db:schema:load`, plus `db:migrate` if the change adds migrations.
- Tests: `bundle exec rspec <files>`. Lint: `bundle exec rubocop <changed ruby files>`; eslint and the JS tests when JS changed.
- Ignore DEPRECATION noise.
- Sprockets "not declared to be precompiled" or missing-asset errors are a local setup problem, not a finding: run `yarn install --ignore-engines && yarn build` in the worktree.
- Drop the database at cleanup: `dropdb -U postgres --if-exists cohabit_test{TEST_ENV_NUMBER}`.
```

## PROOF_DIR

`spec/review_verify/` (request specs preferred; use the existing factories).

## STUBS

Payment providers, Sentry, mailers and background workers.

## STACK_HINTS

Pundit policies and scopes (`BuildingScopedPolicy`, `policy_scope`), service objects, decorators, form objects, Stimulus controllers. Callers live in `app/`, `lib/`, `config/`, `spec/` and `app/javascript`. Authorization is scoped by company and building; users can belong to several companies.

## Typical FOCUS risks

- payments → double charge, webhooks, CSRF, retries;
- access scoping → IDOR on ids in params, cross-company leaks, users in several companies;
- forms and JS → values carried over from a previous selection, older browsers;
- type or state changes → orphaned or deleted history, notifications.
