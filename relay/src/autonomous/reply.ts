/**
 * The one object a worker turn returns. The CLI validates it against
 * REPLY_JSON_SCHEMA (claude `--json-schema`, codex `--output-schema`);
 * relay validates it again here, strictly, per `remote_write` kind and with
 * `plan` required exactly when the status is `plan`. No evidence field:
 * relay produces completion evidence itself.
 */

import { z } from 'zod'

export const REPLY_STATUSES = ['question', 'restate', 'plan', 'progress', 'waiting_on_approval', 'done', 'blocked'] as const
export type ReplyStatus = (typeof REPLY_STATUSES)[number]

const nonEmpty = z.string().trim().min(1)

export const remoteWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('push'), branch: nonEmpty }).strict(),
  z.object({ kind: z.literal('pr_create'), base: nonEmpty, head: nonEmpty, title: nonEmpty, body: z.string() }).strict(),
  z.object({ kind: z.literal('pr_comment'), pr: z.number().int().positive(), body: nonEmpty }).strict(),
  z
    .object({ kind: z.literal('pr_review'), pr: z.number().int().positive(), event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']), body: z.string() })
    .strict(),
  z.object({ kind: z.literal('issue_create'), title: nonEmpty, body: z.string() }).strict(),
  z.object({ kind: z.literal('issue_comment'), issue: z.number().int().positive(), body: nonEmpty }).strict(),
  z.object({ kind: z.literal('api_write'), method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']), path: nonEmpty, body: z.unknown() }).strict(),
])
export type RemoteWrite = z.infer<typeof remoteWriteSchema>

export const findingSchema = z
  .object({
    id: nonEmpty,
    severity: nonEmpty,
    file: z.string(),
    line: z.number().int().nonnegative().nullable(),
    summary: nonEmpty,
    status: z.enum(['open', 'fixed', 'still_open', 'new']),
    inScope: z.boolean().optional(),
  })
  .strict()

export const planPayloadSchema = z
  .object({
    summary: nonEmpty,
    task_type: z.enum(['review', 'implement']),
    change_kind: z.enum(['fix', 'feature']),
    visible: z.boolean(),
    scope: nonEmpty,
    acceptance_criteria: z.array(nonEmpty).min(1),
    test_command: z.string().nullable(),
    repo: nonEmpty,
  })
  .strict()
  .refine((plan) => plan.task_type === 'review' || (plan.test_command !== null && plan.test_command.trim() !== ''), {
    message: 'an implement plan needs a test_command',
    path: ['test_command'],
  })
export type PlanPayload = z.infer<typeof planPayloadSchema>

export const workerReplySchema = z
  .object({
    status: z.enum(REPLY_STATUSES),
    text: z.string(),
    remote_write: remoteWriteSchema.nullable().optional(),
    findings: z.array(findingSchema).nullable().optional(),
    plan: planPayloadSchema.nullable().optional(),
  })
  .strict()
  .refine((reply) => (reply.status === 'plan') === (reply.plan !== undefined && reply.plan !== null), {
    message: 'plan is required exactly when status is plan',
    path: ['plan'],
  })
export type WorkerReply = z.infer<typeof workerReplySchema>

export type ParsedReply = { ok: true; reply: WorkerReply } | { ok: false; error: string }

export function parseWorkerReply(value: unknown): ParsedReply {
  const result = workerReplySchema.safeParse(value)
  if (result.success) return { ok: true, reply: result.data }
  return { ok: false, error: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ') }
}

/**
 * The shape the CLIs enforce. Kept to what both CLIs' structured-output
 * support accepts (no oneOf); relay's zod schema above is the strict check.
 */
export const REPLY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'text', 'remote_write', 'findings', 'plan'],
  properties: {
    status: { type: 'string', enum: [...REPLY_STATUSES] },
    text: { type: 'string' },
    remote_write: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['kind', 'branch', 'base', 'head', 'title', 'body', 'pr', 'issue', 'event', 'method', 'path'],
      properties: {
        kind: { type: 'string', enum: ['push', 'pr_create', 'pr_comment', 'pr_review', 'issue_create', 'issue_comment', 'api_write'] },
        branch: { type: ['string', 'null'] },
        base: { type: ['string', 'null'] },
        head: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        body: { type: ['string', 'null'] },
        pr: { type: ['integer', 'null'] },
        issue: { type: ['integer', 'null'] },
        event: { type: ['string', 'null'] },
        method: { type: ['string', 'null'] },
        path: { type: ['string', 'null'] },
      },
    },
    findings: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'file', 'line', 'summary', 'status', 'inScope'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          summary: { type: 'string' },
          status: { type: 'string', enum: ['open', 'fixed', 'still_open', 'new'] },
          inScope: { type: 'boolean' },
        },
      },
    },
    plan: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['summary', 'task_type', 'change_kind', 'visible', 'scope', 'acceptance_criteria', 'test_command', 'repo'],
      properties: {
        summary: { type: 'string' },
        task_type: { type: 'string', enum: ['review', 'implement'] },
        change_kind: { type: 'string', enum: ['fix', 'feature'] },
        visible: { type: 'boolean' },
        scope: { type: 'string' },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        test_command: { type: ['string', 'null'] },
        repo: { type: 'string' },
      },
    },
  },
} as const

/** The fields each remote_write kind takes, read from its zod schema. */
const REMOTE_WRITE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map(
  remoteWriteSchema.options.map((option) => [option.shape.kind.value, Object.keys(option.shape)]),
)

/**
 * The CLI-level schema makes every remote_write field present (nullable),
 * because strict structured output cannot express a tagged union, and models
 * often fill the unused ones with '' instead of null. This keeps only the
 * fields the reply's kind takes, so the strict per-kind zod schema decides.
 */
export function normalizeCliReply(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const reply = { ...(value as Record<string, unknown>) }
  const write = reply.remote_write
  if (typeof write === 'object' && write !== null) {
    const fields = REMOTE_WRITE_FIELDS.get(String((write as { kind?: unknown }).kind))
    reply.remote_write = Object.fromEntries(
      Object.entries(write).filter(([key, field]) => field !== null && (fields === undefined || fields.includes(key))),
    )
  }
  return reply
}
