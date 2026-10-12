import { describe, expect, it } from 'vitest';

import { admitNativeTeammateAttachmentMessage } from '../../../src/features/agent-attachments/main/application/nativeTeammateAttachmentAdmission';

import type { NativeInboxAttachmentCapabilityProof } from '../../../src/features/member-work-sync/main';
import type {
  NativeAttachmentInboxRequest,
} from '../../../src/features/agent-attachments/main/application/nativeTeammateAttachmentAdmission';
import type { AttachmentPayload, TeamAgentRuntimeSnapshot } from '../../../src/shared/types';

const attachment: AttachmentPayload = {
  id: 'attachment-1',
  filename: 'image.png',
  mimeType: 'image/png',
  size: 5,
  data: Buffer.from('hello').toString('base64'),
};

function proof(overrides: Partial<NativeInboxAttachmentCapabilityProof> = {}): NativeInboxAttachmentCapabilityProof {
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
});
