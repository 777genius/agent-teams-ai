import {
  INHERITED_HARNESS_ENV_KEYS,
  stripInheritedHarnessEnv,
} from '@main/utils/inheritedHarnessEnv';
import { describe, expect, it } from 'vitest';

describe('stripInheritedHarnessEnv', () => {
  it('drops parent-session identity and secrets but keeps auth, config and app variables', () => {
    const kept = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      CLAUDE_CONFIG_DIR: '/custom/claude',
      ANTHROPIC_API_KEY: 'key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: '/runtime/cli',
      CLAUDE_DEV_RUNTIME_ROOT: '/runtime',
      AGENT_TEAMS_ANY: '1',
      CLAUDE_TEAM_ANY: '1',
    };
    const env: NodeJS.ProcessEnv = { ...kept };
    for (const key of INHERITED_HARNESS_ENV_KEYS) env[key] = 'inherited';

    stripInheritedHarnessEnv(env);

    expect(env).toEqual(kept);
    expect(INHERITED_HARNESS_ENV_KEYS).toContain('CLAUDE_CODE_MESSAGING_TOKEN');
  });
});
