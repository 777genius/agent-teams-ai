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

export function formatToolResult(value: unknown, mutation: boolean): CallToolResult {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) throw new McpToolFailure('output-limit');
  const phase = value && typeof value === 'object' && 'phase' in value ? value.phase : undefined;
  return {
    content: [{ type: 'text', text: serialized }],
    structuredContent: { result: value ?? null },
    ...(mutation && (phase === 'rejected' || phase === 'held') ? { isError: true } : {}),
  };
}
