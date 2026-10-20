---
name: rails-engineering
description: Ruby on Rails design and review checklist. Use when building, changing or reviewing Rails code - controllers, models, ActiveRecord queries and performance, migrations, service, query and form objects, ViewComponent, Hotwire/Turbo/Stimulus wiring, RSpec, gems or a Rails upgrade. Works with the Ruby/Rails, ViewComponent and forms/Turbo rules in ~/.agents/AGENTS-RULES.md; tests follow writing-specs.
---

# Rails engineering

Apply the Ruby/Rails, ViewComponent, forms/Turbo and security rules in `~/.agents/AGENTS-RULES.md` (rules 1-16, 26-29, 38-40). The project's own `CLAUDE.md`/`AGENTS.md` wins over this skill. Tests follow `writing-specs`.

## Defaults

- Work with Rails, not against it: thin controllers, models with care, services for orchestration, query objects for complex reads, form objects for complex writes, ViewComponents for anything more structured than a one-off partial. Neither "service objects everywhere" nor "everything in the model".
- Controllers parse params, call one service or one model method, and respond.
- The model is the last line of defence: validations and database constraints there; controllers and forms layer on top.
- `turbo_frame_tag` + `form_with` for state changes, not JSON plus a custom fetch. One form with several submit buttons, not several forms. Stimulus handles client concerns only and never owns the HTTP call. Slots over manual `render_in`.

## Check before you write it

1. **Concurrency.** What happens when two requests hit this in the same second? Where is the transaction boundary, what unique index or constraint backs the rule?
2. **N+1.** Every association read in a loop is a bug until proven otherwise. Know `includes`, `preload`, `eager_load`, and `joins` + `references`.
3. **Migrations.** Reversible (`change` that is unambiguously reversible, or `up`/`down`), generated with `bin/rails g migration`, no table locks on large tables.
4. **Params.** Strong params; `permit!` is rejected.
5. **Errors.** Never `rescue Exception`; rescue the specific error you can handle.
6. **Idiom.** `find_by` over `where(...).first`; `present?`/`blank?` never on booleans; `frozen_string_literal: true`.
7. **Tests.** No database mocking without a documented reason.

## Hold the line

- **No gem without a case:** the problem it solves, what the Rails or plain-Ruby alternative costs, last release date, transitive dependencies. "It's popular" is not a case.
- **No abstraction for a hypothetical future:** a service with one caller is a method, a concern with one includer is a private method, a base class with one subclass is a class. Abstract at the third instance.

## Reporting

Concrete file paths, line numbers, the exact query, partial or slot. Separate **must fix** (correctness, security, performance regression, broken convention) from **nice to have**.
