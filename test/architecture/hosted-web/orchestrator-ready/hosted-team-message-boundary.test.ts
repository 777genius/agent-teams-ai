import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const OWNED_PATHS = Object.freeze([
  'src/features/team-message-delivery/contracts/hosted.ts',
  'src/features/team-message-delivery/core/application/ports/HostedTeamMessagePorts.ts',
  'src/features/team-message-delivery/core/application/use-cases/GetHostedMessagePage.ts',
  'src/features/team-message-delivery/core/application/use-cases/SendHostedTeamMessage.ts',
  'src/features/team-message-delivery/core/domain/hostedMessagePolicy.ts',
  'src/features/team-message-delivery/main/adapters/input/http/hostedTeamMessageRoutes.ts',
  'src/features/team-message-delivery/main/adapters/input/http/registerHostedTeamMessageHttp.ts',
  'src/features/team-message-delivery/main/adapters/output/HostedTeamMessageAuthorityAdapter.ts',
  'src/features/team-message-delivery/main/composition/createHostedTeamMessageFeature.ts',
  'src/features/team-message-delivery/main/composition/createHostedTeamMessageOutputAdapters.ts',
  'src/features/team-message-delivery/main/hosted.ts',
  'src/features/team-message-delivery/main/ports/HostedTeamMessageAuthorityPort.ts',
  'src/features/team-message-delivery/renderer/components/HostedTeamMessagePanel.tsx',
  'src/features/team-message-delivery/renderer/composition/createHostedTeamMessageTransport.ts',
  'src/features/team-message-delivery/renderer/ports/HostedTeamMessageRendererPorts.ts',
  'test/architecture/hosted-web/orchestrator-ready/hosted-team-message-boundary.test.ts',
  'test/features/team-message-delivery/GetHostedMessagePage.test.ts',
  'test/features/team-message-delivery/HostedMessagePolicy.test.ts',
  'test/features/team-message-delivery/HostedTeamMessageAuthorityAdapter.test.ts',
  'test/features/team-message-delivery/HostedTeamMessageOutputAdapters.test.ts',
  'test/features/team-message-delivery/HostedTeamMessageRenderer.test.tsx',
  'test/features/team-message-delivery/registerHostedTeamMessageHttp.test.ts',
  'test/features/team-message-delivery/SendHostedTeamMessage.test.ts',
]);

const CORE_PATHS = OWNED_PATHS.filter(
  (path) =>
    path.startsWith('src/') &&
    (path.includes('/contracts/') ||
      path.includes('/core/application/') ||
      path.includes('/core/domain/'))
);

function read(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository-owned path list
  return readFileSync(path, 'utf8');
}

function stagedPatchPaths(): readonly string[] {
  // eslint-disable-next-line security/detect-child-process -- fixed read-only Git command validates the staged admission boundary.
  const output = execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return Object.freeze(output.split('\n').filter(Boolean).sort());
}

describe('hosted team-message boundary', () => {
  it('keeps the admitted browser implementation to the exact twenty-three-path boundary', () => {
    expect(OWNED_PATHS).toHaveLength(23);
    expect(new Set(OWNED_PATHS).size).toBe(23);
    expect(OWNED_PATHS).not.toContain('src/features/team-message-delivery/renderer/index.ts');
    expect(OWNED_PATHS.every(existsSync)).toBe(true);
    const patchPaths = stagedPatchPaths();
    if (patchPaths.length > 0) {
      expect(patchPaths).toEqual([...OWNED_PATHS].sort());
    }
    expect(
      OWNED_PATHS.every(
        (path) =>
          path.startsWith('src/features/team-message-delivery/') ||
          path.startsWith('test/features/team-message-delivery/') ||
          path ===
            'test/architecture/hosted-web/orchestrator-ready/hosted-team-message-boundary.test.ts'
      )
    ).toBe(true);
  });

  it('keeps contracts and core browser-safe, provider-neutral, and independent of legacy owners', () => {
    const source = CORE_PATHS.map(read).join('\n');
    expect(source).not.toMatch(
      /(?:from\s+['"](?:node:|fastify|electron|@main\/|@renderer\/|@preload\/)|\brequire\s*\()/
    );
    expect(source).not.toMatch(
      /\b(?:TeamDataService|Recovery|Lifecycle|ChildProcess|FileSystem|Terminal)\b/
    );
    expect(source).not.toContain('window.electronAPI');
  });

  it('uses opaque IDs and exposes only a bounded plain-text send command', () => {
    const contract = read('src/features/team-message-delivery/contracts/hosted.ts');
    const policy = read('src/features/team-message-delivery/core/domain/hostedMessagePolicy.ts');
    expect(contract).toContain('type HostedMessageId');
    expect(contract).toContain('type HostedClientMessageId');
    expect(contract).not.toMatch(
      /\b(?:teamName|projectPath|providerId|sessionId|runtimeId|runId|filesystemPath|authToken|environment|rawError)\b/
    );
    expect(policy).toContain('HOSTED_MESSAGE_MAX_TEXT_LENGTH');
    expect(policy).toContain('hasExactKeys(value, SEND_COMMAND_KEYS)');
    expect(policy).not.toMatch(/\b(?:recipient|authorId|attachments|replyTo)\b/);
  });

  it('binds pagination to source generation and never sorts cursor candidates independently', () => {
    const contract = read('src/features/team-message-delivery/contracts/hosted.ts');
    const ports = read(
      'src/features/team-message-delivery/core/application/ports/HostedTeamMessagePorts.ts'
    );
    const useCase = read(
      'src/features/team-message-delivery/core/application/use-cases/GetHostedMessagePage.ts'
    );
    expect(contract).toContain('readonly expectedSourceGeneration');
    expect(ports).toContain('compare its generation before reading candidates');
    expect(useCase).toContain('normalizeCandidates');
    expect(useCase).not.toContain('.sort(');
    expect(useCase).toContain("kind: 'stale_generation'");
  });

  it('keeps durable admission distinct from runtime delivery and freezes ambiguity as operator-required', () => {
    const ports = read(
      'src/features/team-message-delivery/core/application/ports/HostedTeamMessagePorts.ts'
    );
    const useCase = read(
      'src/features/team-message-delivery/core/application/use-cases/SendHostedTeamMessage.ts'
    );
    expect(ports.match(/\bpersist\s*\(/g)).toHaveLength(1);
    expect(ports.match(/\bdeliver\s*\(/g)).toHaveLength(1);
    expect(ports).toContain('must not be sent again automatically');
    expect(useCase.indexOf('.persist(')).toBeLessThan(useCase.indexOf('.deliver('));
    expect(useCase).toContain("'operator_required'");
    expect(useCase).toContain(
      "admitted.kind === 'idempotent_replay' ? 'operator_required' : 'pending'"
    );
  });

  it('publishes only two browser routes and no runtime, lifecycle, or terminal route', () => {
    const contract = read('src/features/team-message-delivery/contracts/hosted.ts');
    const routes = read(
      'src/features/team-message-delivery/main/adapters/input/http/hostedTeamMessageRoutes.ts'
    );
    const transport = read(
      'src/features/team-message-delivery/renderer/composition/createHostedTeamMessageTransport.ts'
    );
    expect(routes.match(/trustKind: 'browser'/g)).toHaveLength(2);
    expect(contract).toContain('/api/hosted/v1/team-messages/page');
    expect(contract).toContain('/api/hosted/v1/team-messages/send');
    expect(routes).toContain('HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH');
    expect(routes).toContain('HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH');
    expect(transport).toContain('HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH');
    expect(transport).toContain('HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH');
    expect(routes).not.toContain('/api/hosted/v1/team-messages/page');
    expect(routes).not.toContain('/api/hosted/v1/team-messages/send');
    expect(transport).not.toContain('/api/hosted/v1/team-messages/page');
    expect(transport).not.toContain('/api/hosted/v1/team-messages/send');
    expect(routes).not.toMatch(/\/runtime|\/lifecycle|\/terminal|:teamName/);
  });

  it('uses a same-instance narrow authority adapter and leaves legacy entrypoints untouched', () => {
    const port = read(
      'src/features/team-message-delivery/main/ports/HostedTeamMessageAuthorityPort.ts'
    );
    const adapter = read(
      'src/features/team-message-delivery/main/adapters/output/HostedTeamMessageAuthorityAdapter.ts'
    );
    const composition = read(
      'src/features/team-message-delivery/main/composition/createHostedTeamMessageOutputAdapters.ts'
    );
    const hosted = read('src/features/team-message-delivery/main/hosted.ts');
    const desktop = read('src/features/team-message-delivery/main/index.ts');
    const standalone = read('src/main/standalone.ts');

    expect(
      port.match(/\b(?:readWindow|persistMessage|deliverPersistedMessage)\s*\(/g)
    ).toHaveLength(3);
    expect(port).not.toMatch(/\b(?:writeFile|readFile|spawn|startRuntime|stopRuntime)\s*\(/);
    expect(adapter).toContain('implements');
    expect(adapter).toContain('cursorForMessage');
    expect(composition).toMatch(
      /pageSource\s*:\s*adapter,\s*persistence\s*:\s*adapter,\s*runtimeDelivery\s*:\s*adapter/
    );
    expect(hosted).toContain('HostedTeamMessageAuthorityPort');
    expect(desktop).not.toContain('HostedTeamMessageAuthority');
    expect(standalone).not.toContain('HostedTeamMessageAuthorityAdapter');
  });

  it('makes the renderer browser-only and race-fences stale request generations', () => {
    const renderer = read(
      'src/features/team-message-delivery/renderer/components/HostedTeamMessagePanel.tsx'
    );
    const transport = read(
      'src/features/team-message-delivery/renderer/composition/createHostedTeamMessageTransport.ts'
    );
    expect(renderer).toContain('pageEpoch');
    expect(renderer).toContain('sendEpoch');
    expect(renderer).toContain('pendingRetry');
    expect(renderer).not.toContain('window.electronAPI');
    expect(transport).not.toMatch(/(?:electron|ipcRenderer|TeamDataService|provider)/i);
  });
});
