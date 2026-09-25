import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const PRODUCTION_PATHS = [
  'src/features/internal-storage/main/composition/createHostedAuthStorageBackend.ts',
  'src/features/hosted-access/main/adapters/input/http/HostedAuthHttpController.ts',
  'src/features/hosted-access/main/composition/createHostedAccessFeature.ts',
  'src/features/hosted-access/main/index.ts',
  'src/main/composition/hosted/hostedTeamConfigurationComposition.ts',
  'src/main/composition/hosted/hostedAccessNodePlatform.ts',
  'src/main/http/index.ts',
  'src/main/standalone.ts',
] as const;

describe('hosted team-configuration composition boundaries', () => {
  it('keeps forbidden lifecycle and provider authorities outside the slice', async () => {
    const sources = await Promise.all(PRODUCTION_PATHS.map((path) => readFile(path, 'utf8')));
    const addedComposition = sources.slice(0, 6).join('\n');

    expect(addedComposition).not.toMatch(
      /TeamDataService|TeamProvisioning|OpenCode|Terminal|ProcessSupervisor/
    );
    expect(addedComposition).not.toMatch(/\bPhase[A-Z0-9_]/);
  });

  it('exposes only a narrow durable teamConfigurations gateway from hosted storage', async () => {
    const source = await readFile(PRODUCTION_PATHS[0], 'utf8');
    const field = source.slice(
      source.indexOf('const teamConfigurations:'),
      source.indexOf('let disposal:')
    );

    expect(field.match(/client\.[a-zA-Z]+HostedTeamConfiguration/g)).toHaveLength(4);
    expect(field).not.toMatch(/coordination|hostedAuth|teamRoster|processOwnership/);
  });

  it('keeps HTTP registration limited to admission, context, execution, and result mapping', async () => {
    const source = await readFile(
      'src/features/team-configuration/main/adapters/input/http/registerHostedTeamConfigurationHttp.ts',
      'utf8'
    );

    expect(source).toContain('routeAdmission.invoke');
    expect(source).toContain('createContext(descriptor, request, signal)');
    expect(source).toContain('execute(request.body, principal)');
    expect(source).not.toMatch(
      /InternalStorage|TeamDataService|Provisioning|node:fs|node:child_process/
    );
  });
});
