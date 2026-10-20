---
name: backend-engineering
description: Backend and distributed-systems design checklist. Use when designing or reviewing service boundaries, API contracts, background jobs and queues, retries and idempotency, Postgres schema, indexes, query plans and migrations on large tables, caching, consistency models, sharding, or observability (logs, metrics, traces, SLOs).
---

# Backend engineering

Apply the security, testing and general rules in `~/.agents/AGENTS-RULES.md`. The project's own `CLAUDE.md`/`AGENTS.md` wins. For production SLOs, alerting and incident practice also load `devops-sre`.

## Start every design with

What fails, how often, what the blast radius is, and how it recovers. Assume the network is unreliable, the disk slow, the clock wrong.

## Reject on sight

- An "eventually consistent" claim with no concrete bound.
- A retry without an idempotency key.
- A queue consumer without a dead-letter strategy.
- A non-trivial Postgres query without an index plan (`EXPLAIN ANALYZE`).
- A new service for what a module would solve.
- An SLO without an error budget.
- PII in logs.
- A dependency or new service without a case: what it solves, the in-process alternative, its operational cost, who runs it at 3 AM.

## Priorities

1. **Correctness under partial failure:** a 500 mid-request, a worker dying between read and write. Idempotency keys, transaction boundaries, compensating actions.
2. **Observability:** structured logs, low-cardinality metrics (no user IDs as label values), traces with the right span boundaries, SLOs tied to what users see.
3. **Postgres as an engineering tool:** designed indexes, migrations that do not lock production, a pool sized to the workload, JSONB only with intent.
4. **Backpressure:** bounded queues, bounded concurrency, bounded retries with jitter.
5. **Boring infrastructure:** Postgres + Redis + a queue + a job runner covers almost everything.

## Distributed-systems specifics

- **Consistency:** the weakest model that meets the need; do not sell linearizability when read-your-writes is enough.
- **Sharding:** a stable, evenly spread key that matches the access pattern; resharding is painful.
- **Trade-offs:** name them ("AP because X").
- **Queues:** at-least-once by default, so consumers are idempotent. FIFO only when ordering is a real requirement.
- **Caching:** TTL + read-through by default; manual invalidation is a common source of staleness bugs.
- **Contracts:** public and service-to-service APIs in a machine-readable spec (OpenAPI, AsyncAPI, protobuf) with contract tests and explicit versioning.
- **Schema changes:** expand and contract, with the backfill, dual-write window and rollback planned before the first migration.
- **Abstractions:** a repository with one implementation is a function; abstract at the third use.

## Reporting

Schema names, index definitions, EXPLAIN output, queue depths, p99 latencies, with file:line. Write proposals like an ADR: context, decision, consequences. Separate **must fix** (correctness, data integrity, security, SLO regression) from **nice to have**.
