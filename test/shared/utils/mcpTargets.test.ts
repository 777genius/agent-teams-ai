import { getMcpInstallTargetKey, getMcpRuntimeTargetKey } from '@shared/utils/mcpTargets';
import { describe, expect, it } from 'vitest';

describe('MCP target identity', () => {
  it('matches registry npm specs to runtime targets', () => {
    expect(
      getMcpInstallTargetKey({
        type: 'stdio',
        npmPackage: '@upstash/context7-mcp',
        npmVersion: '1.2.3',
      })
    ).toBe(getMcpRuntimeTargetKey('npx -y @upstash/context7-mcp@1.2.3', 'stdio'));
  });

  it('matches HTTP targets without retaining credentials or query values', () => {
    const installKey = getMcpInstallTargetKey({
      type: 'http',
      url: 'https://user:secret@example.com/mcp?token=abc&region=eu#private',
      transportType: 'streamable-http',
    });
    const runtimeKey = getMcpRuntimeTargetKey(
      'https://***:***@example.com/mcp?token=REDACTED&region=REDACTED#REDACTED',
      'http'
    );

    expect(installKey).toBe(runtimeKey);
    expect(installKey).not.toContain('secret');
    expect(installKey).not.toContain('abc');
    expect(installKey).not.toContain('private');
  });

  it('does not identify arbitrary commands as catalog npm installs', () => {
    expect(getMcpRuntimeTargetKey('node ./server.js --token secret', 'stdio')).toBeNull();
  });
});
