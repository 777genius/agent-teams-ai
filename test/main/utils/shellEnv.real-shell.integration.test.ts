// @vitest-environment node
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  clearShellEnvCache,
  getCachedShellEnv,
  resolveInteractiveShellEnv,
} from '@main/utils/shellEnv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function exportEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}=${quoteShell(value)}`)
    .join('\n');
}

const shells = [
  {
    name: 'bash',
    executable: '/bin/bash',
    login: '.bash_profile',
    rc: '.bashrc',
    logout: '.bash_logout',
  },
  { name: 'zsh', executable: '/bin/zsh', login: '.zprofile', rc: '.zshrc', logout: '.zlogout' },
] as const;

// macOS promises both standard shells. Linux images may omit zsh; Windows has
// its own no-spawn resolver contract and must not silently count as shell proof.
describe.skipIf(process.platform === 'win32')('shellEnv actual installed shells', () => {
  for (const shell of shells) {
    describe.skipIf(process.platform !== 'darwin' && !isExecutable(shell.executable))(
      shell.name,
      () => {
        let sandbox = '';
        let home = '';

        beforeEach(async () => {
          expect(isExecutable(shell.executable), `Required shell ${shell.executable}`).toBe(true);
          clearShellEnvCache();
          sandbox = await mkdtemp(path.join(os.tmpdir(), 'TEST-real-shell-env-'));
          home = path.join(sandbox, 'home space λ');
          await mkdir(home);
          vi.stubEnv('HOME', home);
          vi.stubEnv('USERPROFILE', home);
          vi.stubEnv('ZDOTDIR', home);
          vi.stubEnv('SHELL', shell.executable);
          vi.stubEnv('PATH', '/usr/bin:/bin');
          for (const key of [
            'ANTHROPIC_BASE_URL',
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_MODEL',
            'ANTHROPIC_SMALL_FAST_MODEL',
          ]) {
            vi.stubEnv(key, undefined);
          }
          vi.stubEnv('ANTHROPIC_MODEL', 'TEST-parent-model');
        });

        afterEach(async () => {
          clearShellEnvCache();
          vi.unstubAllEnvs();
          if (sandbox) await rm(sandbox, { recursive: true, force: true });
        });

        async function installStartup(login: string, rc: string, logout = ''): Promise<void> {
          await writeFile(
            path.join(home, shell.login),
            `${login}\n${shell.name === 'bash' ? '. "$HOME/.bashrc"\n' : ''}`
          );
          await writeFile(path.join(home, shell.rc), `${rc}\n`);
          await writeFile(path.join(home, shell.logout), `${logout}\n`);
        }

        async function resolveAndCheck(
          expected: Record<string, string>,
          phases: string[] = ['shell-env-login']
        ): Promise<NodeJS.ProcessEnv> {
          const parentIdentity = process.env;
          const parentBefore = { ...process.env };
          const progress: string[] = [];
          const env = await resolveInteractiveShellEnv({
            source: `real-shell-test:${shell.name}`,
            onProgress: ({ phase }) => progress.push(phase),
          });
          const warningCount = vi.mocked(console.warn).mock.calls.length;
          vi.mocked(console.warn).mockClear();
          // Compare every parent value and absence without exposing inherited
          // credentials in assertion diffs if a regression mutates the parent.
          expect(process.env === parentIdentity).toBe(true);
          expect(
            JSON.stringify(Object.keys(process.env).sort()) ===
              JSON.stringify(Object.keys(parentBefore).sort()) &&
              Object.keys(parentBefore).every((key) => process.env[key] === parentBefore[key])
          ).toBe(true);
          expect(Object.fromEntries(Object.keys(expected).map((key) => [key, env[key]]))).toEqual(
            expected
          );
          expect(warningCount).toBe(0);
          expect(progress).toEqual(phases);
          expect(getCachedShellEnv() === env).toBe(true);
          return env;
        }

        it('reads real login and interactive startup exports with exact edge values', async () => {
          const loginEnv = {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
            ANTHROPIC_MODEL: 'TEST-login-model',
          };
          const rcEnv = {
            ANTHROPIC_AUTH_TOKEN: 'TEST-shell-token',
            ANTHROPIC_SMALL_FAST_MODEL: 'TEST-fast-model',
            REVIEW_EMPTY: '',
            REVIEW_MULTILINE: 'first=value\nsecond=value\n',
            REVIEW_UNICODE: 'λ 漢 👋',
            REVIEW_QUOTES: 'literal \'single\' "double" $HOME `command` \\ slash',
            PATH: `${home}/bin space λ:/usr/bin:/bin`,
          };
          await installStartup(exportEnv(loginEnv), exportEnv(rcEnv));
          await resolveAndCheck({ ...loginEnv, ...rcEnv, HOME: home });
        });

        it('ignores startup banners and accepts a completed dump before a failing real logout', async () => {
          const expected = {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
            ANTHROPIC_AUTH_TOKEN: 'TEST-shell-token',
            ANTHROPIC_MODEL: 'TEST-login-model',
            ANTHROPIC_SMALL_FAST_MODEL: 'TEST-fast-model',
          };
          await installStartup(
            // Bash needs an explicit exit for .bash_logout. A harmless zsh
            // EXIT trap prevents its final-external-command exec optimization
            // from bypassing .zlogout when the marker uses command printf.
            `${shell.name === 'bash' ? "trap 'exit 0' EXIT\n" : "trap ':' EXIT\n"}printf 'PLUGIN_INIT=ready\\nPATH=/wrong/bin\\0'`,
            exportEnv(expected),
            "printf 'logout\\n' >> \"$HOME/logout-called\"\nprintf 'LOGOUT=failed\\n'\nexit 42"
          );
          const env = await resolveAndCheck({ ...expected, HOME: home });
          expect(Object.hasOwn(env, 'PLUGIN_INIT')).toBe(false);
          expect(Object.hasOwn(env, 'LOGOUT')).toBe(false);
          expect(await readFile(path.join(home, 'logout-called'), 'utf8')).toBe('logout\n');
        });

        it('falls back from a failing real login profile to the real interactive rc', async () => {
          const expected = {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
            ANTHROPIC_AUTH_TOKEN: 'TEST-interactive-token',
            ANTHROPIC_MODEL: 'TEST-interactive-model',
            ANTHROPIC_SMALL_FAST_MODEL: 'TEST-interactive-fast',
          };
          await installStartup("printf 'PLUGIN_INIT=failed\\n'\nexit 42", exportEnv(expected));
          await resolveAndCheck({ ...expected, HOME: home }, [
            'shell-env-login',
            'shell-env-interactive',
          ]);
        });

        it.each(['function', 'alias'] as const)(
          'keeps its framing independent of an rc-defined printf %s',
          async (customization) => {
            const customPrintf =
              customization === 'function'
                ? 'printf() { builtin printf "TRACE printf call\\n"; builtin printf "$@"; }'
                : 'alias printf=\'builtin printf "TRACE printf alias\\n"; builtin printf\'';
            const expected = { ANTHROPIC_MODEL: 'TEST-custom-printf-model', HOME: home };
            await installStartup('', `${exportEnv(expected)}\n${customPrintf}`);
            await resolveAndCheck(expected);
          }
        );
      }
    );
  }
});
