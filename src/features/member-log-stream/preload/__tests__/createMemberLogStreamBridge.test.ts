import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MEMBER_LOG_STREAM_GET,
  MEMBER_LOG_STREAM_GET_PREVIEWS,
  MEMBER_LOG_STREAM_GET_RUNTIME_LOG_TAIL,
  MEMBER_LOG_STREAM_SET_TRACKING,
} from '../../contracts';
import { createMemberLogStreamBridge } from '../createMemberLogStreamBridge';

const mocks = vi.hoisted(() => ({
  ipcRenderer: {
    invoke: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcRenderer: mocks.ipcRenderer,
}));

describe('createMemberLogStreamBridge', () => {
  beforeEach(() => {
    mocks.ipcRenderer.invoke.mockReset();
  });

  it('forwards member log stream IPC requests and normalizes response payloads', async () => {
    mocks.ipcRenderer.invoke.mockResolvedValueOnce({
      success: true,
      data: {
        participants: [],
        segments: [],
        generatedAt: '2026-04-02T00:00:00.000Z',
      },
    });
    const bridge = createMemberLogStreamBridge();

    const response = await bridge.getMemberLogStream('alpha-team', 'alice', {
      limitSegments: 30,
      laneId: 'secondary:opencode:alice',
      forceRefresh: true,
    });

    expect(response).toMatchObject({
      participants: [],
      segments: [],
      source: 'member_empty',
      generatedAt: '2026-04-02T00:00:00.000Z',
      metadata: {
        scannedTranscriptFileCount: 0,
        includedTranscriptFileCount: 0,
        droppedSegmentCount: 0,
        droppedChunkCount: 0,
        droppedMessageCount: 0,
      },
    });
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(
      MEMBER_LOG_STREAM_GET,
      'alpha-team',
      'alice',
      {
        limitSegments: 30,
        laneId: 'secondary:opencode:alice',
        forceRefresh: true,
      }
    );
  });

  it('forwards tracking calls and throws IPC errors', async () => {
    mocks.ipcRenderer.invoke
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'bad lane' });
    const bridge = createMemberLogStreamBridge();

    await expect(bridge.setMemberLogStreamTracking('alpha-team', true)).resolves.toBeUndefined();
    await expect(bridge.getMemberLogStream('alpha-team', 'alice')).rejects.toThrow('bad lane');

    expect(mocks.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      MEMBER_LOG_STREAM_SET_TRACKING,
      'alpha-team',
      true
    );
  });

  it('forwards batch member log preview IPC requests and normalizes response payloads', async () => {
    mocks.ipcRenderer.invoke.mockResolvedValueOnce({
      success: true,
      data: {
        members: [
          {
            memberName: 'alice',
            items: [],
            generatedAt: '2026-04-02T00:00:00.000Z',
          },
        ],
        generatedAt: '2026-04-02T00:00:00.000Z',
      },
    });
    const bridge = createMemberLogStreamBridge();

    const response = await bridge.getMemberLogPreviews('alpha-team', ['alice'], {
      maxItemsPerMember: 3,
      textLimit: 200,
      laneIdsByMember: { alice: 'secondary:opencode:alice' },
    });

    expect(response.members[0]).toMatchObject({
      memberName: 'alice',
      items: [],
      coverage: [],
      warnings: [],
      truncated: false,
      overflowCount: 0,
    });
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(
      MEMBER_LOG_STREAM_GET_PREVIEWS,
      'alpha-team',
      ['alice'],
      {
        maxItemsPerMember: 3,
        textLimit: 200,
        laneIdsByMember: { alice: 'secondary:opencode:alice' },
      }
    );
  });

  it('forwards process runtime log tail IPC requests and normalizes response payloads', async () => {
    mocks.ipcRenderer.invoke.mockResolvedValueOnce({
      success: true,
      data: {
        kind: 'stderr',
        content: 'OpenCode API error',
        truncated: true,
        bytesRead: 131072,
        fileSizeBytes: 262144,
        updatedAt: '2026-04-02T00:00:00.000Z',
        missing: false,
      },
    });
    const bridge = createMemberLogStreamBridge();

    const response = await bridge.getMemberRuntimeLogTail('alpha-team', 'alice', {
      kind: 'stderr',
      maxBytes: 131072,
      forceRefresh: true,
    });

    expect(response).toEqual({
      kind: 'stderr',
      content: 'OpenCode API error',
      truncated: true,
      bytesRead: 131072,
      fileSizeBytes: 262144,
      updatedAt: '2026-04-02T00:00:00.000Z',
      missing: false,
    });
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(
      MEMBER_LOG_STREAM_GET_RUNTIME_LOG_TAIL,
      'alpha-team',
      'alice',
      {
        kind: 'stderr',
        maxBytes: 131072,
        forceRefresh: true,
      }
    );
  });
});
