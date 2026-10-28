/**
 * The wire contract between the MCP gateway (a child of the worker), the
 * hook bridge (in the daemon) and the operations store. The gateway holds
 * no database access: it asks the bridge what to do with each `tools/call`
 * and reports the outcome of a call it executed for an approved operation.
 */

import { createHash } from 'node:crypto'
import { canonicalise } from '../audit/chain.js'

export const MCP_CALL_PATH = '/mcp-call'
export const MCP_RESULT_PATH = '/mcp-result'

export type McpCallRequest = { server: string; tool: string; args: unknown }

export type McpCallDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  /** A durable operation waits for the requester's approval; the gateway returns `message` as the tool error. */
  | { decision: 'pending'; operationId: string; message: string }
  /** An approved operation with equal arguments was claimed; the gateway forwards `args` (the stored ones) once and reports the result. */
  | { decision: 'execute'; operationId: string; args: unknown }

export type McpResultRequest = { operationId: string; ok: boolean; result: unknown }

/** Who a bridge token was issued to: one worker invocation under one lease generation. */
export type InvocationContext = {
  workspaceId: string
  taskId: string
  invocationId: string
  leaseGeneration: number
}

/** The digest an mcp_write operation is found and consumed by. */
export function mcpCallDigest(call: McpCallRequest): string {
  return createHash('sha256').update(canonicalise({ server: call.server, tool: call.tool, args: call.args ?? null })).digest('hex')
}

/** What the operations store answers for a call the guard says needs an operation. */
export type McpOperationAnswer =
  | { kind: 'pending'; operationId: string }
  | { kind: 'execute'; operationId: string; args: unknown }
  | { kind: 'refused'; reason: string }

/** Implemented by src/autonomous/remote-write.ts; injected into the guard. */
export interface McpOperations {
  /**
   * Finds this task's operation with the call's digest. `approved`: claims it
   * (approved to dispatching) and answers execute with the stored args.
   * `requested`: answers pending with the same id. None, or only terminal
   * ones: creates a new `requested` mcp_write operation and its approval card
   * in one transaction and answers pending.
   *
   * `signal` aborts when the bridge has already answered deny (its deadline):
   * nothing is created or claimed after that, so no state exists that the
   * gateway was never told about.
   */
  requestMcpOperation(context: InvocationContext, call: McpCallRequest, signal?: AbortSignal): Promise<McpOperationAnswer>
  /** Records succeeded or failed for an operation in `dispatching`; a no-op otherwise. */
  recordOperationOutcome(context: InvocationContext, operationId: string, outcome: { ok: boolean; result: unknown }): Promise<void>
}
