import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrossTeamOutbox } from '@main/services/team/CrossTeamOutbox';

import type { CrossTeamMessage } from '@shared/types';

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => tmpDir,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
  fs.mkdirSync(path.join(tmpDir, 'test-team'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeMessage(overrides: Partial<CrossTeamMessage> = {}): CrossTeamMessage {
  return {
    messageId: 'msg-1',
    fromTeam: 'team-a',
    fromMember: 'lead',
    toTeam: 'team-b',
    text: 'hello',
    chainDepth: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('CrossTeamOutbox', () => {
  let outbox: CrossTeamOutbox;

  beforeEach(() => {
    outbox = new CrossTeamOutbox();
  });

  it('returns empty array when no outbox file exists', async () => {
    const result = await outbox.read('test-team');
    expect(result).toEqual([]);
  });

  it('appends a message and reads it back', async () => {
    const msg = makeMessage();
    await outbox.append('test-team', msg);

    const result = await outbox.read('test-team');
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-1');
    expect(result[0].fromTeam).toBe('team-a');
  });

  it('appends multiple messages', async () => {
    await outbox.append('test-team', makeMessage({ messageId: 'msg-1' }));
    await outbox.append('test-team', makeMessage({ messageId: 'msg-2' }));

    const result = await outbox.read('test-team');
    expect(result).toHaveLength(2);
  });

  it('appendIfNotRecent returns duplicate for recent equivalent message', async () => {
    const existing = makeMessage({
      messageId: 'msg-existing',
      text: 'Please   review this API',
      summary: ' Review request ',
    });
    await outbox.append('test-team', existing);

    const onBeforeAppend = vi.fn(async () => {});
    const result = await outbox.appendIfNotRecent(
      'test-team',
      makeMessage({
        messageId: 'msg-new',
        text: 'please review this api',
        summary: 'review request',
      }),
      onBeforeAppend
    );

    expect(result.duplicate?.messageId).toBe('msg-existing');
    expect(onBeforeAppend).not.toHaveBeenCalled();

    const list = await outbox.read('test-team');
    expect(list).toHaveLength(1);
  });
});
