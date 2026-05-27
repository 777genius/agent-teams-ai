/* eslint-disable security/detect-non-literal-fs-filename -- Fixture E2E reads a repo fixture and writes temp JSONL. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type MemberLogStreamRequestOptions,
  type MemberLogStreamResponse,
} from '../../../../../src/features/member-log-stream/contracts';
import { GetMemberLogStreamUseCase } from '../../../../../src/features/member-log-stream/core/application/use-cases/GetMemberLogStreamUseCase';
import { ClaudeMemberTranscriptStreamSource } from '../../../../../src/features/member-log-stream/main/adapters/output/sources/ClaudeMemberTranscriptStreamSource';
import { OpenCodeMemberRuntimeStreamSource } from '../../../../../src/features/member-log-stream/main/adapters/output/sources/OpenCodeMemberRuntimeStreamSource';
import { BoardTaskExactLogChunkBuilder } from '../../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';
import { BoardTaskExactLogStrictParser } from '../../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type { OpenCodeRuntimeTranscriptResponse } from '../../../../../src/main/services/runtime/ClaudeMultimodelBridgeService';
import type { MemberLogFileRef } from '../../../../../src/main/services/team/TeamMemberLogsFinder';
import type { ResolvedTeamMember } from '../../../../../src/shared/types';

const TEAM_NAME = 'relay-works-10';
const MEMBER_NAME = 'jack';
const LANE_ID = 'secondary:opencode:jack';
const GENERATED_AT = '2026-04-24T20:40:00.000Z';
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/team/opencode/relay-works-10-jack-projection-transcript.json'
);

const tempDirs: string[] = [];

const apiState = {
  getMemberLogStream:
    vi.fn<
      (
        teamName: string,
        memberName: string,
        options?: MemberLogStreamRequestOptions
      ) => Promise<MemberLogStreamResponse>
    >(),
  setMemberLogStreamTracking: vi.fn<(teamName: string, enabled: boolean) => Promise<void>>(),
  onTeamChange: vi.fn<(callback: (event: unknown, data: unknown) => void) => () => void>(),
};

vi.mock('@renderer/api', () => ({
  api: {
    memberLogStream: {
      getMemberLogStream: (...args: Parameters<typeof apiState.getMemberLogStream>) =>
        apiState.getMemberLogStream(...args),
      setMemberLogStreamTracking: (
        ...args: Parameters<typeof apiState.setMemberLogStreamTracking>
      ) => apiState.setMemberLogStreamTracking(...args),
    },
    teams: {
      onTeamChange: (...args: Parameters<typeof apiState.onTeamChange>) =>
        apiState.onTeamChange(...args),
    },
  },
}));

import { MemberLogStreamSection } from '../../../../../src/features/member-log-stream/renderer';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForText(
  host: HTMLElement,
  predicate: (text: string) => boolean
): Promise<string> {
  let text = '';
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await act(async () => {
      await flushAsyncWork();
    });
    text = host.textContent ?? '';
    if (predicate(text)) {
      return text;
    }
  }
  return text;
}

async function loadOpenCodeFixtureTranscript(): Promise<
  NonNullable<OpenCodeRuntimeTranscriptResponse['transcript']>
> {
  const parsed = JSON.parse(
    await readFile(FIXTURE_PATH, 'utf8')
  ) as OpenCodeRuntimeTranscriptResponse;
  if (parsed.providerId !== 'opencode' || !parsed.transcript) {
    throw new Error('Invalid OpenCode transcript fixture');
  }
  return parsed.transcript;
}

async function createClaudeTranscriptRef(): Promise<MemberLogFileRef> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'member-log-stream-e2e-'));
  tempDirs.push(tempDir);

  const filePath = path.join(tempDir, 'jack-claude-session.jsonl');
  const rows = [
    {
      parentUuid: null,
      isSidechain: true,
      userType: 'external',
      cwd: '/Users/tester/project',
      sessionId: 'claude-session-jack',
      version: '1.0.0',
      gitBranch: 'main',
      agentName: MEMBER_NAME,
      type: 'system',
      uuid: 'claude-init',
      timestamp: '2026-04-24T20:25:00.000Z',
      subtype: 'init',
      level: 'info',
      isMeta: false,
      content: 'member session started',
    },
    {
      parentUuid: 'claude-init',
      isSidechain: true,
      userType: 'external',
      cwd: '/Users/tester/project',
      sessionId: 'claude-session-jack',
      version: '1.0.0',
      gitBranch: 'main',
      agentName: MEMBER_NAME,
      type: 'user',
      uuid: 'claude-user-1',
      timestamp: '2026-04-24T20:25:01.000Z',
      isMeta: false,
      message: {
        role: 'user',
        content: 'Collect member-wide evidence for calculator behavior.',
      },
    },
    {
      parentUuid: 'claude-user-1',
      isSidechain: true,
      userType: 'external',
      cwd: '/Users/tester/project',
      sessionId: 'claude-session-jack',
      version: '1.0.0',
      gitBranch: 'main',
      agentName: MEMBER_NAME,
      type: 'assistant',
      uuid: 'claude-assistant-1',
      requestId: 'req-claude-1',
      timestamp: '2026-04-24T20:25:03.000Z',
      message: {
        role: 'assistant',
        id: 'msg-claude-1',
        type: 'message',
        model: 'claude-sonnet-4-5-20250929',
        content: [
          {
            type: 'text',
            text: 'Member-wide Claude transcript final note for Jack.',
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 16 },
      },
    },
  ];

  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const fileStat = await stat(filePath);

  return {
    memberName: MEMBER_NAME,
    sessionId: 'claude-session-jack',
    filePath,
    mtimeMs: fileStat.mtimeMs,
    sizeBytes: fileStat.size,
    messageCount: rows.length,
    kind: 'subagent',
  };
}

async function createFixtureUseCase(): Promise<{
  useCase: GetMemberLogStreamUseCase;
  getOpenCodeTranscript: ReturnType<typeof vi.fn>;
  findRecentMemberLogFileRefsByMember: ReturnType<typeof vi.fn>;
}> {
  const claudeRef = await createClaudeTranscriptRef();
  const openCodeTranscript = await loadOpenCodeFixtureTranscript();
  const findRecentMemberLogFileRefsByMember = vi.fn(() => Promise.resolve([claudeRef]));
  const getOpenCodeTranscript = vi.fn(() => Promise.resolve(openCodeTranscript));

  const chunkBuilder = new BoardTaskExactLogChunkBuilder();
  const sources = [
    new ClaudeMemberTranscriptStreamSource(
      { findRecentMemberLogFileRefsByMember } as never,
      new BoardTaskExactLogStrictParser(),
      chunkBuilder,
      { warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    ),
    new OpenCodeMemberRuntimeStreamSource(
      { getOpenCodeTranscript } as never,
      chunkBuilder,
      { resolve: vi.fn(() => Promise.resolve('/Users/tester/agent_teams_orchestrator')) }
    ),
  ];

  return {
    useCase: new GetMemberLogStreamUseCase({
      sources,
      clock: { now: () => Date.parse(GENERATED_AT) },
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
    getOpenCodeTranscript,
    findRecentMemberLogFileRefsByMember,
  };
}

function createMember(): ResolvedTeamMember {
  return {
    name: MEMBER_NAME,
    status: 'idle',
    currentTaskId: null,
    taskCount: 2,
    lastActiveAt: '2026-04-24T20:34:00.000Z',
    messageCount: 12,
    color: 'blue',
    providerId: 'opencode',
    laneId: LANE_ID,
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
  };
}

function stubMatchMedia(): void {
  const matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal('matchMedia', matchMedia);
}

function expectCapturedResponse(
  value: MemberLogStreamResponse | null
): MemberLogStreamResponse {
  expect(value).not.toBeNull();
  return value!;
}

describe('MemberLogStreamSection real fixture e2e', () => {
  afterEach(async () => {
    document.body.innerHTML = '';
    apiState.getMemberLogStream.mockReset();
    apiState.setMemberLogStreamTracking.mockReset();
    apiState.onTeamChange.mockReset();
    vi.unstubAllGlobals();
    await Promise.all(
      tempDirs.splice(0, tempDirs.length).map((dirPath) =>
        rm(dirPath, { recursive: true, force: true })
      )
    );
  });

  it('renders member-wide Claude transcript and OpenCode runtime logs through the member Logs UI', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubMatchMedia();
    apiState.onTeamChange.mockImplementation(() => () => undefined);
    apiState.setMemberLogStreamTracking.mockResolvedValue(undefined);

    const { useCase, getOpenCodeTranscript, findRecentMemberLogFileRefsByMember } =
      await createFixtureUseCase();
    const capturedResponseRef: { current: MemberLogStreamResponse | null } = { current: null };
    apiState.getMemberLogStream.mockImplementation(async (teamName, memberName, options) => {
      const response = await useCase.execute({
        teamName,
        memberName,
        limitSegments: options?.limitSegments,
        laneId: options?.laneId,
        forceRefresh: options?.forceRefresh,
      });
      capturedResponseRef.current = response;
      return response;
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(MemberLogStreamSection, {
            teamName: TEAM_NAME,
            member: createMember(),
          })
        )
      );
      await flushMicrotasks();
    });

    const text = await waitForText(host, (content) =>
      content.includes('Member-wide Claude transcript final note for Jack.')
    );

    expect(text).not.toContain('Member-scoped transcript and runtime logs');
    expect(text).not.toContain('Execution');
    expect(text).not.toContain('Process');
    expect(text).toContain('Claude transcript');
    expect(text).toContain('OpenCode runtime');
    expect(text).toContain('Calculator behavior');
    expect(text).toContain('Logic smoke check');
    expect(text).toContain('Collect member-wide evidence for calculator behavior.');

    const capturedResponse = expectCapturedResponse(capturedResponseRef.current);
    expect(capturedResponse).toMatchObject({
      source: 'member_mixed_runtime',
      defaultFilter: 'member:jack',
      generatedAt: GENERATED_AT,
      metadata: {
        scannedTranscriptFileCount: 1,
        includedTranscriptFileCount: 1,
      },
    });
    expect(capturedResponse.coverage).toEqual(
      expect.arrayContaining([
        { provider: 'claude_transcript', status: 'included' },
        { provider: 'opencode_runtime', status: 'included' },
      ])
    );
    expect(JSON.stringify(capturedResponse.segments)).toContain('Keyboard handlers added');
    expect(apiState.getMemberLogStream).toHaveBeenCalledWith(
      TEAM_NAME,
      MEMBER_NAME,
      expect.objectContaining({
        limitSegments: 30,
        laneId: LANE_ID,
      })
    );
    expect(findRecentMemberLogFileRefsByMember).toHaveBeenCalledWith(
      TEAM_NAME,
      [MEMBER_NAME],
      expect.objectContaining({ forceRefresh: false })
    );
    expect(getOpenCodeTranscript).toHaveBeenCalledWith(
      '/Users/tester/agent_teams_orchestrator',
      expect.objectContaining({
        teamId: TEAM_NAME,
        memberName: MEMBER_NAME,
        laneId: LANE_ID,
        limit: 400,
        timeoutMs: 5_000,
      })
    );

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });

    expect(apiState.setMemberLogStreamTracking).toHaveBeenCalledWith(TEAM_NAME, true);
    expect(apiState.setMemberLogStreamTracking).toHaveBeenCalledWith(TEAM_NAME, false);
  });
});
