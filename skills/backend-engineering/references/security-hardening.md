# Security hardening

Read the section you need when you reach that code. It extends rules 26 to 29 in `~/.agents/AGENTS-RULES.md` (secrets, escaping, parameterized queries, uploads); the project's own rules win. Adapted from addyosmani/agent-skills (MIT).

## Threat model first

Five minutes before the code:

1. **Trust boundaries:** requests, form fields, uploads, webhooks, third-party APIs, queues, LLM output, and values that only look internal (a filename on a shared volume, a path in a job payload, another process's arguments). Trust follows who wrote a value, not which channel delivered it.
2. **Assets:** credentials, PII, payment data, admin actions, money movement.
3. **STRIDE over each boundary:** spoofing (authentication, signatures), tampering (integrity, parameterized queries), repudiation (audit log), information disclosure (field allowlists, generic errors), denial of service (rate limits, size caps, timeouts), elevation of privilege (authorization, least privilege).
4. **Abuse cases next to use cases:** "how would I misuse this?" becomes the first test.

## Ask the user first

New or changed auth flows, new categories of stored sensitive data, new external integrations, CORS changes, new upload handlers, rate limit changes, new roles or elevated permissions.

## Access control

Check authorization on every request, not only authentication: the user must own or be allowed on this specific record, including nested IDs, bulk actions, downloads and background jobs (IDOR). Scope lookups through the owner (`current_user.projects.find(params[:id])`), default deny, enforce on the server; a hidden button is not authorization.

## Authentication and sessions

- Passwords: bcrypt (cost 12 or more), scrypt or argon2. Session secret from credentials or env.
- Session cookies: `httponly`, `secure`, `same_site: :lax` or `:strict`, bounded expiry. No auth tokens in `localStorage`.
- Rotate the session on login and privilege change.

## Headers, CORS and responses

- Security headers on every response; CSP starts at `default-src 'self'` and is only tightened.
- CORS: an explicit origin list from config, never `*` with credentials.
- Strip sensitive fields (password digests, reset tokens) from every serializer. Error bodies are generic; details go to server logs only. No stack traces to users.

## Input validation

Validate at the boundary against an allowlisted shape (types, lengths, enums, formats), reject with 422, and use only the parsed value downstream. Client-side validation is UX, never a security boundary. Uploads: allowlist types, cap size, check magic bytes when it matters; the extension proves nothing.

## Server-side fetches (SSRF)

Any URL the user influences (webhooks, import from URL, image proxies, link previews) can be pointed at internal services.

- Allowlist scheme (`https`) and, where possible, host.
- Resolve all DNS records and reject private and reserved addresses: loopback, link-local (`169.254.169.254` metadata), RFC 1918, unique-local, for IPv4 and IPv6.
- Forbid redirects, or re-check each hop.
- Set connect and read timeouts and a response size cap.
- DNS rebinding can slip between check and use: for high-risk surfaces, connect to the resolved IP you checked, or route through an egress proxy that filters.

## Destructive operations on derived paths

A delete, move or overwrite is only as safe as the value naming the target. Before the call: resolve symlinks, require the target to sit under an allowlisted root and at least one level below it, and require ownership evidence read before the operation. On refusal, log and stop; never fall back to a broader path.

## Rate limiting

Limit the API in general and auth endpoints strictly (about 10 attempts per 15 minutes per account and per IP). With more than one process, back the limiter with a shared store (Redis, `Rack::Attack` with a shared cache); in-memory counters become `limit x instances`.

## Secrets

From credentials or env only. `.env.example` with placeholders is committed; real `.env*` files and keys are ignored. Grep the staged diff before committing. A secret that reached a remote is compromised: rotate it first, then purge history. Never print a secret into a report or transcript; cite the location.

## Dependencies and supply chain

1. **One manager per install boundary:** confirm `packageManager`, the lockfile and CI agree; stop on competing lockfiles. Installs in CI are frozen (`bundle install --frozen`, `npm ci`, `yarn install --immutable`).
2. **Install scripts:** for a new JS dependency, check for `postinstall` scripts before first install; never blanket-approve.
3. **Audit before release:** `bundle audit`, `npm audit`/`yarn npm audit`, `osv-scanner`. Triage critical and high by reachability (runtime, build, test only). Never run forced fixes (`npm audit fix --force`); upgrade one at a time and read the changelog. Record every deferral with a reason and a review date.
4. **Audits only know published advisories:** they miss a fresh malicious or typosquatted package (`crossenv` for `cross-env`). For each new dependency check owner, maintenance, release age, download count and transitive tree, and review the lockfile diff with it. Verify registry signatures where supported (`npm audit signatures`).
5. A new dependency also needs the case in `backend-engineering`'s "Reject on sight" list and rule 55's reuse order.

## Personal data

- Classify fields as you add them: non-personal, PII, sensitive.
- Collect only for a stated purpose; keep PII out of logs, metrics labels and analytics.
- Each personal data store has a retention period and a working delete path, including caches, search indexes, analytics copies and backups.
- Sending PII to an analytics, ad or LLM vendor is sharing: it needs consent and a data processing agreement.

## AI and LLM features

Map to the OWASP Top 10 for LLM Applications (2025):

- **Model output is untrusted input (LLM05):** never into `eval`, SQL, a shell, `html_safe`/`innerHTML` or a file path. Parse against a schema, validate, then escape.
- **Prompt injection (LLM01):** any untrusted text in context (user message, fetched page, PDF, email, tool result) can carry instructions. The system prompt is not a security boundary; enforce permissions in code, outside the model.
- **Context hygiene (LLM02, LLM07):** keep secrets, other tenants' data and anything you would not show the user out of the context window.
- **Tools and agency (LLM06):** scope each tool to the least privilege, validate every tool argument server side, and require a human confirmation for destructive or outward actions.
- **Cost and abuse (LLM10):** cap tokens, request rate, tool call count and recursion depth per user.
- **RAG (LLM08):** partition embeddings per tenant, filter retrieval by the caller's permissions, and validate documents before indexing.

## Red flags

- User input reaching SQL, a shell, a template or HTML unescaped.
- An endpoint with authentication but no ownership check.
- `*` CORS origin, or no rate limit on login or password reset.
- A server fetch of a user-supplied URL with no allowlist.
- LLM output reaching a query, the DOM, a shell or `eval`.
- Secrets, PII or the full system prompt inside an LLM context.
- A delete or overwrite whose target comes from a payload, guarded only by a shape check.
- "Delete my account" that flips a flag while the data stays.
