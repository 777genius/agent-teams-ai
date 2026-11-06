import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runtimeInteraction } from '../../../packages/legacy-agent-host/src/composition/runtimeControlValues';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';
import { pendingHostToolInteractions } from '../../../src/features/agent-backend/renderer/projectHostToolApproval';
import { applyToolApprovalEvent } from '../../../src/renderer/store/team/toolApprovalEvents';

import type {
  AgentBackendApi,
  BackendActivitySnapshot,
  BackendOperationRequest,
  BackendRuntimeSnapshot,
} from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '@shared/types/api';
import type { ToolApprovalEvent, ToolApprovalRequest } from '@shared/types/team';

const ui = vi.hoisted(() => ({
  queue: [] as ToolApprovalRequest[],
  respond: vi.fn(),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@features/agent-backend/renderer', () => ({
  isHostTeamSelectionKey: (key: string) => key.startsWith('host-team:'),
}));
vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (value: Record<string, unknown>) => unknown) =>
    selector({
      pendingApprovals: ui.queue,
      respondToToolApproval: ui.respond,
      updateToolApprovalSettings: vi.fn(),
      teams: [],
      selectedTeamName: null,
      selectedTeamData: null,
      toolApprovalSettings: {},
      toolApprovalSettingsByTeam: {},
    }),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectResolvedMembersForTeamName: () => [],
}));
vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));
vi.mock('@renderer/constants/teamColors', () => ({
  getTeamColorSet: () => ({ text: '#fff', border: '#fff' }),
  getThemedBadge: () => '#000',
}));
vi.mock('@renderer/utils/syntaxHighlighter', () => ({
  highlightLines: () => ['TEST command'],
}));
vi.mock('@renderer/components/team/dialogs/ToolApprovalSettingsPanel', () => ({
  ToolApprovalSettingsContent: () => null,
  ToolApprovalSettingsToggle: () => null,
}));
vi.mock('@renderer/components/team/ToolApprovalDiffPreview', () => ({
  ToolApprovalDiffPreview: () => null,
}));
vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: () => null,
}));
vi.mock('@renderer/components/team/editor/FileIcon', () => ({
  FileIcon: () => null,
}));
import { ToolApprovalSheet } from '../../../src/renderer/components/team/ToolApprovalSheet';

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T09:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ui.queue = [];
  ui.respond.mockReset();
});
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(kind: 'permission' | 'question' = 'permission', count = 1) {
  let runtimeReadGate: Promise<void> | undefined;
  let authorized = true,
    generation = 'TEST-generation',
    abort = false,
    loseReply = false;
  let legacyListener: ((event: unknown, value: ToolApprovalEvent) => void) | undefined;
  const connection = {
    handle: { handleId: 'TEST-owner-A' },
    label: 'TEST team',
    members: [{ memberId: 'TEST-member-A', label: 'alice' }],
  };
  const key = hostTeamSelectionKey(connection.handle.handleId);
  const facts = Array.from({ length: count }, (_, index) => ({
    inputId: 'TEST-input-A',
    interactionRef: `TEST-interaction-${index}`,
    kind,
    expiresAt: Date.now() + 30_000,
    phase: 'pending' as string,
  }));
  const snapshot = (): BackendActivitySnapshot => ({
    memberId: 'TEST-member-A',
    cursor: 'TEST_cursor',
    retainedFrom: 1,
    events: [],
    hasMore: false,
    state: {
      phase: 'allocated',
      custody: 'owned',
      sealed: false,
      nativeReady: true,
      queuedInputs: 0,
      activeInputs: 1,
      partial: false,
      control: null,
      diagnostic: null,
      interactions: structuredClone(facts),
    },
    latest: {
      text: [],
      tools: [],
      usage: [],
      compaction: null,
      interactions: facts.map((fact, index) => ({
        sequence: index + 1,
        eventId: `TEST-event-${index}`,
        inputId: fact.inputId,
        data: {
          kind: 'interaction',
          interactionRef: fact.interactionRef,
          request:
            kind === 'permission'
              ? { kind, tool: 'Bash', input: { command: 'printf TEST' } }
              : {
                  kind,
                  questions: [
                    {
                      question: 'Proceed with TEST?',
                      options: [{ label: 'Use TEST fixture' }, { label: 'Stop here' }],
                      multiSelect: false,
                    },
                  ],
                },
        },
      })),
    },
  });
  const runtime = (): BackendRuntimeSnapshot => ({
    memberId: 'TEST-member-A',
    generation,
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    attached: true,
    nativeReady: true,
    inputs: [
      {
        inputId: 'TEST-input-A',
        phase: abort ? 'terminal' : 'consumed',
        ...(abort ? { terminal: 'cancelled' as const } : {}),
      },
    ],
    interactions: structuredClone(facts),
  });
  const calls: BackendOperationRequest[] = [],
    replies: BackendOperationRequest[] = [];
  const backend: AgentBackendApi = {
    getConnections: async () => ({ state: 'ready', bindings: [connection] }),
    invoke: async (request) => {
      calls.push(structuredClone(request));
      if (request.operation === 'team.launch.read')
        return {
          ok: true,
          value: {
            launchId: 'TEST-launch-A',
            rosterRevision: 'TEST-roster',
            status: 'pending',
            ready: 0,
            expected: 1,
            retryCapability: 'same-binding-no-allocation-only',
            members: [
              {
                memberId: 'TEST-member-A',
                generation: 'TEST-generation',
                attemptId: 'TEST-attempt',
                status: 'pending-human',
                nativeReady: true,
                usable: false,
                controlAvailable: true,
                noAllocation: false,
                reason: 'human-required',
              },
            ],
          },
        };
      if (request.operation === 'runtime.activity.snapshot')
        return projectBackendResult(request, { ok: true, value: snapshot() });
      if (request.operation === 'runtime.activity.feed') {
        const next = snapshot();
        return projectBackendResult(request, {
          ok: true,
          value: {
            memberId: next.memberId,
            cursor: next.cursor,
            retainedFrom: 1,
            hasMore: false,
            events: [
              {
                eventId: 'TEST-latest-state',
                sequence: 10,
                data: { kind: 'state', state: next.state },
              },
            ],
          },
        });
      }
      if (request.operation === 'runtime.read') {
        await runtimeReadGate;
        return { ok: true, value: runtime() };
      }
      if (request.operation !== 'runtime.interaction')
        throw new Error('Unexpected operation/effect');
      parseBackendOperation(request);
      replies.push(structuredClone(request));
      const pending = facts.find((fact) => fact.interactionRef === request.payload.interactionRef)!;
      pending.phase = 'resolved';
      if (loseReply) throw new Error('TEST lost response after original effect');
      return { ok: true, value: runtime() };
    },
  };
  const legacy = {
    onToolApprovalEvent: (listener: typeof legacyListener) => {
      legacyListener = listener;
      return () => {
        legacyListener = undefined;
      };
    },
    respondToToolApproval: vi.fn(),
  };
  const api = createHostTeamsApi(legacy as unknown as TeamsAPI, backend, () => () => authorized);
  const state = {
    pendingApprovals: [] as ToolApprovalRequest[],
    resolvedApprovals: new Map<string, boolean>(),
  };
  const events: ToolApprovalEvent[] = [];
  const stop = api.onToolApprovalEvent((_event, event) => {
    events.push(event);
    Object.assign(state, applyToolApprovalEvent(state, event));
    ui.queue = state.pendingApprovals;
  });
  cleanups.push(stop);
  return {
    api,
    key,
    calls,
    replies,
    events,
    state,
    legacy,
    facts,
    legacyEvent: (event: ToolApprovalEvent) => legacyListener?.(undefined, event),
    revoke: () => {
      authorized = false;
    },
    generation: (value: string) => {
      generation = value;
    },
    abort: () => {
      abort = true;
    },
    deferRuntimeRead: () => {
      let resume!: () => void;
      runtimeReadGate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return resume;
    },
    activitySnapshot: snapshot,
    loseReply: () => {
      loseReply = true;
    },
  };
}

async function ready() {
  await vi.advanceTimersByTimeAsync(0);
}
async function mount(f: ReturnType<typeof fixture>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  ui.respond.mockImplementation(async (...args: Parameters<TeamsAPI['respondToToolApproval']>) => {
    await f.api.respondToToolApproval(...args);
    const [teamName, runId, requestId, allow] = args;
    f.state.pendingApprovals = f.state.pendingApprovals.filter(
      (row) => !(row.teamName === teamName && row.runId === runId && row.requestId === requestId)
    );
    f.state.resolvedApprovals.set(requestId, allow);
    ui.queue = f.state.pendingApprovals;
  });
  await act(async () => root.render(<ToolApprovalSheet />));
  return {
    host,
    click: async (text: string) => {
      const button = [...host.querySelectorAll('button')].find(
        (row) =>
          row.textContent?.trim() === text ||
          row.querySelector('span.text-xs')?.textContent === text
      );
      expect(button).toBeTruthy();
      await act(async () => button!.click());
    },
  };
}

describe('captured Host interactions in the original approval UI', () => {
  it('joins real Main activity projection to original Allow and the exact captured Runtime destination', async () => {
    const f = fixture();
    await ready();
    expect(f.state.pendingApprovals).toHaveLength(1);
    const original = f.state.pendingApprovals[0]!;
    expect(JSON.stringify(original)).not.toContain('TEST-interaction-0');
    const sheet = await mount(f);
    expect(sheet.host.textContent).toContain('toolApproval.allowAll');
    await sheet.click('toolApproval.allow');
    expect(f.replies).toHaveLength(1);
    expect(f.replies[0]).toMatchObject({
      handle: { handleId: 'TEST-owner-A' },
      operation: 'runtime.interaction',
      payload: {
        memberId: 'TEST-member-A',
        expectedGeneration: 'TEST-generation',
        inputId: 'TEST-input-A',
        interactionRef: 'TEST-interaction-0',
        reply: { kind: 'permission', decision: 'allow' },
      },
    });
    expect(f.legacy.respondToToolApproval).not.toHaveBeenCalled();
    expect(f.state.resolvedApprovals.get(original.requestId)).toBe(true);
  });
  it.each(['answer', 'deny'] as const)(
    'keeps question %s separate from permissions and input interruption',
    async (action) => {
      const f = fixture('question');
      await ready();
      const sheet = await mount(f);
      if (action === 'answer') {
        await sheet.click('Use TEST fixture');
        await sheet.click('toolApproval.submit');
      } else await sheet.click('toolApproval.deny');
      expect(f.replies).toHaveLength(1);
      expect(f.replies[0]!.payload).toMatchObject({
        reply:
          action === 'answer'
            ? {
                kind: 'question',
                answers: { 'Proceed with TEST?': 'Use TEST fixture' },
              }
            : { kind: 'question', decision: 'deny' },
      });
      expect(f.calls.some((request) => request.operation === 'runtime.interrupt')).toBe(false);
    }
  );
  it('retains the original legacy per-request and policy controls', async () => {
    const f = fixture();
    await ready();
    ui.queue = [
      {
        ...f.state.pendingApprovals[0]!,
        teamName: 'legacy-TEST-team',
        requestId: 'legacy-TEST-request',
        runId: 'legacy-TEST-run',
      },
    ];
    const sheet = await mount(f);
    expect(sheet.host.textContent).toContain('toolApproval.allowAll');
    await sheet.click('toolApproval.deny');
    expect(f.legacy.respondToToolApproval).toHaveBeenCalledWith(
      'legacy-TEST-team',
      expect.any(String),
      expect.any(String),
      false,
      undefined
    );
    expect(f.replies).toHaveLength(0);
  });
  it('dismisses only the exact expired/terminal interaction and never invents an allowed result', async () => {
    const f = fixture('permission', 2);
    await ready();
    const [a, b] = f.state.pendingApprovals;
    f.facts[0]!.phase = 'unknown';
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.pendingApprovals.map((row) => row.requestId)).toEqual([b!.requestId]);
    expect(f.events).toContainEqual({
      dismissed: true,
      teamName: a!.teamName,
      runId: a!.runId,
      requestId: a!.requestId,
    });
    expect(f.state.resolvedApprovals.size).toBe(0);
    f.legacyEvent({ dismissed: true, teamName: f.key, runId: b!.runId });
    expect(f.state.pendingApprovals).toHaveLength(1); // Reserved Host selections cannot be dismissed by legacy events.
    const legacy = {
      ...b!,
      teamName: 'legacy-test-team',
      requestId: 'legacy-1',
      runId: 'legacy-run',
    };
    f.legacyEvent(legacy);
    f.legacyEvent({ ...legacy, requestId: 'legacy-2' });
    f.legacyEvent({
      dismissed: true,
      teamName: legacy.teamName,
      runId: legacy.runId,
    });
    expect(f.state.pendingApprovals.map((row) => row.requestId)).toEqual([b!.requestId]);
  });
  it('rejects changed public targets before RPC and stale generation/abort/revocation/expiry before replying', async () => {
    const f = fixture();
    await ready();
    const request = f.state.pendingApprovals[0]!;
    const count = f.calls.length;
    for (const args of [
      [hostTeamSelectionKey('TEST-owner-B'), request.runId, request.requestId],
      [request.teamName, 'other-run', request.requestId],
      [request.teamName, request.runId, 'other-request'],
    ]) {
      await expect(
        f.api.respondToToolApproval(args[0]!, args[1]!, args[2]!, true)
      ).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(count);
    f.generation('another-generation');
    await expect(
      f.api.respondToToolApproval(request.teamName, request.runId, request.requestId, true)
    ).rejects.toThrow();
    f.generation('TEST-generation');
    f.abort();
    await expect(
      f.api.respondToToolApproval(request.teamName, request.runId, request.requestId, true)
    ).rejects.toThrow();
    f.revoke();
    await expect(
      f.api.respondToToolApproval(request.teamName, request.runId, request.requestId, true)
    ).rejects.toThrow();
    expect(f.replies).toHaveLength(0);
    const expired = fixture();
    await ready();
    const old = expired.state.pendingApprovals[0]!;
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(
      expired.api.respondToToolApproval(old.teamName, old.runId, old.requestId, true)
    ).rejects.toThrow();
    expect(expired.replies).toHaveLength(0);
  });
  it('retains an uncertain reply without a second effect or an inferred allow', async () => {
    const f = fixture();
    await ready();
    const request = f.state.pendingApprovals[0]!;
    f.loseReply();
    await expect(
      f.api.respondToToolApproval(request.teamName, request.runId, request.requestId, true)
    ).rejects.toThrow('lost response');
    await expect(
      f.api.respondToToolApproval(request.teamName, request.runId, request.requestId, false)
    ).rejects.toThrow();
    expect(f.replies).toHaveLength(1);
    expect(f.state.resolvedApprovals.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.pendingApprovals).toHaveLength(0);
    expect(f.state.resolvedApprovals.size).toBe(0);
  });
  it('fences authority revoked while the original pre-response read is outstanding', async () => {
    const f = fixture();
    await ready();
    const request = f.state.pendingApprovals[0]!;
    const resume = f.deferRuntimeRead();
    const response = f.api.respondToToolApproval(
      request.teamName,
      request.runId,
      request.requestId,
      true
    );
    const rejected = expect(response).rejects.toThrow();
    f.revoke();
    resume();
    await rejected;
    expect(f.replies).toHaveLength(0);
    expect(f.state.resolvedApprovals.size).toBe(0);
  });
  it('joins only exact pending content and refuses malformed question options or uncertain state', () => {
    const f = fixture('question');
    const original = f.activitySnapshot();
    expect(pendingHostToolInteractions(original, Date.now())).toHaveLength(1);
    const wrongInput = structuredClone(original);
    wrongInput.latest.interactions[0]!.inputId = 'other-input';
    expect(pendingHostToolInteractions(wrongInput, Date.now())).toEqual([]);
    const invalidQuestion = structuredClone(original);
    const event = invalidQuestion.latest.interactions[0]!;
    if (event.data.kind !== 'interaction' || event.data.request.kind !== 'question')
      throw new Error('TEST fixture');
    event.data.request.questions = [
      { question: 'Unsafe object', options: [{ label: { unsafe: true } }] },
    ];
    expect(pendingHostToolInteractions(invalidQuestion, Date.now())).toEqual([]);
    const revoked = structuredClone(original);
    revoked.state!.sealed = true;
    expect(pendingHostToolInteractions(revoked, Date.now())).toEqual([]);
    const expired = structuredClone(original);
    expired.state!.interactions[0]!.expiresAt = Date.now();
    expect(pendingHostToolInteractions(expired, Date.now())).toEqual([]);
  });
  it('validates question denial as a disjoint JSON reply at Main and Host transport boundaries', () => {
    const base = {
      memberId: 'TEST-member',
      expectedGeneration: 'TEST-generation',
      inputId: 'TEST-input',
      interactionRef: 'TEST-ref',
    };
    const envelope = (reply: unknown) => ({
      handle: { handleId: 'TEST-owner' },
      commandId: 'TEST-response',
      operation: 'runtime.interaction',
      payload: { ...base, reply },
    });
    expect(parseBackendOperation(envelope({ kind: 'question', decision: 'deny' }))).toMatchObject({
      payload: { reply: { kind: 'question', decision: 'deny' } },
    });
    expect(
      runtimeInteraction.parse({
        ...base,
        reply: { kind: 'question', decision: 'deny' },
      })
    ).toMatchObject({ reply: { decision: 'deny' } });
    for (const reply of [
      { kind: 'question', decision: 'allow' },
      { kind: 'question', decision: 'deny', answers: {} },
      { kind: 'question', decision: 'deny', extra: true },
    ]) {
      expect(() => parseBackendOperation(envelope(reply))).toThrow();
      expect(() => runtimeInteraction.parse({ ...base, reply })).toThrow();
    }
    let reads = 0;
    const getter = {
      kind: 'question',
      get decision() {
        reads++;
        return 'deny';
      },
    };
    expect(() => parseBackendOperation(envelope(getter))).toThrow();
    expect(reads).toBe(0);
  });
});
