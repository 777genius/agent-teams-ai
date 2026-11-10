import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectPathResolver } from '../../../../src/main/services/discovery/ProjectPathResolver';

function createSessionLine(cwd: string): string {
  return JSON.stringify({
    uuid: 'test-uuid',
    type: 'user',
    cwd,
    message: { role: 'user', content: 'hello' },
    timestamp: new Date().toISOString(),
  });
}

describe('ProjectPathResolver', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    // Allow Windows file handles from readline/streams to be released
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const tempDir of tempDirs) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Ignore cleanup failures to prevent cascading test errors on Windows
      }
    }
    tempDirs.length = 0;
  });

  it('prefers absolute cwd hint', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-projects-'));
    tempDirs.push(projectsDir);

    const resolver = new ProjectPathResolver(projectsDir);
    const resolved = await resolver.resolveProjectPath('-Users-test-proj', {
      cwdHint: '/Users/test/proj',
    });

    expect(resolved).toBe('/Users/test/proj');
  });

  it('extracts cwd from session file when available', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-projects-'));
    tempDirs.push(projectsDir);

    const projectId = '-Users-test-my-repo';
    const projectDir = path.join(projectsDir, projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionPath = path.join(projectDir, 'session-1.jsonl');
    fs.writeFileSync(sessionPath, `${createSessionLine('/Users/test/my-repo')}\n`, 'utf8');

    const resolver = new ProjectPathResolver(projectsDir);
    const resolved = await resolver.resolveProjectPath(projectId);

    expect(resolved).toBe('/Users/test/my-repo');
  });

  it('falls back to decoded project ID when no cwd is available', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-projects-'));
    tempDirs.push(projectsDir);

    const resolver = new ProjectPathResolver(projectsDir);
    const resolved = await resolver.resolveProjectPath('-C:-Users-test-my-repo');

    expect(resolved).toBe('C:/Users/test/my/repo');
  });

  it('invalidates cached paths by project', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-projects-'));
    tempDirs.push(projectsDir);

    const projectId = '-Users-test-my-repo';
    const projectDir = path.join(projectsDir, projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionPath = path.join(projectDir, 'session-1.jsonl');
    fs.writeFileSync(sessionPath, `${createSessionLine('/Users/test/my-repo-v1')}\n`, 'utf8');

    const resolver = new ProjectPathResolver(projectsDir);
    const firstResolved = await resolver.resolveProjectPath(projectId);
    expect(firstResolved).toBe('/Users/test/my-repo-v1');

    fs.writeFileSync(sessionPath, `${createSessionLine('/Users/test/my-repo-v2')}\n`, 'utf8');
    resolver.invalidateProject(projectId);

    const secondResolved = await resolver.resolveProjectPath(projectId);
    expect(secondResolved).toBe('/Users/test/my-repo-v2');
  });
});
