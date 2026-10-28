# Open questions

Deliberate deferrals, recorded so they stay distinguishable from oversights. A deferral that lives only in a git-ignored report is indistinguishable from a bug, which is why this file is tracked.

## OQ-1: should `Outbox.drain()` scope to a single workspace? (RESOLVED)

**Raised:** P0.2 Task 5, 2026-08-08.
**Status:** resolved, 2026-08-10, during the P0.3 gate fix wave (High 1).

Originally deferred: `drain()` claimed every pending row for its adapter, across all workspaces, and this doc argued nobody needed workspace scoping yet because "Relay currently serves a single operator and one workspace," and that the right shape depended on which caller needed it.

**What changed:** the P0.3 gate review (2026-08-10) pointed out that this reasoning no longer held. Task 8 of P0.3 wired `OutboundDispatcher` into a scheduled, production drain loop (`scheduleOutboxDrain`, called from `startOrchestrator`), and `OutboundDispatcher` is itself always constructed bound to exactly one workspace. That IS the caller this doc said did not exist yet: its own drain() call reads that one workspace's rows and delivers them to that one workspace's adapter, so an unscoped `Outbox.drain()` underneath it was a real, reachable cross-tenant claim, not a hypothetical one, the moment a second workspace's row happened to share an adapter name and a claim window with the first. "Nobody needs it yet" was true when this was written and stopped being true once Task 8 shipped a real scheduled drain.

**Resolution:** `Outbox` now accepts an optional `workspaceId` at construction (`OutboxOptions.workspaceId`); when set, every claim and mutation `drain()` performs adds a `workspace_id` predicate. `OutboundDispatcher` always supplies its own bound workspace id to its internal `Outbox`, closing the defect at the one place it was reachable. The underlying primitive itself is still not FORCED to be workspace-scoped: an unscoped `Outbox` (the `workspaceId` option left unset) still serves every workspace from one instance, exactly this doc's original alternative, for a caller that genuinely wants that shape; `test/chat/outbox.test.ts`'s own suite exercises an unscoped instance directly. Test: "two workspaces' rows cannot be claimed by each other's dispatcher" (`test/dispatch/outbound.test.ts`).

## OQ-2: outbox delivery is at-least-once on the timeout path

**Raised:** P0.2 Task 5 fix round 1, 2026-08-08.
**Status:** accepted limitation, stated rather than hidden.

`perform()` is bounded by a timeout so a hung adapter cannot wedge the drain. A JavaScript promise cannot be cancelled, so a timed-out call may still deliver, and the retry may then deliver again. Delivery on that path is therefore at-least-once, not exactly-once.

Preventing it would need an idempotency key carried to the chat platform and honoured by it, which no chat platform in scope offers for message posting.

This is the same class of problem as FR-ORC-1a in the requirements, which requires every mutating capability to declare an idempotency strategy and to enter `unknown_outcome` when it cannot determine what happened. **When FR-ORC-1a is implemented in phase 1, the outbox must be revisited to comply with it.**

## OQ-3: is a `message_changed` envelope's top level `ts` the edited message's ts, or the event's? (RESOLVED)

**Raised:** P0.2 Task 6 fix, 2026-08-09.
**Status:** resolved, 2026-08-09, during the P0.2 gate fix wave.

The dedupe ordering fix is correct regardless: an ignored envelope must never consume dedupe state. But its original regression test at `test/chat/slack/adapter.test.ts` built a `message_changed` envelope whose top level `ts`, nested `message.ts`, and follow up `app_mention` `ts` were all the same value, on the assumption that an edit collides with the original message's dedupe key.

**Resolution:** that assumption was false. Slack's documented `message_deleted` shape settles it: `message_deleted`'s top level `ts` is the deletion event's own timestamp, and `deleted_ts` separately names the ts of the message that was deleted, two different fields carrying two different values. `message_changed` follows the same pattern by construction, one event reporting on a distinct, previously existing message, so its top level `ts` is the edit event's own timestamp, and the target message's real ts lives only in the nested `message.ts`. The two are never the same value in Slack's real event shape.

That means the original test's premise, an edit colliding with the original message's own dedupe key, describes a collision real Slack does not produce, so it guarded nothing. The genuine risk is different and narrower: an ignored envelope must not claim a dedupe key at **its own** top level `ts` either, because an unrelated later message could legitimately arrive at that exact ts. The regression test was rewritten to build a `message_changed` envelope with a top level `ts` distinct from its nested `message.ts`, and to assert both that the envelope itself is ignored and that a later genuine message landing on the ignored envelope's own top level `ts` is still delivered. See "does not let an ignored message_changed envelope claim the dedupe key at its own top level ts..." in `test/chat/slack/adapter.test.ts`.

This was settled against Slack's documented shape, not a captured live envelope; that remains the strongest available evidence short of an operator capturing one directly, and nothing here depends on a live capture to be correct.

## P0.3 prerequisites carried from the P0.2 gate

The operator chose to fix P0.2's unambiguous bugs and carry four findings that need state or provisioning P0.2 does not have. These are commitments, not wishes. **P0.3 is not complete until each is closed.**

### PRE-1: wire the durable outbox into production
`ProgressReporter` performs posts and edits directly against the adapter, and nothing in production constructs `Outbox`. FR-CA-3's guarantee that an outbound message is never lost is therefore unwired. P0.3 owns the dispatcher that routes reporter actions through the outbox, including persisting a post result so its dependent edits can be sequenced and retried.

### PRE-2: principal provisioning, and fail closed without one
The live adapter defaults `resolvePrincipalId` to a function returning null and dispatches anyway. FR-CA-4 requires an unmapped user to be unable to start work. P0.3 must provision principals and suppress null-principal events, allowing at most the single informational reply the spec permits.

### PRE-3: map Slack's team id to a Relay workspace uuid
`ChatEvent.workspaceId` currently carries Slack's `team_id`, while `workspaces.id` is a uuid. Any call into `resolvePrincipal` or `Outbox.enqueue` with it cannot match and will fail on invalid uuid syntax. P0.3 must map team id to a workspace uuid at adapter construction and keep the platform team id separately.

### PRE-4: restore channel thread replies as a session entry point
P0.2 shipped a deliberately narrow entry rule: `app_mention` at a channel root, DMs always, and channel thread replies ignored entirely. That is narrower than FR-SL-2, which permits a reply inside an existing Relay thread. Recognising a Relay thread needs session storage, which P0.3 adds. When it does, restore thread replies and test that a reply in an UNRELATED thread is still ignored.

### PRE-5: bind a RunContext at the first session boundary
Real Slack call sites use an unbound root logger and `createRunContext` has no production caller, so FR-OBS-1's requirement that run, session, step, and principal ids ride on every line is still a library-only assertion. P0.3 creates the session boundary where a bound context belongs.

## DEC-1: the agent loop uses headless Claude Code, not the Agent SDK with an API key

**Decided:** 2026-08-09, by the operator, before Task 6 was implemented.

The P0.3 plan called for the Claude Agent SDK, which needs a separate API key. The operator declined an API key and asked whether the already-authenticated `claude` CLI could be used instead. It can. Verified empirically: `claude -p` ran on the logged-in session with no `ANTHROPIC_API_KEY` in the environment and returned a structured result.

This also removes an inconsistency of mine rather than introducing one. FR-CODE-20 already specifies headless Claude Code as the coding engine. Using a different engine for the agent loop would have meant two engines, two auth paths, and two sets of governance seams.

### What the CLI gives us, all confirmed present in version 2.1.226

- `--output-format json` returns `session_id`, `num_turns`, `stop_reason`, `total_cost_usd`, `usage`, and `permission_denials`. That last field makes policy decisions observable, and `total_cost_usd` gives FR-ORC-7 budget metering a real number to meter.
- `--output-format stream-json` emits realtime events, which is what AP-5 needs to persist a step before and after execution rather than only seeing a final answer.
- `--allowedTools` and `--disallowedTools` restrict the capability set per invocation.
- **CORRECTION, 2026-08-09.** An earlier draft of this decision and the Task 6 brief both claimed `--max-turns` bounds turns and described it as verified. **It does not exist.** Task 6's implementer checked `claude --help` on the installed 2.1.226 binary, found nothing, and flagged it before writing code rather than passing a nonexistent flag. I re-verified: zero occurrences of `max-turns`, and the only related flag is `--max-budget-usd`, a dollar cap rather than a turn cap. The claim was mine and it was not verified; I had confirmed the output-format and tool flags and then listed a turn limit alongside them without checking it. FR-ORC-8 only ever required wall-clock timeouts, at step and run level, which Relay enforces itself by wrapping the subprocess with a timeout and an abort signal. So nothing depended on the false claim, but Tasks 7 and 8 also read this decision as fact, which is why it is corrected here rather than quietly dropped. `--max-budget-usd` is worth using later for FR-ORC-7 budget metering, which is phase 1.
- `session_id` plus resume gives session continuity, which maps onto FR-SES-1.
- The project's own `CLAUDE.md`, skills, agents, and MCP servers apply, which is precisely what FR-CFG-1 to FR-CFG-13 require of the coding engine.

### The three consequences, stated because they are real

1. **Cancellation becomes termination, not cooperation.** FR-ORC-4 requires aborting a long-running tool call cooperatively within five seconds. Killing a subprocess is fast enough to meet the five second bound, but it is not cooperative: a killed engine can leave a half-finished side effect with no chance to record it. P0.3 Task 7 must state this plainly and record the run as `cancelled` with partial progress, never as cleanly stopped. The honest guarantee is "stopped within five seconds", not "stopped cleanly".

2. **Per-tool-call approval gets harder, and that lands on P0.4.** The Agent SDK offers a programmatic permission callback that can pause a single tool call and await a decision. Headless Claude Code offers static `--allowedTools` plus `PreToolUse` hooks. A hook can block by exiting non-zero, so mediation is possible, but a hook is a command rather than an in-process callback, so an interactive Slack approval mid-tool-call means the hook must call back into Relay and wait. **P0.4 owns designing that, and it is the single biggest architectural consequence of this decision.** It is recorded here so P0.4 does not discover it.

3. **Cost is charged against the subscription, and it is not free.** The one-word probe reported `total_cost_usd: 0.329`, dominated by cache creation on a large context. Real runs will differ, but this makes FR-ORC-7 budget metering more useful rather than less, since the engine reports its own cost per invocation.

### RESOLUTION of consequence 2, 2026-08-10, from empirical investigation during P0.4

Consequence 2 above says "a hook can block by exiting non-zero, so mediation is possible". **The blocking half of that is wrong, and the correction matters more than the original claim.** An investigation against the installed 2.1.226 binary, five real `claude -p` invocations costing $1.81 in a scratch directory outside the repo, established the following. Each item is marked with how it was established, because this decision has already carried one confidently-stated flag that did not exist.

1. **A `PreToolUse` hook signals its decision by exit 0 plus stdout JSON `{"hookSpecificOutput":{"permissionDecision":...}}`, or by exit 2 plus stderr.** Proven empirically: a real Bash tool call was actually blocked and `permission_denials` was populated.

2. **Hook timeout FAILS OPEN, and this is the load-bearing finding.** The timeout is configurable per hook and defaults to 600 seconds. Proven empirically that when it is exceeded, **the tool call proceeds, `permission_denials` is empty, and the hook's own output is discarded.** A synchronous hook that blocks while a human decides in Slack is therefore not viable at any timeout value: a human who does not answer produces an *allow*, which is the exact inversion of FR-APR-3's deny-and-pause and of the fail-closed principle the whole milestone rests on. No amount of tuning fixes it, because the failure is on the timeout path itself.

3. **Hooks can be configured per invocation via `--settings '<inline json>'`, with no mutation of the operator's global `settings.json`.** Proven empirically, twice. **This contradicts the official documentation page, which states no such flag exists.** The binary was believed over the doc, which is the same discipline that caught `--max-turns`.

4. **The hook receives `tool_name`, `tool_input`, `session_id`, `cwd`, and `tool_use_id`**, which is enough to name the exact action on an approval card, per FR-APR-1. Confirmed against real captured stdin.

5. **Addressing and authentication are outside the contract entirely**, so they are Relay's own design surface. Relay spawns the subprocess and controls its environment.

6. **Fail-closed is achievable, but only by not blocking.** See below.

**The mechanism this milestone will actually use: `permissionDecision: "defer"`.** It returns instantly, the subprocess exits cleanly naming the pending call in `deferred_tool_use`, and resuming later with a fresh hook decision was proven end to end to execute the originally deferred command for real. Nothing blocks, so the fail-open timeout hazard never arises.

Its existence was established by running `strings` on the installed binary, because the official documentation and a bundled SDK schema disagreed on whether `defer` exists at all. It is real but conditional: **print mode only, and only when the pending call is the sole tool call.** Neither secondary source captured that qualification, and it is a hard constraint on the design rather than a footnote.

The resulting shape: the hook asks Relay's own in-process `classify` and `decide` synchronously and fast, which is a local call with no human in it, and defers only on `ask`. Relay then learns about the pending call from its own subprocess stdout rather than from a hook callback, which removes the callback channel and its authentication problem from the critical path.

**Not established, and stated rather than assumed:** the HTTP hook type, documented with `headers` and `allowedEnvVars` for authentication, was not tested; only command-type hooks were. Deny-after-defer on resume is inferred from a shared code path rather than independently run.

### What does not change

AP-2 still applies: the task text is outside content and must reach the engine as data through the boundary Task 5 builds, never concatenated into instructions. AP-1's policy mediation still applies to Relay's own capabilities; the engine's internal tool use is governed by consequence 2 above.
