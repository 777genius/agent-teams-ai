import { describe, expect, it } from 'vitest';

import { mergeJsonSettingsArgs } from '../../../../src/main/services/runtime/cliSettingsArgs';

function getSettingsValues(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--settings' && typeof args[i + 1] === 'string') {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

describe('mergeJsonSettingsArgs', () => {
  it('merges app and provider JSON settings into a single settings argument', () => {
    const merged = mergeJsonSettingsArgs([
      '--settings',
      '{"fastMode":false}',
      '--model',
      'gpt-5.4',
      '--settings',
      '{"codex":{"forced_login_method":"chatgpt"}}',
    ]);

    expect(merged).toEqual([
      '--settings',
      '{"fastMode":false,"codex":{"forced_login_method":"chatgpt"}}',
      '--model',
      'gpt-5.4',
    ]);
  });

  it('deep merges nested JSON settings and lets later values win', () => {
    const merged = mergeJsonSettingsArgs([
      '--settings',
      '{"codex":{"forced_login_method":"api","existing":true}}',
      '--settings',
      '{"codex":{"forced_login_method":"chatgpt"}}',
    ]);

    expect(JSON.parse(getSettingsValues(merged)[0] ?? '{}')).toEqual({
      codex: {
        forced_login_method: 'chatgpt',
        existing: true,
      },
    });
  });

  it('preserves non-JSON settings values while merging JSON settings', () => {
    const merged = mergeJsonSettingsArgs([
      '--settings',
      '/tmp/settings.json',
      '--settings={"fastMode":false}',
      '--settings',
      '{"codex":{"forced_login_method":"chatgpt"}}',
    ]);

    expect(merged).toEqual([
      '--settings',
      '/tmp/settings.json',
      '--settings',
      '{"fastMode":false,"codex":{"forced_login_method":"chatgpt"}}',
    ]);
  });

  it('preserves multiple hook entries for the same hook event', () => {
    const merged = mergeJsonSettingsArgs([
      '--settings',
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: '/bin/sh user-stop.sh' }],
            },
          ],
        },
      }),
      '--settings',
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: '/bin/sh app-stop.sh' }],
            },
          ],
        },
      }),
    ]);

    expect(JSON.parse(getSettingsValues(merged)[0] ?? '{}')).toEqual({
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: '/bin/sh user-stop.sh' }],
          },
          {
            matcher: '',
            hooks: [{ type: 'command', command: '/bin/sh app-stop.sh' }],
          },
        ],
      },
    });
  });

  it('dedupes identical hook entries while preserving unrelated array replacement semantics', () => {
    const appHook = {
      matcher: '',
      hooks: [{ type: 'command', command: '/bin/sh app-stop.sh' }],
    };

    const merged = mergeJsonSettingsArgs([
      '--settings',
      JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: { Stop: [appHook] },
      }),
      '--settings',
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: { Stop: [appHook] },
      }),
    ]);

    expect(JSON.parse(getSettingsValues(merged)[0] ?? '{}')).toEqual({
      permissions: { allow: ['Bash'] },
      hooks: { Stop: [appHook] },
    });
  });

  it('merges config override arrays in order', () => {
    const merged = mergeJsonSettingsArgs([
      '--settings',
      JSON.stringify({
        codex: {
          agent_teams_launch_config: {
            config_overrides: ['service_tier="flex"'],
          },
        },
      }),
      '--settings',
      JSON.stringify({
        codex: {
          agent_teams_launch_config: {
            config_overrides: ['service_tier="fast"', 'features.fast_mode=true'],
          },
        },
      }),
    ]);

    expect(JSON.parse(getSettingsValues(merged)[0] ?? '{}')).toEqual({
      codex: {
        agent_teams_launch_config: {
          config_overrides: [
            'service_tier="flex"',
            'service_tier="fast"',
            'features.fast_mode=true',
          ],
        },
      },
    });
  });
});
