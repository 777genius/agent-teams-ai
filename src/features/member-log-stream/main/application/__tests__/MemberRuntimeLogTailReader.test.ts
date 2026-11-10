import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { MemberRuntimeLogTailReader } from '../MemberRuntimeLogTailReader';

const tempDirs: string[] = [];

async function createTempTeamsBase(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'member-runtime-log-tail-'));
  tempDirs.push(dir);
  return dir;
}

async function writeRuntimeLog(
  teamsBasePath: string,
  teamName: string,
  memberName: string,
  suffix: string,
  content: string
): Promise<void> {
  const runtimeDir = path.join(teamsBasePath, teamName, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, `${memberName}.${suffix}`), content, 'utf8');
}

describe('MemberRuntimeLogTailReader', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reads only the bounded tail of large process logs', async () => {
    const teamsBasePath = await createTempTeamsBase();
    const reader = new MemberRuntimeLogTailReader({ teamsBasePath });
    await writeRuntimeLog(
      teamsBasePath,
      'alpha-team',
      'alice',
      'stdout.log',
      `${'x'.repeat(4096)}\nvisible tail`
    );

    const result = await reader.getTail({
      teamName: 'alpha-team',
      memberName: 'alice',
      kind: 'stdout',
      maxBytes: 1024,
    });

    expect(result.missing).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(1024);
    expect(result.content).toContain('visible tail');
  });

  it('returns missing without throwing when the runtime log file does not exist', async () => {
    const teamsBasePath = await createTempTeamsBase();
    const reader = new MemberRuntimeLogTailReader({ teamsBasePath });

    await expect(
      reader.getTail({
        teamName: 'alpha-team',
        memberName: 'alice',
        kind: 'stderr',
      })
    ).resolves.toMatchObject({
      kind: 'stderr',
      missing: true,
      content: '',
      bytesRead: 0,
    });
  });

  it('redacts obvious secrets before returning process log content', async () => {
    const teamsBasePath = await createTempTeamsBase();
    const reader = new MemberRuntimeLogTailReader({ teamsBasePath });
    await writeRuntimeLog(
      teamsBasePath,
      'alpha-team',
      'alice',
      'stderr.log',
      [
        'Authorization: Bearer secret-token-value-1234567890',
        'OPENAI_API_KEY=sk-secret-key-value-1234567890',
        '--api-key sk-ant-secret-value-1234567890',
      ].join('\n')
    );

    const result = await reader.getTail({
      teamName: 'alpha-team',
      memberName: 'alice',
      kind: 'stderr',
    });

    expect(result.content).toContain('Authorization: Bearer [redacted]');
    expect(result.content).toContain('OPENAI_API_KEY=[redacted]');
    expect(result.content).not.toContain('secret-token-value');
    expect(result.content).not.toContain('sk-secret-key-value');
    expect(result.content).not.toContain('sk-ant-secret-value');
  });
});
