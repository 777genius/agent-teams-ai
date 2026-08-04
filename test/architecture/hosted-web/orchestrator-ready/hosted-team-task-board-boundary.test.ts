import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const OWNED_PATHS = Object.freeze([
  'src/features/team-task-board/contracts/hosted.ts',
  'src/features/team-task-board/core/application/ports/HostedTeamTaskBoardPorts.ts',
  'src/features/team-task-board/core/application/use-cases/GetHostedTaskBoardPage.ts',
  'src/features/team-task-board/core/application/use-cases/ExecuteHostedTaskMutation.ts',
  'src/features/team-task-board/core/domain/models/HostedTaskBoardBudget.ts',
  'src/features/team-task-board/core/domain/policies/hostedTaskBoardPolicy.ts',
  'src/features/team-task-board/main/adapters/input/http/hostedTaskBoardRoutes.ts',
  'src/features/team-task-board/main/adapters/input/http/registerHostedTeamTaskBoardHttp.ts',
  'src/features/team-task-board/main/composition/createHostedTeamTaskBoardFeature.ts',
  'src/features/team-task-board/main/hosted.ts',
  'test/features/team-task-board/HostedTaskBoardBudget.test.ts',
  'test/features/team-task-board/HostedTaskBoardPolicy.test.ts',
  'test/features/team-task-board/GetHostedTaskBoardPage.test.ts',
  'test/features/team-task-board/ExecuteHostedTaskMutation.test.ts',
  'test/features/team-task-board/registerHostedTeamTaskBoardHttp.test.ts',
  'test/architecture/hosted-web/orchestrator-ready/hosted-team-task-board-boundary.test.ts',
]);

const AUTHORITY_ADAPTER_OWNED_PATHS = Object.freeze([
  'src/features/team-task-board/main/ports/HostedTaskBoardAuthorityPort.ts',
  'src/features/team-task-board/main/adapters/output/HostedTaskBoardAuthorityAdapter.ts',
  'src/features/team-task-board/main/composition/createHostedTeamTaskBoardOutputAdapters.ts',
  'src/features/team-task-board/main/hosted.ts',
  'test/features/team-task-board/HostedTaskBoardAuthorityAdapter.test.ts',
  'test/features/team-task-board/createHostedTeamTaskBoardOutputAdapters.test.ts',
  'test/architecture/hosted-web/orchestrator-ready/hosted-team-task-board-boundary.test.ts',
]);

const CORE_PATHS = OWNED_PATHS.filter(
  (path) =>
    path.includes('/contracts/') ||
    path.includes('/core/application/') ||
    path.includes('/core/domain/')
).filter((path) => path.startsWith('src/'));

function read(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are fixed above
  return readFileSync(path, 'utf8');
}

describe('hosted team task-board boundary', () => {
  it('keeps the admitted implementation to exactly sixteen new feature-local paths', () => {
    expect(OWNED_PATHS).toHaveLength(16);
    expect(new Set(OWNED_PATHS).size).toBe(16);
    expect(OWNED_PATHS.every(existsSync)).toBe(true);
    expect(
      OWNED_PATHS.every(
        (path) =>
          path.startsWith('src/features/team-task-board/') ||
          path.startsWith('test/features/team-task-board/') ||
          path ===
            'test/architecture/hosted-web/orchestrator-ready/hosted-team-task-board-boundary.test.ts'
      )
    ).toBe(true);
  });

  it('keeps contracts and core browser-safe and independent of writers and runtime owners', () => {
    const source = CORE_PATHS.map(read).join('\n');
    expect(source).not.toMatch(
      /(?:from\s+['"](?:node:|fastify|electron|@main\/|@renderer\/|@preload\/)|\brequire\s*\()/
    );
    expect(source).not.toMatch(
      /\b(?:TeamDataService|TeamKanbanManager|Recovery|Lifecycle|ChildProcess|FileSystem|Terminal)\b/
    );
    expect(source).not.toContain('window.electronAPI');
  });

  it('exposes only opaque hosted identities and structurally excludes private authority fields', () => {
    const contract = read('src/features/team-task-board/contracts/hosted.ts');
    expect(contract).toContain('type TaskId');
    expect(contract).toContain('type TeamId');
    expect(contract).not.toMatch(
      /\b(?:teamName|projectPath|providerId|sessionId|runtimeId|runId|filesystemPath|authToken|environment|rawError)\b/
    );
    expect(contract).not.toMatch(/\b(?:Error|unknown)\s*;/);
  });

  it('has one narrow mutation admission call and no direct mutation adapter', () => {
    const port = read(
      'src/features/team-task-board/core/application/ports/HostedTeamTaskBoardPorts.ts'
    );
    const useCase = read(
      'src/features/team-task-board/core/application/use-cases/ExecuteHostedTaskMutation.ts'
    );
    expect(port.match(/\badmit\s*\(/g)).toHaveLength(1);
    expect(useCase.match(/\.admit\s*\(/g)).toHaveLength(1);
    expect(port).not.toMatch(/\b(?:write|save|recover|spawn|startRuntime|stopRuntime)\s*\(/);
  });

  it('binds continuations and mutations to generation without separating opaque cursor order', () => {
    const contract = read('src/features/team-task-board/contracts/hosted.ts');
    const port = read(
      'src/features/team-task-board/core/application/ports/HostedTeamTaskBoardPorts.ts'
    );
    const pageUseCase = read(
      'src/features/team-task-board/core/application/use-cases/GetHostedTaskBoardPage.ts'
    );
    const mutationUseCase = read(
      'src/features/team-task-board/core/application/use-cases/ExecuteHostedTaskMutation.ts'
    );
    expect(contract.match(/\bexpectedSourceGeneration\b/g)?.length).toBeGreaterThanOrEqual(2);
    expect(port).toContain('return `stale_generation` before reading candidates');
    expect(port).toContain('revision ABA');
    expect(pageUseCase).not.toContain('compareHostedTaskBoardItems');
    expect(pageUseCase).toContain('normalizeHostedTaskBoardItems');
    expect(pageUseCase).toContain("kind: 'stale_generation'");
    expect(mutationUseCase).toContain("case 'stale_generation'");
  });

  it('keeps route registration feature-local and absent from desktop entrypoints/composition', () => {
    const registration = read(
      'src/features/team-task-board/main/adapters/input/http/registerHostedTeamTaskBoardHttp.ts'
    );
    expect(registration.match(/\bapp\.post</g)).toHaveLength(1);
    expect(registration).toContain('/hostedTaskBoardRoutes');

    for (const desktopPath of [
      'src/features/team-task-board/index.ts',
      'src/features/team-task-board/contracts/index.ts',
      'src/features/team-task-board/main/index.ts',
      'src/features/team-task-board/main/composition/createTeamTaskBoardFeature.ts',
      'src/features/team-task-board/main/adapters/input/ipc/registerTeamTaskBoardIpc.ts',
    ]) {
      const desktopSource = read(desktopPath);
      expect(desktopSource).not.toContain('HostedTeamTaskBoard');
      expect(desktopSource).not.toMatch(/(?:\.\/|\.\.\/)hosted/);
    }
  });

  it('publishes only browser routes and no runtime, lifecycle, or terminal route', () => {
    const routes = read(
      'src/features/team-task-board/main/adapters/input/http/hostedTaskBoardRoutes.ts'
    );
    expect(routes.match(/trustKind: 'browser'/g)).toHaveLength(1);
    expect(routes).toContain('/api/hosted/v1/team-task-board/page');
    expect(routes).not.toContain('path: HOSTED_TASK_BOARD_MUTATION_ROUTE');
    expect(routes).not.toMatch(/\/runtime|\/lifecycle|\/terminal|:teamName/);
  });

  it('keeps the production authority adapter to exactly seven admitted paths', () => {
    expect(AUTHORITY_ADAPTER_OWNED_PATHS).toHaveLength(7);
    expect(new Set(AUTHORITY_ADAPTER_OWNED_PATHS).size).toBe(7);
    expect(AUTHORITY_ADAPTER_OWNED_PATHS.every(existsSync)).toBe(true);
  });

  it('uses one narrow read authority and one same-instance output composition', () => {
    const port = read('src/features/team-task-board/main/ports/HostedTaskBoardAuthorityPort.ts');
    const adapter = read(
      'src/features/team-task-board/main/adapters/output/HostedTaskBoardAuthorityAdapter.ts'
    );
    const composition = read(
      'src/features/team-task-board/main/composition/createHostedTeamTaskBoardOutputAdapters.ts'
    );

    expect(port.match(/\breadWindow\s*\(/g)).toHaveLength(1);
    expect(port).not.toContain('compareAndCommit');
    expect(port).not.toContain('idempotency');
    expect(adapter).toContain('implements HostedTaskBoardPageSourcePort');
    expect(adapter).toContain('cursor_${taskId}');
    expect(adapter).toContain("truncatedBy: truncatedByByteBudget ? 'byte_budget' : truncatedBy");
    expect(composition).toContain('pageSource: adapter');
    expect(composition).not.toContain('mutationAdmission');
  });

  it('keeps the authority adapter main-only, transport-neutral, and absent from standalone', () => {
    const sources = AUTHORITY_ADAPTER_OWNED_PATHS.filter((path) => path.startsWith('src/'))
      .map(read)
      .join('\n');
    const hostedEntry = read('src/features/team-task-board/main/hosted.ts');
    const desktopEntry = read('src/features/team-task-board/main/index.ts');
    const rootEntry = read('src/features/team-task-board/index.ts');
    const standalone = read('src/main/standalone.ts');

    expect(sources).not.toMatch(
      /(?:from\s+['"](?:node:fs|electron|@main\/services)|\bTeamDataService\b|\bTeamsAPI\b|\bServiceHost\b|\bas\s+(?:unknown|any)\s+as\b)/
    );
    expect(sources).not.toMatch(/\b(?:readFile|writeFile|readdir|mkdir|fakeAuthority)\b/i);
    expect(hostedEntry).toContain('HostedTaskBoardAuthorityPort');
    expect(hostedEntry).toContain('createHostedTeamTaskBoardOutputAdapters');
    expect(desktopEntry).not.toContain('HostedTaskBoardAuthority');
    expect(rootEntry).not.toContain('HostedTaskBoardAuthority');
    expect(standalone).not.toContain('createHostedTeamTaskBoardOutputAdapters');
    expect(standalone).not.toContain('HostedTaskBoardAuthorityAdapter');
  });
});
