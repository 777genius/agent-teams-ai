import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { resolveAgentAttachmentArtifactPath, writeFileAtomic } from './attachmentArtifactStore';

describe('agent attachment artifact store helpers', () => {
  it('resolves paths under the managed attachment directory', () => {
    const root = path.join(os.tmpdir(), 'agent-attachments-test');
    const resolved = resolveAgentAttachmentArtifactPath({
      appDataPath: root,
      teamName: 'team_1',
      messageId: 'msg_1',
      attachmentId: 'att_1',
      fileName: 'optimized.png',
    });
    expect(resolved).toBe(
      path.join(root, 'attachments', 'team_1', 'msg_1', 'att_1', 'optimized.png')
    );
  });

  it('rejects unsafe ids before path construction', () => {
    expect(() =>
      resolveAgentAttachmentArtifactPath({
        // eslint-disable-next-line sonarjs/publicly-writable-directories -- Unit test uses a fixed synthetic root and never writes to it.
        appDataPath: '/tmp/root',
        teamName: 'team_1',
        messageId: '../msg',
        attachmentId: 'att_1',
        fileName: 'optimized.png',
      })
    ).toThrow(/Invalid messageId/);
  });

  it('writes files atomically', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-attachments-'));
    const filePath = path.join(dir, 'file.txt');
    await writeFileAtomic(filePath, 'hello');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('hello');
  });
});
