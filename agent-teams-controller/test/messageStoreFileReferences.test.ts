import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { createController } = require('../src/index.js');
let root: string | undefined;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('controller file-reference persistence', () => {
  it('keeps separate digest/order metadata through normalization and lookup without blobs', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-controller-reference-'));
    fs.mkdirSync(path.join(root, 'teams', 'TEST-team'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'teams', 'TEST-team', 'config.json'),
      JSON.stringify({ name: 'TEST-team', members: [{ name: 'lead', role: 'team-lead' }] })
    );
    const controller = createController({ claudeDir: root, teamName: 'TEST-team' });
    const reference = {
      id: 'ref',
      filename: 'data.bin',
      mimeType: 'application/octet-stream',
      size: 3,
      order: 0,
      sha256: 'b'.repeat(64),
      filePath: '/saved/data.bin',
      data: '/w==',
    };
    controller.messages.appendSentMessage({
      messageId: 'message',
      from: 'user',
      to: 'lead',
      text: 'text',
      source: 'user_sent',
      fileReferences: [reference],
    });
    const { message: row } = controller.messages.lookupMessage('message');
    expect(row.fileReferences).toEqual([
      {
        id: 'ref',
        filename: 'data.bin',
        mimeType: 'application/octet-stream',
        size: 3,
        order: 0,
        sha256: 'b'.repeat(64),
        filePath: '/saved/data.bin',
      },
    ]);
    expect(row.attachments).toBeUndefined();
  });
});
