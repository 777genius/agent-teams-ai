import { describe, expect, it } from 'vitest';

import {
  getUnsupportedAgentTeamsOpenCodeVersionMessage,
  isAgentTeamsOpenCodeVersionSupported,
  MINIMUM_AGENT_TEAMS_OPENCODE_VERSION,
} from './version';

describe('Agent Teams OpenCode version compatibility', () => {
  it('accepts the storage-compatible minimum and newer versions', () => {
    expect(MINIMUM_AGENT_TEAMS_OPENCODE_VERSION).toBe('1.16.0');
    expect(isAgentTeamsOpenCodeVersionSupported('opencode 1.16.0')).toBe(true);
    expect(isAgentTeamsOpenCodeVersionSupported('1.18.3')).toBe(true);
  });

  it('rejects old or unparseable runtimes with an actionable update message', () => {
    expect(isAgentTeamsOpenCodeVersionSupported('1.15.6')).toBe(false);
    expect(isAgentTeamsOpenCodeVersionSupported('unknown')).toBe(false);
    expect(getUnsupportedAgentTeamsOpenCodeVersionMessage('1.15.6')).toContain(
      'Update OpenCode before loading providers, models, or launching teammates.'
    );
  });
});
