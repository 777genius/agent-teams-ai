import { describe, expect, it } from 'vitest';

import {
  admitNativeTeammateAttachmentMessage,
  enrichTeamSnapshotNativeAttachmentSupport,
} from '../../../src/features/agent-attachments/main/application/nativeTeammateAttachmentAdmission';

import type { NativeAttachmentInboxRequest } from '../../../src/features/agent-attachments/main/application/nativeTeammateAttachmentAdmission';
import type { NativeInboxAttachmentCapabilityProof } from '../../../src/features/member-work-sync/main';
import type { AttachmentPayload, TeamAgentRuntimeSnapshot } from '../../../src/shared/types';

const attachment: AttachmentPayload = {
  id: 'attachment-1',
  filename: 'image.png',
  mimeType: 'image/png',
  size: 5,
  data: Buffer.from('hello').toString('base64'),
};

function proof(
  overrides: Partial<NativeInboxAttachmentCapabilityProof> = {}
): NativeInboxAttachmentCapabilityProof {
  return {
    schemaVersion: 1,
    recoveryProtocolVersion: 2,
    teamName: 'TEST-team',
    teamIncarnation: 'unspecified',
    memberName: 'worker',
    providerId: 'anthropic',
    runtimeMode: 'repl',
    runtimeInstanceId: 'instance-1',
    generation: 1,
    processorReady: true,
    nativeInboxAttachmentsVersion: 1,
    pid: 42,
    bootstrapRunId: 'run-1',
    ...overrides,
  };
}

function snapshot(overrides: Partial<TeamAgentRuntimeSnapshot> = {}): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'TEST-team',
    runId: 'run-1',
    updatedAt: new Date().toISOString(),
    members: {
      worker: {
        memberName: 'worker',
        alive: true,
        restartable: true,
        pid: 42,
        runtimePid: 42,
        runtimeSessionId: 'run-1',
        updatedAt: new Date().toISOString(),
      },
    },
    ...overrides,
  } as TeamAgentRuntimeSnapshot;
}

describe('native teammate attachment admission', () => {
  it.each([
    ['claude-opus-4-6', 'anthropic', 1],
    ['gpt-5.4', 'codex', 1],
    ['gpt-5.4', 'codex', 2],
  ] as const)(
    'enriches a current %s member with no explicit provider',
    async (model, providerId, version) => {
      let expectedProviderId: string | undefined;
      const result = await enrichTeamSnapshotNativeAttachmentSupport({
        teamName: 'TEST-team',
        snapshot: {
          teamName: 'TEST-team',
          config: { name: 'TEST-team' },
          tasks: [],
          members: [{ name: 'worker', model, currentTaskId: null, taskCount: 0 }],
          kanbanState: { teamName: 'TEST-team', reviewers: [], tasks: {} },
          processes: [],
        },
        deps: {
          teamsBasePath: '/tmp/teams',
          readCapability: async (input) => {
            expectedProviderId = input.expectedProviderId;
            return proof({ providerId, nativeInboxAttachmentsVersion: version });
          },
          readRuntimeSnapshot: async () => snapshot(),
          isProcessAlive: (pid) => pid === 42,
        },
      });

      expect(expectedProviderId).toBe(providerId);
      expect(result.members[0].nativeInboxAttachmentsSupported).toBe(true);
      expect(result.members[0].providerId).toBeUndefined();
      expect(result.members[0].nativeInboxTextAttachmentsSupported).toBe(
        providerId === 'codex' && version === 2
      );
    }
  );

  it('binds the immutable envelope to the current runtime actor', async () => {
    let written: NativeAttachmentInboxRequest | undefined;
    const result = await admitNativeTeammateAttachmentMessage(
      {
        teamName: 'TEST-team',
        memberName: 'worker',
        providerId: 'anthropic',
        messageId: 'message-1',
        request: { member: 'worker', text: 'hello', from: 'user', source: 'user_sent' },
        attachments: [attachment],
      },
      {
        teamsBasePath: '/tmp/teams',
        readCapability: async () => proof(),
        readRuntimeSnapshot: async () => snapshot(),
        attachmentStore: {
          saveNativeAttachments: async () => [
            {
              id: attachment.id,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              size: attachment.size,
              filePath: '/tmp/attachments/image.png',
              sha256: 'abc',
            },
          ],
        },
        writeInbox: async (_team, request) => {
          written = request;
          return { deliveredToInbox: true, messageId: request.messageId! };
        },
        runWithLiveRosterMutation: async (_team, operation) => operation(),
        isProcessAlive: () => true,
      }
    );

    expect(result.deliveredToInbox).toBe(true);
    expect(written?.recipientRuntimeInstanceId).toBe('instance-1');
    expect(written?.attachments).toEqual([
      {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        filePath: '/tmp/attachments/image.png',
        sha256: 'abc',
      },
    ]);
    expect(written?.attachments[0]).not.toHaveProperty('data');
  });

  it('rejects a stale actor before publishing an inbox row', async () => {
    let saved = false;
    await expect(
      admitNativeTeammateAttachmentMessage(
        {
          teamName: 'TEST-team',
          memberName: 'worker',
          providerId: 'anthropic',
          messageId: 'message-1',
          request: { member: 'worker', text: 'hello', from: 'user', source: 'user_sent' },
          attachments: [attachment],
        },
        {
          teamsBasePath: '/tmp/teams',
          readCapability: async () => proof({ pid: 43 }),
          readRuntimeSnapshot: async () => snapshot(),
          attachmentStore: {
            saveNativeAttachments: async () => {
              saved = true;
              return [];
            },
          },
          writeInbox: async () => ({ deliveredToInbox: true, messageId: 'message-1' }),
          runWithLiveRosterMutation: async (_team, operation) => operation(),
          isProcessAlive: () => true,
        }
      )
    ).rejects.toThrow(/stale|another run/i);
    expect(saved).toBe(false);
  });

  it.each([
    [1, false, 'stable', true],
    [1, true, 'stable', false],
    [2, true, 'stable', true],
    [2, true, 'downgrade-after-save', false],
    [2, true, 'restart-before-write', false],
    [2, true, 'stale-run', false],
  ] as const)(
    'fences Codex capability %s text %s lifecycle %s',
    async (version, textBatch, lifecycle, admitted) => {
      const text = { ...attachment, id: 'text', filename: 'values.json', mimeType: 'text/plain' };
      let reads = 0;
      let saved = false;
      let published = false;
      const promise = admitNativeTeammateAttachmentMessage(
        {
          teamName: 'TEST-team',
          memberName: 'worker',
          providerId: 'codex',
          messageId: 'message-2',
          request: { member: 'worker', text: 'inspect', from: 'user', source: 'user_sent' },
          attachments: textBatch ? [text, attachment] : [attachment],
        },
        {
          teamsBasePath: '/tmp/teams',
          readCapability: async () => {
            reads += 1;
            return proof({
              providerId: 'codex',
              nativeInboxAttachmentsVersion: version as 1 | 2,
              ...(lifecycle === 'stale-run' ? { bootstrapRunId: 'old-run' } : {}),
              ...(lifecycle === 'downgrade-after-save' && reads >= 2
                ? { nativeInboxAttachmentsVersion: 1 }
                : {}),
              ...(lifecycle === 'restart-before-write' && reads >= 3
                ? { runtimeInstanceId: 'restarted' }
                : {}),
            });
          },
          readRuntimeSnapshot: async () => snapshot(),
          attachmentStore: {
            saveNativeAttachments: async (_team, _message, attachments) => {
              saved = true;
              return attachments.map(({ data: _data, ...meta }) => ({
                ...meta,
                filePath: '/tmp/attachments/' + meta.filename,
                sha256: 'abc',
              }));
            },
          },
          writeInbox: async (_team, request, options) => {
            published = await options.shouldStillWrite();
            return { deliveredToInbox: published, messageId: request.messageId! };
          },
          runWithLiveRosterMutation: async (_team, operation) => operation(),
          isProcessAlive: () => true,
        }
      );
      if (admitted) await expect(promise).resolves.toMatchObject({ deliveredToInbox: true });
      else await expect(promise).rejects.toThrow();
      expect(published).toBe(admitted);
      if (version === 1 && textBatch) expect(saved).toBe(false);
    }
  );
});
