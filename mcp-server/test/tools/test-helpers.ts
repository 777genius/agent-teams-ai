import { vi } from 'vitest';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner, TeamctlResult } from '../../src/teamctl-runner.js';

/**
 * Creates a mock ITeamctlRunner that records calls and returns predetermined results.
 */
export function createMockRunner(
  response: TeamctlResult | ((args: string[]) => TeamctlResult),
): ITeamctlRunner & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async (args: string[]): Promise<TeamctlResult> => {
      return typeof response === 'function' ? response(args) : response;
    }),
  };
}

/** Success response helpers */
export const ok = (stdout: string): TeamctlResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

export const fail = (stderr: string): TeamctlResult => ({
  stdout: '',
  stderr,
  exitCode: 1,
});

/**
 * Captures registered tools via a mock FastMCP-like server.
 * Returns a map of tool name → { execute function, parameters schema }.
 */
export interface CapturedTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  parameters: unknown;
}

export function createMockServer(): {
  server: FastMCP;
  tools: Map<string, CapturedTool>;
} {
  const tools = new Map<string, CapturedTool>();

  const server = {
    addTool: (def: { name: string; execute: CapturedTool['execute']; parameters: unknown }) => {
      tools.set(def.name, {
        name: def.name,
        execute: def.execute,
        parameters: def.parameters,
      });
    },
  } as unknown as FastMCP;

  return { server, tools };
}
