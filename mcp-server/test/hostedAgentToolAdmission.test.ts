import { describe, expect, it, vi } from 'vitest';

import { AGENT_TEAMS_REGISTERED_TOOL_NAMES, registerTools } from '../src/tools';
import {
  assertHostedAgentToolAdmission,
  isHostedAgentToolMode,
  type HostedAgentToolAdmissionOptions,
  type HostedMemberAdmission,
  type HostedMemberInvocation,
} from '../src/tools/hostedAgentToolAdmission';

const invocation: HostedMemberInvocation = {
  teamName: 'sandbox-team',
  memberName: 'alice',
  runId: 'run-1',
  runtimeSessionId: 'session-1',
  ownerIncarnationId: 'owner-2',
  ownerAuthorityId: 'authority-2',
};

const admission: HostedMemberAdmission = {
  ...invocation,
  allowedTaskRefs: ['task-1'],
  allowedMessageRecipients: ['lead', 'user'],
  allowedInboundMessageIds: ['inbound-1'],
};

function trustedOptions(): HostedAgentToolAdmissionOptions {
  return {
    hosted: true,
    resolveInvocation: async () => invocation,
    readMemberAdmission: async () => admission,
    readOwnerAuthority: async () => ({
      ownerIncarnationId: invocation.ownerIncarnationId,
      ownerAuthorityId: invocation.ownerAuthorityId,
    }),
  };
}

describe('Hosted member tool admission', () => {
  it('does not let an option override the Hosted runtime environment', () => {
    vi.stubEnv('HOSTED_OPENCODE_RUNTIME_MODE', '1');
    try {
      expect(isHostedAgentToolMode({ hosted: false })).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never falls through to the caller-selected local root after successful admission', async () => {
    const tools = new Map<string, { execute: (args: Record<string, unknown>, context?: unknown) => Promise<unknown> }>();
    registerTools({
      addTool(tool: { name: string; execute: (args: Record<string, unknown>, context?: unknown) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
    } as never, trustedOptions());
    const cases: Array<[string, Record<string, unknown>]> = [
      ['task_get', { taskId: 'task-1' }],
      ['task_start', { taskId: 'task-1', actor: 'alice' }],
      ['task_complete', { taskId: 'task-1', actor: 'alice' }],
      ['task_add_comment', { taskId: 'task-1', from: 'alice', text: 'Done' }],
      ['message_send', { from: 'alice', to: 'lead', text: 'Done' }],
    ];
    for (const [name, args] of cases) {
      await expect(tools.get(name)!.execute({
        teamName: 'sandbox-team', claudeDir: '/tmp/hosted-mcp-cross-root-sandbox', ...args,
      }, {})).rejects.toThrow('Owner executor unavailable');
    }
  });

  it('dispatches only bounded commands and fresh authority to an injected Owner port', async () => {
    const tools = new Map<string, { execute: (args: Record<string, unknown>, context?: unknown) => Promise<unknown> }>();
    const dispatch = vi.fn(async () => ({ id: 'task-1' }));
    registerTools({
      addTool(tool: { name: string; execute: (args: Record<string, unknown>, context?: unknown) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
    } as never, { ...trustedOptions(), ownerDispatcher: { dispatch } });
    await expect(tools.get('task_get')!.execute({
      teamName: 'sandbox-team', claudeDir: '/tmp/hosted-mcp-cross-root-sandbox', taskId: 'task-1',
    }, {})).resolves.toMatchObject({ content: [{ type: 'text' }] });
    expect(dispatch).toHaveBeenCalledWith({
      command: { tool: 'task_get', teamName: 'sandbox-team', taskId: 'task-1' },
      invocation,
      expectedOwnerAuthority: {
        ownerIncarnationId: invocation.ownerIncarnationId,
        ownerAuthorityId: invocation.ownerAuthorityId,
      },
    });
    expect(JSON.stringify(dispatch.mock.calls[0])).not.toContain('claudeDir');
  });

  it('fails closed in Hosted mode without authenticated invocation provenance', async () => {
    const tools = new Map<string, { execute: (args: Record<string, unknown>, context?: unknown) => Promise<unknown> }>();
    registerTools({
      addTool(tool: { name: string; execute: (args: Record<string, unknown>, context?: unknown) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
    } as never, { hosted: true });

    const cases: Array<[string, Record<string, unknown>]> = [
      ['task_get', { taskId: 'task-1' }],
      ['task_start', { taskId: 'task-1', actor: 'alice' }],
      ['task_add_comment', { taskId: 'task-1', from: 'alice', text: 'Done' }],
      ['task_complete', { taskId: 'task-1', actor: 'alice' }],
      ['message_send', { from: 'alice', to: 'lead', text: 'Done' }],
    ];
    for (const [name, args] of cases) {
      await expect(tools.get(name)!.execute({ teamName: 'sandbox-team', ...args }, {
        sessionId: 'attacker-controlled-session',
      })).rejects.toThrow('authenticated member admission unavailable or stale');
    }
  });

  it('denies every uncovered Hosted MCP entry point before controller access', async () => {
    const tools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>();
    registerTools({
      addTool(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
    } as never, { hosted: true });

    const admitted = new Set(['task_get', 'task_start', 'task_add_comment', 'task_complete', 'message_send']);
    for (const name of AGENT_TEAMS_REGISTERED_TOOL_NAMES) {
      if (admitted.has(name)) continue;
      await expect(tools.get(name)!.execute({ teamName: 'sandbox-team' })).rejects.toThrow(
        `Hosted MCP tool ${name} denied: admission policy unavailable`
      );
    }
  });

  it('admits only the current Owner incarnation and admitted member session', async () => {
    const operation = { kind: 'task' as const, teamName: 'sandbox-team', taskRef: 'task-1', actor: 'alice' };
    await expect(assertHostedAgentToolAdmission(operation, {}, trustedOptions())).resolves.toBeUndefined();

    await expect(assertHostedAgentToolAdmission(operation, {}, {
      ...trustedOptions(),
      readOwnerAuthority: async () => ({ ownerIncarnationId: 'owner-3', ownerAuthorityId: 'authority-3' }),
    })).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission(operation, {}, {
      ...trustedOptions(),
      readMemberAdmission: async () => ({ ...admission, runtimeSessionId: 'session-replaced' }),
    })).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission(operation, {}, {
      ...trustedOptions(),
      resolveInvocation: async () => ({ ...invocation, teamName: 'other-team' }),
    })).rejects.toThrow('admission unavailable or stale');
  });

  it('enforces task ownership identity and task/message scope from trusted admission', async () => {
    const options = trustedOptions();
    await expect(assertHostedAgentToolAdmission({
      kind: 'task', teamName: 'sandbox-team', taskRef: 'task-2', actor: 'alice',
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission({
      kind: 'task', teamName: 'sandbox-team', taskRef: 'task-1', actor: 'lead',
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission({
      kind: 'message', teamName: 'sandbox-team', from: 'alice', to: 'lead',
      taskRefs: [{ taskId: 'task-1', teamName: 'sandbox-team' }], relayOfMessageId: 'inbound-1',
    }, {}, options)).resolves.toBeUndefined();
    await expect(assertHostedAgentToolAdmission({
      kind: 'message', teamName: 'sandbox-team', from: 'lead', to: 'user',
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission({
      kind: 'message', teamName: 'sandbox-team', from: 'alice', to: 'outsider',
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission({
      kind: 'message', teamName: 'sandbox-team', from: 'alice', to: 'lead', relayOfMessageId: 'inbound-2',
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission({
      kind: 'message', teamName: 'sandbox-team', from: 'alice', to: 'lead', source: 'user_sent',
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission({
      kind: 'message', teamName: 'sandbox-team', from: 'alice', to: 'lead', source: 'runtime_delivery',
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission({
      kind: 'message', teamName: 'sandbox-team', from: 'alice', to: 'lead', leadSessionId: 'forged',
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
    await expect(assertHostedAgentToolAdmission({
      kind: 'message', teamName: 'sandbox-team', from: 'alice', to: 'lead',
      taskRefs: [{ taskId: 'task-1', teamName: 'other-team' }],
    }, {}, options)).rejects.toThrow('admission unavailable or stale');
  });
});
