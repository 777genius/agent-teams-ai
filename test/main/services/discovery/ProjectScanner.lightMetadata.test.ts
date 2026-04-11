import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';

describe('ProjectScanner light metadata', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Ignore cleanup failures
      }
    }
    tempDirs.length = 0;
  });

  it('reuses analyzed metadata so light sessions expose the real message count', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-light-'));
    tempDirs.push(projectsDir);

    const encodedName = '-Users-test-myproject';
    const projectDir = path.join(projectsDir, encodedName);
    fs.mkdirSync(projectDir);

    const filePath = path.join(projectDir, 'session.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          cwd: '/Users/test/myproject',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'hello world' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'assistant', content: 'hi there' },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const scanner = new ProjectScanner(projectsDir);
    const session = await (
      scanner as unknown as {
        buildLightSessionMetadata: (
          projectId: string,
          sessionId: string,
          filePath: string,
          projectPath: string
        ) => Promise<{ messageCount: number; firstMessage?: string; metadataLevel: string }>;
      }
    ).buildLightSessionMetadata(
      encodedName,
      'session',
      filePath,
      '/Users/test/myproject'
    );

    expect(session.metadataLevel).toBe('light');
    expect(session.firstMessage).toBe('hello world');
    expect(session.messageCount).toBe(2);
  });
});
