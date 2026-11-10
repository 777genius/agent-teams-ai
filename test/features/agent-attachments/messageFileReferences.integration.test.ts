import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildLeadMessageStdinPayload } from '@main/services/team/provisioning/TeamProvisioningLeadAttachments';
import { resolveOpenCodeInboxAttachmentPayloads } from '@main/services/team/provisioning/TeamProvisioningOpenCodeAttachmentPayloads';
import { TeamAttachmentStore } from '@main/services/team/TeamAttachmentStore';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeMessageAttachments } from '../../../src/features/agent-attachments/contracts';
import { admitNativeTeammateAttachmentMessage } from '../../../src/features/agent-attachments/main/application/nativeTeammateAttachmentAdmission';
import { prepareMessageAttachments } from '../../../src/features/agent-attachments/main/application/prepareMessageAttachments';

import type { NativeInboxAttachmentCapabilityProof } from '../../../src/features/member-work-sync/main';
import type { AttachmentPayload, TeamAgentRuntimeSnapshot } from '@shared/types';

function payload(id: string, mimeType: string, bytes: Buffer): AttachmentPayload {
  return { id, filename: id, mimeType, size: bytes.length, data: bytes.toString('base64') };
}

describe('immutable mixed inbox and history boundary', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-reference-contract-'));
    setAppDataBasePath(root);
    setClaudeBasePathOverride(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    setAppDataBasePath(null);
    setClaudeBasePathOverride(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves mixed bytes once, binds native identity, reloads ordered cards and rejects mutated retry', async () => {
    const store = new TeamAttachmentStore();
    const writer = new TeamInboxWriter();
    const saved = vi.spyOn(store, 'saveNativeAttachments');
    const bytes = Buffer.from([0, 255, 4, 5]);
    const attachments = [
      payload('binary', 'application/octet-stream', bytes),
      payload('text', 'text/plain', Buffer.from('native text')),
    ];
    const proof = {
      schemaVersion: 1,
      recoveryProtocolVersion: 2,
      teamName: 'TEST-team',
      teamIncarnation: 'unspecified',
      memberName: 'worker',
      providerId: 'codex',
      runtimeMode: 'repl',
      runtimeInstanceId: 'instance',
      generation: 1,
      processorReady: true,
      nativeInboxAttachmentsVersion: 2,
      pid: process.pid,
      bootstrapRunId: 'run',
    } as NativeInboxAttachmentCapabilityProof;
    const snapshot = {
      teamName: 'TEST-team',
      runId: 'run',
      updatedAt: new Date().toISOString(),
      members: {
        worker: {
          memberName: 'worker',
          alive: true,
          restartable: true,
          pid: process.pid,
          runtimePid: process.pid,
          runtimeSessionId: 'run',
          updatedAt: new Date().toISOString(),
        },
      },
    } as TeamAgentRuntimeSnapshot;
    const input = {
      teamName: 'TEST-team',
      memberName: 'worker',
      providerId: 'codex' as const,
      messageId: 'message',
      attachments,
      request: { member: 'worker', text: 'user text', from: 'user', source: 'user_sent' as const },
    };
    const deps = {
      teamsBasePath: path.join(root, 'teams'),
      attachmentStore: store,
      readCapability: async () => proof,
      readRuntimeSnapshot: async () => snapshot,
      isProcessAlive: () => true,
      runWithLiveRosterMutation: async (_team: string, operation: () => Promise<void>) =>
        operation(),
      writeInbox: writer.sendNativeAttachmentMessage.bind(writer),
    };
    await admitNativeTeammateAttachmentMessage(input, deps);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith('TEST-team', 'message', attachments);
    const [row] = await new TeamInboxReader().getMessagesFor('TEST-team', 'worker');
    expect(row.attachments?.map((item) => item.id)).toEqual(['text']);
    expect(row.fileReferences?.map((item) => item.id)).toEqual(['binary']);
    const [raw] = JSON.parse(
      await fs.readFile(path.join(root, 'teams', 'TEST-team', 'inboxes', 'worker.json'), 'utf8')
    );
    expect(raw.nativeAttachmentDelivery).toEqual({
      version: 1,
      recipientRuntimeInstanceId: 'instance',
    });
    expect(mergeMessageAttachments(row).map((item) => item.id)).toEqual(['binary', 'text']);
    expect(await fs.readFile(row.fileReferences![0].filePath!)).toEqual(bytes);
    expect(row.fileReferences![0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const retry = await admitNativeTeammateAttachmentMessage(input, deps);
    expect(retry.deduplicated).toBe(true);
    await expect(
      admitNativeTeammateAttachmentMessage(
        { ...input, attachments: [...attachments].reverse() },
        deps
      )
    ).rejects.toThrow(/conflict/);
    expect(await new TeamInboxReader().getMessagesFor('TEST-team', 'worker')).toHaveLength(1);
  });

  it('rejects forged non-user attachment origin before creating storage', async () => {
    const store = new TeamAttachmentStore();
    const save = vi.spyOn(store, 'saveNativeAttachments');
    const { prepareMessageAttachments } =
      await import('../../../src/features/agent-attachments/main/application/prepareMessageAttachments');
    await expect(
      prepareMessageAttachments(
        {
          teamName: 'TEST-team',
          messageId: 'message',
          providerId: 'codex',
          isLeadRecipient: true,
          from: 'agent',
          text: 'text',
          attachments: [payload('binary', 'application/octet-stream', Buffer.from('data'))],
        },
        store
      )
    ).rejects.toThrow(/user origin/);
    expect(save).not.toHaveBeenCalled();
  });
  it('serializes saved reference descriptors through the actual lead stdin envelope with native content only', async () => {
    const store = new TeamAttachmentStore();
    const prepared = await prepareMessageAttachments(
      {
        teamName: 'TEST-team',
        messageId: 'lead-message',
        providerId: 'anthropic',
        isLeadRecipient: true,
        text: 'user text',
        attachments: [
          payload('ref', 'application/octet-stream', Buffer.from([0, 255])),
          payload('native', 'text/plain', Buffer.from('native text')),
        ],
      },
      store
    );
    const serialized = await buildLeadMessageStdinPayload({
      teamName: 'TEST-team',
      runId: 'run',
      providerId: 'anthropic',
      text: prepared.text,
      attachments: prepared.nativePayloads,
    });
    const envelope = JSON.parse(serialized);
    expect(envelope.type).toBe('user');
    expect(
      envelope.message.content.filter((block: { type: string }) => block.type === 'document')
    ).toHaveLength(1);
    expect(
      envelope.message.content.some(
        (block: { type: string; text?: string }) =>
          block.type === 'text' && block.text?.includes(prepared.fileReferences[0].filePath)
      )
    ).toBe(true);
    expect(serialized).not.toContain('application/octet-stream');
    expect(await fs.readFile(prepared.fileReferences[0].filePath)).toEqual(Buffer.from([0, 255]));
  });

  it('resolves only the OpenCode native subset from a store containing the entire mixed bundle', async () => {
    const store = new TeamAttachmentStore();
    const native = payload('native', 'image/png', Buffer.from('native bytes'));
    const prepared = await prepareMessageAttachments(
      {
        teamName: 'TEST-team',
        messageId: 'oc-message',
        providerId: 'opencode',
        isLeadRecipient: false,
        text: 'user text',
        attachments: [payload('ref', 'application/zip', Buffer.from('reference bytes')), native],
      },
      store
    );
    const result = await resolveOpenCodeInboxAttachmentPayloads(
      {
        teamName: 'TEST-team',
        message: {
          messageId: 'oc-message',
          from: 'user',
          text: prepared.text,
          timestamp: new Date().toISOString(),
          read: false,
          attachments: prepared.attachments,
          fileReferences: prepared.fileReferences,
        },
      },
      { attachmentStore: store }
    );
    expect(result).toMatchObject({ ok: true, attachments: [{ id: 'native', data: native.data }] });
    if (result.ok) expect(result.attachments).toHaveLength(1);
  });
});
