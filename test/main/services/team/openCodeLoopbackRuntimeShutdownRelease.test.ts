import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const diagnostic = vi.hoisted(() => vi.fn());
const teamsBasePath = vi.hoisted(() => ({ value: '' }));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    diagnostic,
  }),
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => teamsBasePath.value,
}));

const { releaseLoopbackRuntimesOnAppShutdown } =
  await import('@main/services/team/opencode/bridge/OpenCodeLoopbackRuntimeRelease');

const tempDirs: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A teams directory with one team per entry, each naming the models its members
 * were configured to run on - the same `config.json` the stop path reads.
 */
function givenTeams(teams: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-shutdown-release-'));
  tempDirs.push(root);
  for (const [teamName, models] of Object.entries(teams)) {
    const dir = path.join(root, teamName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ members: models.map((model) => ({ model })) })
    );
  }
  teamsBasePath.value = root;
  return root;
}

/**
 * A loopback provider in the user's opencode config, so the release has an
 * origin it is allowed to contact at all.
 */
function givenLoopbackProvider(providerId: string, origin: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-shutdown-home-'));
  tempDirs.push(home);
  const configDir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'opencode.json'),
    JSON.stringify({ provider: { [providerId]: { options: { baseURL: origin } } } })
  );
  return home;
}

describe('releasing loopback runtimes when the app exits', () => {
  /**
   * The reservation this app is entitled to stand down is the one it made. A
   * loopback runtime is a shared machine service: the same Ollama may be holding
   * a model for the user's own chat window right now, and "Agent Teams is
   * closing" says nothing about that.
   */
  it('does not unload models based on historical team configurations', async () => {
    givenTeams({ alpha: ['ollama/qwen3'], beta: ['ollama/qwen3', 'anthropic/claude'] });
    const homeDir = givenLoopbackProvider('ollama', 'http://127.0.0.1:11434');
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

    const evicted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { body?: string }) => {
        if (url.endsWith('/api/models/unload')) {
          return Promise.resolve({ ok: false, status: 404 } as Response);
        }
        if (url.endsWith('/api/ps')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                models: [{ model: 'qwen3' }, { model: 'llama-the-user-is-using' }],
              }),
          } as unknown as Response);
        }
        evicted.push((JSON.parse(init?.body ?? '{}') as { model: string }).model);
        return Promise.resolve({ ok: true, status: 200 } as Response);
      })
    );

    await releaseLoopbackRuntimesOnAppShutdown();

    expect(evicted).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(evicted).not.toContain('llama-the-user-is-using');
    vi.unstubAllGlobals();
  });

  /**
   * An empty filter means "nothing here is attributable to this app", which is
   * the opposite of the absent filter that means "no filter at all". Reading the
   * first as the second is what evicted a stranger's models.
   */
  it('contacts nothing when no team claims a model', async () => {
    givenTeams({});
    const homeDir = givenLoopbackProvider('ollama', 'http://127.0.0.1:11434');
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await releaseLoopbackRuntimesOnAppShutdown();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining('reason=no_launch_owned_runtime_evidence')
    );
    vi.unstubAllGlobals();
  });

  /** An unreadable teams directory attributes nothing, so it releases nothing. */
  it('contacts nothing when the teams directory cannot be read', async () => {
    teamsBasePath.value = path.join(os.tmpdir(), 'agent-teams-does-not-exist-at-all');
    const homeDir = givenLoopbackProvider('ollama', 'http://127.0.0.1:11434');
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await releaseLoopbackRuntimesOnAppShutdown();

    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  /**
   * A provider this app never ran a member on is serving somebody else and must
   * not hear from this shutdown at all.
   */
  it('leaves a configured provider alone when no member ran on it', async () => {
    givenTeams({ alpha: ['ollama/qwen3'] });
    const homeDir = givenLoopbackProvider('lmstudio', 'http://127.0.0.1:1234');
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await releaseLoopbackRuntimesOnAppShutdown();

    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
