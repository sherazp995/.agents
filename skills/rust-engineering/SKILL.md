---
name: rust-engineering
description: Rust systems, compiler and FFI checklist. Use when building or reviewing Rust code - unsafe blocks, lifetimes and ownership, allocation and drop order, async panic safety, FFI and repr(C) layouts, ABI tables, performance-critical paths, or compiler and runtime work (parser, type checker, MIR lowering, codegen, drop elaboration, diagnostics). Includes the standing rules for the riven compiler project.
---

# Rust engineering

The project's own `CLAUDE.md`/`AGENTS.md`, ADRs and memory win over this skill. Read the surrounding system first: who owns and allocates what, what runs in which context, what the ABI contract is.

## Questions to ask

- Reaching for `unsafe`: which invariant is asserted, and where is it documented?
- Reaching for `Arc<Mutex<T>>`: does the data need sharing at all?
- Reaching for a macro: would three explicit functions be clearer?

## Priorities

1. **Correctness under the real constraints:** panic safety in async, aliasing in unsafe, drop order during unwinding, ABI compatibility across libc versions, monomorphization growth, repr(C) layout per target.
2. **The cost of every allocation:** heap or stack, owner, where the destructor runs, a panic mid-construction.
3. **Lifetime clarity:** name a non-obvious borrow; write an elided lifetime the reader would have to think about.
4. **Compile-time guarantees over runtime checks:** type state, sealed traits, `#[non_exhaustive]`, const generics.
5. **Honest performance:** measure first; a benchmark hotspot is not a production hotspot.

## Compiler and runtime rules

- IR invariants are checkable; every `unreachable!` gets a comment saying why it is unreachable.
- **One ABI source of truth, in code:** derive runtime signatures from their declarations, and update every backend (AOT, JIT, others) together. Drift is a silent miscompile or a link error.
- **FFI:** repr(C) on every struct that crosses the boundary; heap structs get explicit drop helpers on both sides; never assume a libc version.
- **Drop elaboration:** every allocation has its matching free on the right side, in the right order.
- **Correct and slow over fast and subtly wrong.**
- **Registered error codes:** every emitted code has a registry entry and a long-form explainer in the right namespace range. Check that the registry test walks the current tree and is not passing vacuously.
- **No silent stubs:** an unknown method or unimplemented runtime function fails loudly, unless an ADR sanctions the no-op.
- **No new upward edges:** later phases never import earlier-phase internals; standard library sources reach the compiler only as embedded data or build inputs.
- **One front end for every tool:** compiler, REPL, IDE, LSP and formatter share lexer, parser, type checker and formatter. Keep a parity test that parses every shipped source file, with no skips.
- **Fixtures per language feature:** a positive end-to-end fixture with expected output and a negative test asserting the error code.
- **No new skipped tests:** no `#[ignore]`, `cfg` skip or "fix later" for a regression.
- **Cap leak-prone runs** under a memory limit; exceeding it is a leak to fix.
- **Docs travel with code:** a doc comment for every new public item, one CHANGELOG entry per user-visible change.
- **Trust the filesystem over docs:** verify the real layout before editing, but still apply the rules those docs state.
- **No crate without a case:** the std-only alternative, transitive footprint, maintainer. **No abstraction for one use:** a trait with one impl is a function.

## Working a change

1. Orient: recent CHANGELOG entries, `git log --oneline -20`, the relevant specs and error docs.
2. Find every layer the feature threads (parser, name resolution, type checking, MIR, codegen, runtime, standard library, fixtures) before editing.
3. Red, green, refactor against the real surface (real fixtures or the real lexer, parser and lowerer, never a mocked symbol table or HIR). Confirm the test fails for the expected reason.
4. Narrow tests each step; the full workspace and end-to-end fixtures once per phase (rules 41-42).
5. Report cross-layer impact with file:line: compiler, runtime, standard library, ABI table, error registry, changelog, fixtures.

## The riven compiler project

- Cap `rivenc` and any leak-prone process at 8 GiB RSS (macOS `ulimit -v` does not work; use a ps-polling wrapper).
- Never push, never open PRs; local commits are fine. No `Co-Authored-By` trailers.
- No `git reset --hard` to fix a regression (fix forward); no `git checkout <branch> -- file` to resolve conflicts (read both sides and edit).
- No `#[ignore]`, no `riven_noop_passthrough`, no mocked HIR, no dead-code bypasses. Every new error code needs `docs/errors/<code>.md`.
- Cache test output in `tmp/test-cache/` (rule 41).
