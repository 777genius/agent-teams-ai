import { z } from 'zod';
import { McpToolFailure } from './contracts.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export interface BoundTool {
  definition: Tool;
  invoke(args: unknown): unknown;
  mutation: boolean;
  asynchronous?: true;
}

export function defineTool<S extends z.ZodType>(
  toolName: string,
  description: string,
  schema: S,
  invoke: (args: z.output<S>) => unknown,
  mutation = true
): BoundTool {
  return {
    definition: {
      name: toolName,
      description:
        description +
        (mutation
          ? ' Supply a stable commandId before first dispatch. Reuse it only for the same intent and payload after a lost response; changed payload conflicts.'
          : ''),
      inputSchema: z.toJSONSchema(schema) as Tool['inputSchema'],
      annotations: { readOnlyHint: !mutation, destructiveHint: mutation },
    },
    mutation,
    invoke: (args) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new McpToolFailure('invalid');
      return invoke(parsed.data);
    },
  };
}

const MAX_MCP_RESULT_BYTES = 256 * 1024;

/** MCP projection only: persisted receipts remain intact for idempotent recovery.
 * Oversized canonical task history belongs in paginated reads, never in a
 * mutation acknowledgement. Command lookup uses the same projection.
 */
function compactOversizedReceipt(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const command = source.command;
  const effects = source.effects;
  if (
    source.schemaVersion !== 1 ||
    typeof source.commandId !== 'string' ||
    typeof source.fingerprint !== 'string' ||
    !command || typeof command !== 'object' || Array.isArray(command) ||
    !effects || typeof effects !== 'object' || Array.isArray(effects) ||
    !['prepared', 'applying', 'completed', 'rejected', 'held'].includes(String(source.phase))
  ) return value;
  const operation = (command as Record<string, unknown>).operation;
  if (typeof operation !== 'string' || operation.length > 64) return value;
  const ids = effects as Record<string, unknown>;
  const finiteIds = Object.fromEntries(
    ['taskId', 'commentId', 'messageId', 'deliveryId']
      .filter((key) => typeof ids[key] === 'string' && (ids[key] as string).length <= 256)
      .map((key) => [key, ids[key]])
  );
  return {
    schemaVersion: 1,
    commandId: source.commandId,
    command: { operation },
    phase: source.phase,
    effects: finiteIds,
    ...(typeof source.createdAt === 'string' && source.createdAt.length <= 64
      ? { createdAt: source.createdAt } : {}),
    ...(typeof source.taskHash === 'string' && source.taskHash.length <= 128
      ? { taskHash: source.taskHash } : {}),
    resultOmitted: true,
  };
}

export function formatToolResult(value: unknown, mutation: boolean): CallToolResult {
  let output: unknown = value ?? null;
  let serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MCP_RESULT_BYTES) {
    output = compactOversizedReceipt(output);
    serialized = JSON.stringify(output);
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MCP_RESULT_BYTES)
    throw new McpToolFailure('output-limit');
  const phase = output && typeof output === 'object' && 'phase' in output
    ? output.phase : undefined;
  return {
    content: [{ type: 'text', text: serialized }],
    structuredContent: { result: output },
    ...(mutation && (phase === 'rejected' || phase === 'held') ? { isError: true } : {}),
  };
}
