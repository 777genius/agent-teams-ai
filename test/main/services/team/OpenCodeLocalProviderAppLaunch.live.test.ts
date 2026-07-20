import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inspectOpenCodeLocalModelRuntimeReadiness,
  OpenCodeLocalProviderConnector,
} from '../../../../src/features/runtime-provider-management/main';
import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import { formatProgressDump } from './memberWorkSyncLiveHarness';
import {
  createOpenCodeLiveHarness,
  type OpenCodeLiveHarness,
  waitForOpenCodeLanesStopped,
  waitUntil,
} from './openCodeLiveTestHarness';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_LOCAL_PROVIDER_APP_LAUNCH === '1'
    ? describe
    : describe.skip;

const LOCAL_PROVIDER_ID = 'local-lab';
const LOCAL_MODEL = `${LOCAL_PROVIDER_ID}/qwen-test:0.5b`;

liveDescribe('OpenCode local provider app launch live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let fakeServer: FakeOpenAiCompatibleServer | null;
  let harness: OpenCodeLiveHarness | null;
  let teamName: string | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-local-provider-app-launch-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
    fakeServer = null;
    harness = null;
    teamName = null;
  });

  afterEach(async () => {
    if (harness && teamName) {
      await harness.svc.stopTeam(teamName).catch(() => undefined);
      await waitForOpenCodeLanesStopped(teamName);
    }
    await harness?.dispose().catch(() => undefined);
    await fakeServer?.close().catch(() => undefined);
    setClaudeBasePathOverride(null);
    if (process.env.OPENCODE_E2E_KEEP_TEMP === '1') {
      console.info(`[OpenCodeLocalProviderAppLaunch.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    clearBenignSlowConfigReadWarnings();
  }, 90_000);

  it('creates and stops an OpenCode team through the app service using a configured authless local provider', async () => {
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# OpenCode local provider app launch live e2e\n',
      'utf8'
    );
    fakeServer = await startFakeOpenAiCompatibleServer();
    await writeFakeLocalOpenCodeConfig({
      projectPath,
      baseUrl: fakeServer.baseUrl,
    });

    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: LOCAL_MODEL,
      projectPath,
      runtimeAdapterOptions: {
        inspectLocalModelRuntime: inspectOpenCodeLocalModelRuntimeReadiness,
      },
    });

    teamName = `opencode-local-provider-app-${Date.now()}`;
    const progressEvents: TeamProvisioningProgress[] = [];
    const { runId } = await harness.svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: LOCAL_MODEL,
        skipPermissions: true,
        members: [
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: LOCAL_MODEL,
            mcpPolicy: { mode: 'appOnly' },
          },
        ],
      },
      (progress) => progressEvents.push(progress)
    );

    const progressDump = formatProgressDump(progressEvents);
    expect(runId, progressDump).toBeTruthy();
    expect(
      progressEvents.some((progress) => progress.message.includes('OpenCode team launch is ready')),
      progressDump
    ).toBe(true);
    expect(progressDump).not.toContain('provider not connected');
    expect(progressDump).not.toContain('not authenticated');
    expect(progressDump).not.toContain('OpenCode team launch is not enabled');
    expect(fakeServer.requests, progressDump).toContain('POST /v1/chat/completions');

    const runtimeSnapshot = await harness.svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.runId).toBe(runId);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      laneId: 'primary',
      laneKind: 'primary',
      runtimeModel: LOCAL_MODEL,
      historicalBootstrapConfirmed: true,
    });

    const deliveryMarker = `local-provider-delivery-${Date.now()}`;
    const chatBodyCountBeforeDelivery = fakeServer.chatBodies.length;
    const delivery = await harness.svc.deliverOpenCodeMemberMessage(teamName, {
      memberName: 'bob',
      messageId: `local-provider-delivery-${Date.now()}`,
      replyRecipient: 'user',
      source: 'manual',
      text: [
        `Local provider delivery marker: ${deliveryMarker}`,
        'Answer with PONG. Do not edit files.',
      ].join('\n'),
    });
    expect(delivery.delivered, JSON.stringify(delivery, null, 2)).toBe(true);
    await waitUntil(
      async () =>
        fakeServer!.chatBodies.length > chatBodyCountBeforeDelivery &&
        fakeServer!.chatBodies.some((body) => JSON.stringify(body).includes(deliveryMarker)),
      60_000,
      500
    );

    await harness.svc.stopTeam(teamName);
    await waitForOpenCodeLanesStopped(teamName);
    clearBenignSlowConfigReadWarnings();
  }, 300_000);

  it('fails app service launch for an unknown local model before creating OpenCode lanes', async () => {
    const projectPath = path.join(tempDir, 'unknown-model-project');
    await fs.mkdir(projectPath, { recursive: true });
    fakeServer = await startFakeOpenAiCompatibleServer();
    await writeFakeLocalOpenCodeConfig({
      projectPath,
      baseUrl: fakeServer.baseUrl,
    });

    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: `${LOCAL_PROVIDER_ID}/missing-test:0.5b`,
      projectPath,
      runtimeAdapterOptions: {
        inspectLocalModelRuntime: inspectOpenCodeLocalModelRuntimeReadiness,
      },
    });

    teamName = `opencode-local-provider-unknown-${Date.now()}`;
    const progressEvents: TeamProvisioningProgress[] = [];
    const { runId } = await harness.svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: `${LOCAL_PROVIDER_ID}/missing-test:0.5b`,
        skipPermissions: true,
        members: [
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: `${LOCAL_PROVIDER_ID}/missing-test:0.5b`,
          },
        ],
      },
      (progress) => progressEvents.push(progress)
    );
    expect(runId).toBeTruthy();
    await waitUntil(
      async () => progressEvents.some((progress) => progress.state === 'failed'),
      30_000,
      500
    );

    const progressDump = formatProgressDump(progressEvents);
    expect(
      progressEvents.some((progress) => progress.state === 'failed'),
      progressDump
    ).toBe(true);
    expect(progressDump).toMatch(/missing-test:0\.5b|not available|unavailable/i);
    expect(fakeServer.requests, progressDump).not.toContain('POST /v1/chat/completions');
    await waitUntil(
      async () => {
        const laneIndexPath = path.join(
          getTeamsBasePath(),
          teamName!,
          'runtime',
          'opencode',
          'lanes.json'
        );
        try {
          const parsed = JSON.parse(await fs.readFile(laneIndexPath, 'utf8')) as {
            lanes?: Record<string, unknown>;
          };
          return Object.keys(parsed.lanes ?? {}).length === 0;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return true;
          }
          throw error;
        }
      },
      15_000,
      500
    );
    clearBenignSlowConfigReadWarnings();
  }, 180_000);

  it('preserves the active lane when the local server is offline during restart and recovers cleanly', async () => {
    const projectPath = path.join(tempDir, 'restart-recovery-project');
    await fs.mkdir(projectPath, { recursive: true });
    fakeServer = await startFakeOpenAiCompatibleServer();
    const localServerPort = fakeServer.port;
    await writeFakeLocalOpenCodeConfig({
      projectPath,
      baseUrl: fakeServer.baseUrl,
    });

    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: LOCAL_MODEL,
      projectPath,
      runtimeAdapterOptions: {
        inspectLocalModelRuntime: inspectOpenCodeLocalModelRuntimeReadiness,
      },
    });

    teamName = `opencode-local-provider-restart-${Date.now()}`;
    await withLiveStageTimeout(
      'initial local team create',
      harness.svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: LOCAL_MODEL,
          skipPermissions: true,
          members: [
            {
              name: 'bob',
              role: 'Developer',
              providerId: 'opencode',
              model: LOCAL_MODEL,
              mcpPolicy: { mode: 'appOnly' },
            },
          ],
        },
        () => undefined
      ),
      300_000
    );

    const beforeOutage = await harness.svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(beforeOutage.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: LOCAL_MODEL,
    });
    const beforeOutageLaneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
    expect(beforeOutageLaneIndex.lanes.primary).toMatchObject({
      laneId: 'primary',
      state: 'active',
    });

    await fakeServer.close();
    fakeServer = null;

    const blockedRestartStartedAt = Date.now();
    const blockedRestartError = await withLiveStageTimeout(
      'offline local restart preflight',
      harness.svc.restartMember(teamName, 'bob'),
      30_000
    ).then(
      () => null,
      (error: unknown) => error
    );
    expect(Date.now() - blockedRestartStartedAt).toBeLessThan(15_000);
    expect(blockedRestartError).toBeInstanceOf(Error);
    expect((blockedRestartError as Error).message).not.toContain('timed out');
    expect((blockedRestartError as Error).message).toMatch(
      /local|server|provider|unavailable|reach/i
    );
    clearExpectedLocalServerOutageErrors(localServerPort);

    const afterBlockedRestart = await harness.svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(afterBlockedRestart.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: LOCAL_MODEL,
    });
    const afterBlockedRestartLaneIndex = await readOpenCodeRuntimeLaneIndex(
      getTeamsBasePath(),
      teamName
    );
    expect(afterBlockedRestartLaneIndex).toEqual(beforeOutageLaneIndex);

    fakeServer = await startFakeOpenAiCompatibleServer(localServerPort);
    await withLiveStageTimeout(
      'recovered local teammate restart',
      harness.svc.restartMember(teamName, 'bob'),
      360_000
    );
    clearExpectedLocalRestartWarnings();
    await waitUntil(
      async () => {
        const [snapshot, laneIndex] = await Promise.all([
          harness!.svc.getTeamAgentRuntimeSnapshot(teamName!),
          readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName!),
        ]);
        return (
          snapshot.members.bob?.alive === true &&
          snapshot.members.bob.laneId === 'primary' &&
          snapshot.members.bob.historicalBootstrapConfirmed === true &&
          laneIndex.lanes.primary?.state === 'active'
        );
      },
      30_000,
      1_000,
      async () => {
        const [snapshot, laneIndex] = await Promise.all([
          harness!.svc.getTeamAgentRuntimeSnapshot(teamName!),
          readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName!),
        ]);
        return JSON.stringify({ snapshot, laneIndex }, null, 2);
      }
    );

    const recovered = await harness.svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(recovered.members['team-lead']).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: LOCAL_MODEL,
      historicalBootstrapConfirmed: true,
    });
    expect(recovered.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      laneId: 'primary',
      laneKind: 'primary',
      runtimeModel: LOCAL_MODEL,
      historicalBootstrapConfirmed: true,
    });

    const recoveryMarker = `local-provider-recovery-${Date.now()}`;
    const recoveryBodyCount = fakeServer.chatBodies.length;
    const delivery = await harness.svc.deliverOpenCodeMemberMessage(teamName, {
      memberName: 'bob',
      messageId: recoveryMarker,
      replyRecipient: 'user',
      source: 'manual',
      text: [`Recovery marker: ${recoveryMarker}`, 'Answer with PONG. Do not edit files.'].join(
        '\n'
      ),
    });
    expect(delivery.delivered, JSON.stringify(delivery, null, 2)).toBe(true);
    await waitUntil(
      async () =>
        fakeServer!.chatBodies.length > recoveryBodyCount &&
        fakeServer!.chatBodies.some((body) => JSON.stringify(body).includes(recoveryMarker)),
      60_000,
      500
    );

    await harness.svc.stopTeam(teamName);
    await waitForOpenCodeLanesStopped(teamName);
    clearBenignSlowConfigReadWarnings();
  }, 720_000);
});

interface FakeOpenAiCompatibleServer {
  baseUrl: string;
  port: number;
  requests: string[];
  chatBodies: unknown[];
  close: () => Promise<void>;
}

async function startFakeOpenAiCompatibleServer(port = 0): Promise<FakeOpenAiCompatibleServer> {
  const requests: string[] = [];
  const chatBodies: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`);
    if (
      request.method === 'OPTIONS' &&
      (request.url === '/v1/models' || request.url === '/v1/chat/completions')
    ) {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'accept, content-type, authorization',
      });
      response.end();
      return;
    }
    if (request.url === '/v1/models') {
      response.setHeader('access-control-allow-origin', '*');
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: 'qwen-test:0.5b', object: 'model' }],
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const body = JSON.parse((await readRequestBody(request)) || '{}') as {
        stream?: boolean;
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: unknown[];
      };
      chatBodies.push(body);
      const serializedBody = JSON.stringify(body);
      if (
        Array.isArray(body.tools) &&
        serializedBody.includes('Agent Teams teammate compatibility test')
      ) {
        const toolResult = body.messages?.findLast((message) => message.role === 'tool');
        if (!toolResult) {
          sendJson(response, 200, {
            id: 'chatcmpl-local-probe-briefing',
            object: 'chat.completion',
            model: 'qwen-test:0.5b',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'local-probe-call-1',
                      type: 'function',
                      function: {
                        name: 'agent_teams_task_briefing',
                        arguments: JSON.stringify({
                          teamName: 'agent-teams-local-probe',
                          memberName: 'probe-member',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          });
          return;
        }

        const nonceMatch =
          typeof toolResult.content === 'string'
            ? toolResult.content.match(/exact text (local-probe-[a-z0-9]+)/i)
            : null;
        sendJson(response, 200, {
          id: 'chatcmpl-local-probe-message',
          object: 'chat.completion',
          model: 'qwen-test:0.5b',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'local-probe-call-2',
                    type: 'function',
                    function: {
                      name: 'agent_teams_message_send',
                      arguments: JSON.stringify({
                        teamName: 'agent-teams-local-probe',
                        to: 'probe-lead',
                        from: 'probe-member',
                        text: nonceMatch?.[1] ?? 'missing-probe-nonce',
                        summary: 'Compatibility probe',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
        return;
      }
      if (body.stream) {
        const created = Math.floor(Date.now() / 1000);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created,
            model: 'qwen-test:0.5b',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'PONG' },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created,
            model: 'qwen-test:0.5b',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`
        );
        response.end('data: [DONE]\n\n');
        return;
      }

      sendJson(response, 200, {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'qwen-test:0.5b',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'PONG' },
            finish_reason: 'stop',
          },
        ],
      });
      return;
    }

    sendJson(response, 404, { error: { message: 'not found' } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Fake OpenAI-compatible server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    chatBodies,
    close: () => closeServer(server),
  };
}

async function writeFakeLocalOpenCodeConfig(input: {
  projectPath: string;
  baseUrl: string;
}): Promise<void> {
  const response = await new OpenCodeLocalProviderConnector().configureLocalProvider({
    runtimeId: 'opencode',
    scope: 'project',
    projectPath: input.projectPath,
    presetId: 'custom',
    providerId: LOCAL_PROVIDER_ID,
    baseUrl: input.baseUrl,
    defaultModelId: 'qwen-test:0.5b',
    setAsDefault: true,
  });
  if (response.error) {
    throw new Error(`Local provider onboarding failed: ${response.error.message}`);
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
    server.closeIdleConnections();
  });
}

async function withLiveStageTimeout<T>(
  stage: string,
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function clearBenignSlowConfigReadWarnings(): void {
  const warn = vi.mocked(console.warn);
  if (
    warn.mock.calls.length > 0 &&
    warn.mock.calls.every((call) =>
      call
        .map((part) => String(part))
        .join(' ')
        .includes('[getConfig] slow read diag=')
    )
  ) {
    warn.mockClear();
  }
}

function clearExpectedLocalServerOutageErrors(port: number): void {
  const error = vi.mocked(console.error);
  if (
    error.mock.calls.length > 0 &&
    error.mock.calls.every((call) => {
      const message = call.map((part) => String(part)).join(' ');
      return message.includes('ECONNREFUSED') && message.includes(`127.0.0.1:${port}`);
    })
  ) {
    error.mockClear();
  }
}

function clearExpectedLocalRestartWarnings(): void {
  const warn = vi.mocked(console.warn);
  if (
    warn.mock.calls.length > 0 &&
    warn.mock.calls.every((call) => {
      const message = call.map((part) => String(part)).join(' ');
      return (
        message.includes('Local model') &&
        message.includes('restart preflight warnings') &&
        message.includes('does not expose enough runtime metadata')
      );
    })
  ) {
    warn.mockClear();
  }
}
