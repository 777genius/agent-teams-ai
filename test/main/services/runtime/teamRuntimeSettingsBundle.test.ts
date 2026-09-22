// @vitest-environment node
import {
  materializeTeamRuntimeSettingsBundle,
  splitSettingsJsonArgs,
} from '@main/services/runtime/teamRuntimeSettingsBundle';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

describe('teamRuntimeSettingsBundle', () => {
  const tempRoots: string[] = [];

  async function createTempRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'team-runtime-settings-'));
    tempRoots.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('merges app settings and helper settings into one provider settings file', async () => {
    const dir = await createTempRoot();
    const helper = {
      teamName: 'bundle-team',
      directory: dir,
      helperPath: path.join(dir, 'helper.sh'),
      keyPath: path.join(dir, 'key'),
      settingsPath: path.join(dir, 'settings.json'),
      settingsObject: { apiKeyHelper: "'/tmp/helper.sh'" },
      settingsArgs: ['--settings', path.join(dir, 'settings.json')],
      envPatch: {},
    };

    const bundle = await materializeTeamRuntimeSettingsBundle({
      teamName: 'bundle-team',
      providerId: 'anthropic',
      anthropicHelper: helper,
      baseSettings: [
        { fastMode: false },
        {
          env: {
            ANTHROPIC_API_KEY: 'must-not-survive',
            ANTHROPIC_AUTH_TOKEN: 'must-not-survive',
            SAFE_VALUE: 'keep',
          },
        },
        {
          hooks: {
            Stop: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: '/bin/sh app-stop.sh' }],
              },
            ],
          },
        },
      ],
    });

    expect(bundle?.args).toEqual(['--settings', bundle?.settingsPath]);
    const settings = JSON.parse(await readFile(bundle!.settingsPath, 'utf8'));

    expect(settings).toMatchObject({
      fastMode: false,
      apiKeyHelper: "'/tmp/helper.sh'",
      env: { SAFE_VALUE: 'keep' },
    });
    expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('splits equals-style JSON settings without dropping later args', () => {
    expect(
      splitSettingsJsonArgs([
        '--settings={"codex":{"forced_login_method":"chatgpt"}}',
        '--model',
        'gpt-5.5',
      ])
    ).toEqual({
      settingsFragments: [{ codex: { forced_login_method: 'chatgpt' } }],
      passthroughArgs: ['--model', 'gpt-5.5'],
    });
  });
});
