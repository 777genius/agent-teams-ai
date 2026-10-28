import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMBER_LOG_PREVIEW_BUDGET } from '../../../../../core/domain/models/MemberLogPreviewBudget';
import { DEFAULT_MEMBER_LOG_STREAM_BUDGET } from '../../../../../core/domain/models/MemberLogStreamBudget';
import { OpenCodeMemberRuntimePreviewSource } from '../OpenCodeMemberRuntimePreviewSource';
import { OpenCodeMemberRuntimeStreamSource } from '../OpenCodeMemberRuntimeStreamSource';

import type {
  OpenCodeMemberTranscriptBinding,
  OpenCodeTranscriptBindingReader,
} from '../OpenCodeMemberTranscriptBindingReader';

const request = {
  teamName: 'TEST-team',
  memberName: 'alice',
  laneId: 'primary',
  budget: { ...DEFAULT_MEMBER_LOG_PREVIEW_BUDGET, ...DEFAULT_MEMBER_LOG_STREAM_BUDGET },
  maxItems: 3,
  textLimit: 200,
};
const projection = {
  sessionId: 'ses_original',
  logProjection: {
    messages: [
      {
        uuid: 'native-message',
        parentUuid: null,
        type: 'assistant',
        timestamp: '2026-10-29T00:00:00.000Z',
        role: 'assistant',
        content: 'unique native marker',
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        sessionId: 'ses_original',
      },
    ],
  },
};
function bindings(mode: 'active' | 'stopped' = 'active') {
  let current: OpenCodeMemberTranscriptBinding = {
    kind: 'bound',
    mode,
    runId: 'sdk-original',
    laneId: 'primary',
    sessionId: 'ses_original',
    cacheKey: `${mode}:original`,
  };
  const reader: OpenCodeTranscriptBindingReader = {
    read: async () => current,
    isCurrent: async (_, original) => original.cacheKey === current.cacheKey,
  };
  return {
    reader,
    change: (binding: OpenCodeMemberTranscriptBinding) => {
      current = binding;
    },
  };
}
const unavailable = { kind: 'unavailable', reason: 'inactive', cacheKey: 'stop' } as const;
const resolver = { resolve: async () => '/TEST/orchestrator' };
const chunks = { buildBundleChunks: () => [{ id: 'native-chunk' }] } as never;
const activity = { list: async () => [] } as never;
const ledger = { list: async () => [] };

describe('original transcript source admission', () => {
  it('passes every original selector for lead and member through both existing bridge calls', async () => {
    const b = bindings();
    const getOpenCodeTranscript = vi.fn(async () => projection);
    const stream = new OpenCodeMemberRuntimeStreamSource(
      { getOpenCodeTranscript } as never,
      chunks,
      resolver,
      activity,
      b.reader
    );
    const preview = new OpenCodeMemberRuntimePreviewSource(
      { getOpenCodeTranscript } as never,
      resolver,
      ledger,
      activity,
      b.reader
    );
    for (const memberName of ['team-lead', 'alice']) {
      await stream.load({ ...request, memberName });
      await preview.loadPreview({ ...request, memberName });
      expect(getOpenCodeTranscript).toHaveBeenLastCalledWith(
        '/TEST/orchestrator',
        expect.objectContaining({
          teamId: 'TEST-team',
          memberName,
          laneId: 'primary',
          runId: 'sdk-original',
          sessionId: 'ses_original',
        })
      );
    }
  });

  it('discards an in-flight native result after STOP and does not call the bridge on unavailable binding', async () => {
    const b = bindings();
    let finish!: (value: typeof projection) => void;
    const getOpenCodeTranscript = vi.fn(
      () =>
        new Promise<typeof projection>((resolve) => {
          finish = resolve;
        })
    );
    const stream = new OpenCodeMemberRuntimeStreamSource(
      { getOpenCodeTranscript } as never,
      chunks,
      resolver,
      activity,
      b.reader
    );
    const result = stream.load(request);
    await vi.waitFor(() => expect(getOpenCodeTranscript).toHaveBeenCalledOnce());
    b.change(unavailable);
    finish(projection);
    expect((await result).segments).toEqual([]);
    expect((await stream.load(request)).warnings[0]?.code).toBe('opencode_runtime_unavailable');
    expect(getOpenCodeTranscript).toHaveBeenCalledOnce();
  });

  it('only reports lane ambiguity from the typed binding reader', async () => {
    const b = bindings();
    b.change({ kind: 'unavailable', reason: 'ambiguous', cacheKey: 'duplicate-evidence' });
    const getOpenCodeTranscript = vi.fn();
    const stream = new OpenCodeMemberRuntimeStreamSource(
      { getOpenCodeTranscript } as never,
      chunks,
      resolver,
      activity,
      b.reader
    );
    expect((await stream.load(request)).warnings[0]?.code).toBe('opencode_ambiguous_lane');
    expect(getOpenCodeTranscript).not.toHaveBeenCalled();
  });

  it('does not reuse a completed source cache after the same member joins a successor run', async () => {
    const b = bindings();
    const getOpenCodeTranscript = vi.fn(async () => projection);
    const stream = new OpenCodeMemberRuntimeStreamSource(
      { getOpenCodeTranscript } as never,
      chunks,
      resolver,
      activity,
      b.reader
    );
    await stream.load(request);
    b.change({
      kind: 'bound',
      mode: 'active',
      runId: 'sdk-successor',
      sessionId: 'ses_successor',
      laneId: 'primary',
      cacheKey: 'successor',
    });
    await stream.load(request);
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(2);
    expect(getOpenCodeTranscript).toHaveBeenLastCalledWith(
      '/TEST/orchestrator',
      expect.objectContaining({ runId: 'sdk-successor', sessionId: 'ses_successor' })
    );
  });

  it('keeps stopped V1 native preview ahead of retained activity, and reports retired V2 truthfully', async () => {
    const b = bindings('stopped');
    const retained = {
      list: async () => [
        {
          id: 'canonical',
          timestamp: '2026-10-29T00:00:00.000Z',
          title: 'Message',
          text: 'retained canonical message',
          sourceLabel: 'OpenCode team inbox',
        },
      ],
    } as never;
    const getOpenCodeTranscript = vi
      .fn()
      .mockResolvedValueOnce(projection)
      .mockRejectedValueOnce(new Error('v2_transcript_original_owner_unavailable'));
    const preview = new OpenCodeMemberRuntimePreviewSource(
      { getOpenCodeTranscript } as never,
      resolver,
      ledger,
      retained,
      b.reader
    );
    const v1 = await preview.loadPreview(request);
    expect(v1.items[0]).toMatchObject({
      sessionId: 'ses_original',
      sourceLabel: 'OpenCode runtime',
      preview: 'unique native marker',
    });
    const v2 = await preview.loadPreview({ ...request, forceRefresh: true });
    expect(v2.items[0]?.sourceLabel).toBe('OpenCode team inbox');
    expect(v2.warnings).toContainEqual(
      expect.objectContaining({ code: 'opencode_runtime_unavailable' })
    );
  });

  it('never derives ambiguity or raw UI warnings from minified Bun source and preserves finite timeout metadata', async () => {
    const b = bindings();
    const getOpenCodeTranscript = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Command failed\n1 | minified multiple lane requires --lane\nerror: No stored OpenCode session record for TEST-team/primary/alice\n'
        )
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('sensitive command'), {
          code: 'ETIMEDOUT',
          killed: true,
          signal: 'SIGTERM',
        })
      );
    const stream = new OpenCodeMemberRuntimeStreamSource(
      { getOpenCodeTranscript } as never,
      chunks,
      resolver,
      activity,
      b.reader
    );
    const missing = await stream.load(request);
    expect(missing.warnings[0]?.code).toBe('opencode_runtime_unavailable');
    expect(JSON.stringify(missing.warnings)).not.toMatch(/minified|No stored|sensitive/);
    expect((await stream.load({ ...request, forceRefresh: true })).warnings[0]?.code).toBe(
      'opencode_runtime_timeout'
    );
  });
});
