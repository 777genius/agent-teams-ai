import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';
import { SessionSearcher } from '../../../../src/main/services/discovery/SessionSearcher';
import { subprojectRegistry } from '../../../../src/main/services/discovery/SubprojectRegistry';
import { SessionParser } from '../../../../src/main/services/parsing/SessionParser';
import { encodePathPortable } from '../../../../src/main/utils/pathDecoder';

function createSessionLine(opts: { cwd?: string; type?: string }): string {
  return JSON.stringify({
    uuid: 'test-uuid',
    type: opts.type ?? 'user',
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    message: { role: 'user', content: 'hello' },
    timestamp: new Date().toISOString(),
  });
}

describe('ProjectScanner cwd split logic', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    subprojectRegistry.clear();
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Ignore cleanup failures
      }
    }
    tempDirs.length = 0;
  });

  it('does not split when sessions have a single cwd mixed with sessions without cwd', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-'));
    tempDirs.push(projectsDir);

    // Create a project directory with encoded name
    const encodedName = '-Users-test-myproject';
    const projectDir = path.join(projectsDir, encodedName);
    fs.mkdirSync(projectDir);

    // Session WITH cwd
    fs.writeFileSync(
      path.join(projectDir, 'session-with-cwd.jsonl'),
      createSessionLine({ cwd: '/Users/test/myproject' }) + '\n'
    );

    // Session WITHOUT cwd (older format)
    fs.writeFileSync(
      path.join(projectDir, 'session-no-cwd.jsonl'),
      createSessionLine({ type: 'system' }) + '\n' + createSessionLine({ type: 'user' }) + '\n'
    );

    const scanner = new ProjectScanner(projectsDir);
    const projects = await scanner.scan();

    // Should produce 1 project, not 2 subprojects
    const myProjects = projects.filter((p) => p.id.includes('myproject'));
    expect(myProjects).toHaveLength(1);

    // Should use the plain encoded name, not a composite ID
    expect(myProjects[0].id).toBe(encodedName);

    // Should include both sessions
    expect(myProjects[0].sessions).toHaveLength(2);
  });

  it('splits when sessions have multiple distinct cwds', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-'));
    tempDirs.push(projectsDir);

    const encodedName = '-Users-test-myproject';
    const projectDir = path.join(projectsDir, encodedName);
    fs.mkdirSync(projectDir);

    // Session with cwd A
    fs.writeFileSync(
      path.join(projectDir, 'session-a.jsonl'),
      createSessionLine({ cwd: '/Users/test/myproject' }) + '\n'
    );

    // Session with cwd B (different)
    fs.writeFileSync(
      path.join(projectDir, 'session-b.jsonl'),
      createSessionLine({ cwd: '/Users/test/other-project' }) + '\n'
    );

    const scanner = new ProjectScanner(projectsDir);
    const projects = await scanner.scan();

    // Should produce 2 subprojects with composite IDs
    const myProjects = projects.filter((p) => p.id.includes('myproject'));
    expect(myProjects).toHaveLength(2);

    // Both should be composite IDs
    for (const proj of myProjects) {
      expect(proj.id).toContain('::');
    }
  });

  it('finds sessions stored with the orchestrator Windows project codec', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-'));
    tempDirs.push(projectsDir);

    const projectPath = 'C:\\Users\\User\\PROJECT_IT\\сlaude_team';
    const uiEncodedName = 'C--Users-User-PROJECT_IT-сlaude_team';
    const orchestratorEncodedName = encodePathPortable(projectPath);
    const projectDir = path.join(projectsDir, orchestratorEncodedName);
    fs.mkdirSync(projectDir);

    const sessionPath = path.join(projectDir, 'session-orchestrator.jsonl');
    fs.writeFileSync(sessionPath, createSessionLine({ cwd: projectPath }) + '\n');

    const scanner = new ProjectScanner(projectsDir);
    await expect(scanner.listSessionFiles(uiEncodedName)).resolves.toEqual([sessionPath]);
    await expect(scanner.listSessions(uiEncodedName)).resolves.toHaveLength(1);
    await expect(scanner.getSession(uiEncodedName, 'session-orchestrator')).resolves.toMatchObject({
      id: 'session-orchestrator',
      projectId: uiEncodedName,
    });

    const parser = new SessionParser(scanner);
    const parsed = await parser.parseSession(uiEncodedName, 'session-orchestrator');
    expect(parsed.messages).toHaveLength(1);

    const searcher = new SessionSearcher(projectsDir);
    const searchResult = await searcher.searchSessions(uiEncodedName, 'hello', 10);
    expect(searchResult.totalMatches).toBe(1);
  });

  it('detects Windows forward-slash worktree paths', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-'));
    tempDirs.push(projectsDir);

    const encodedName = 'c--users-test--claude-worktrees-myrepo-feature';
    const projectDir = path.join(projectsDir, encodedName);
    fs.mkdirSync(projectDir);

    fs.writeFileSync(
      path.join(projectDir, 'session-worktree.jsonl'),
      createSessionLine({ cwd: 'C:/Users/test/.claude-worktrees/myrepo/feature' }) + '\n'
    );

    const scanner = new ProjectScanner(projectsDir);
    const groups = await scanner.scanWithWorktreeGrouping();
    const worktree = groups.find((group) => group.id === encodedName)?.worktrees[0];

    expect(worktree?.isMainWorktree).toBe(false);
    expect(worktree?.source).toBe('claude-desktop');
  });
});
