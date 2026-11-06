// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { startTeamMcpEndpoint } from '../../../packages/legacy-agent-host/src/mcp/endpoint';
import { TeamOwnerError } from '../../../packages/legacy-agent-host/src/team/contracts';
import type { TeamMcpEndpoint } from '../../../packages/legacy-agent-host/src/mcp/contracts';
import type { TeamMcpCrossTeamPort } from '../../../packages/legacy-agent-host/src/mcp/nativeCrossTeamContracts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const endpoints: TeamMcpEndpoint[] = [];
afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
});
async function fixture(port: TeamMcpCrossTeamPort) {
  let current = true;
  const endpoint = await startTeamMcpEndpoint({
    binding: {
      backendId: 'TEST-host',
      teamId: 'TEST-alpha',
      teamName: 'test-alpha',
      runId: 'TEST-run',
      memberId: 'TEST-lead',
      generation: '1',
    },
    expiresAtMs: Date.now() + 60_000,
    isCurrentBinding: () => current,
    connection: {
      execute() {
        throw new Error('TEST ordinary caller is not cross-Team');
      },
      lookup: () => undefined,
      getTask() {
        throw new Error('TEST no task');
      },
      listTasks: () => [],
      crossTeam: port,
    },
  });
  endpoints.push(endpoint);
  return {
    revoke() {
      current = false;
    },
    async call(name: string, args: Record<string, unknown>) {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${endpoint.bearerToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'TEST-request',
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return (await response.json()) as {
        result: { isError?: boolean; structuredContent: unknown };
      };
    },
  };
}
function port(send: TeamMcpCrossTeamPort['send']): TeamMcpCrossTeamPort {
  return {
    send,
    listTargets: () => [],
    lookup: () => undefined,
    getOutbox: async () => ({ kind: 'cross-team-outbox', rows: [] }),
  };
}
const receipt = {
  kind: 'cross-team-receipt' as const,
  commandId: 'TEST-message',
  messageId: 'TEST-message',
  conversationId: 'TEST-conversation',
  toMember: 'lead',
  phase: 'completed' as const,
  deduplicated: false,
};
describe('captured cross-Team MCP asynchronous outcome', () => {
  it('awaits the original send receipt instead of serializing a Promise as success', async () => {
    const pending = deferred<typeof receipt>();
    const entered = deferred<void>();
    const f = await fixture(
      port(async (input) => {
        expect(input.commandId).toBe('TEST-message');
        entered.resolve();
        return pending.promise;
      })
    );
    const request = f.call('cross_team_send', {
      commandId: 'TEST-message',
      toTeam: 'TEST-target-resource',
      text: 'TEST payload',
    });
    await entered.promise;
    pending.resolve(receipt);
    expect((await request).result).toMatchObject({ structuredContent: { result: receipt } });
  });
  it('returns a finite failure when the captured owner is revoked while the original send settles', async () => {
    const pending = deferred<typeof receipt>(),
      entered = deferred<void>();
    const f = await fixture(
      port(async () => {
        entered.resolve();
        return pending.promise;
      })
    );
    const request = f.call('cross_team_send', {
      commandId: 'TEST-message',
      toTeam: 'TEST-target-resource',
      text: 'TEST payload',
    });
    await entered.promise;
    f.revoke();
    pending.resolve(receipt);
    expect((await request).result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'forbidden' } },
    });
  });
  it('catches an asynchronous original-command HOLD without disclosing raw backend diagnostics', async () => {
    const f = await fixture(
      port(async () => {
        await Promise.resolve();
        throw new TeamOwnerError('hold');
      })
    );
    const response = await f.call('cross_team_send', {
      commandId: 'TEST-message',
      toTeam: 'TEST-target-resource',
      text: 'TEST payload',
    });
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'hold' } },
    });
  });
});
