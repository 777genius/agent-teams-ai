import { createHostedTeamIdentityGatewayBinding } from '@main/composition/hosted/hostedTeamIdentityGatewayBinding';
import { parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { TeamLifecycleReadOnlyIdentityGateway } from '@main/composition/hosted/teamLifecycleReadOnlyIdentitySource';

const teamId = parseTeamId(`team_${'1'.repeat(32)}`);

function gateway(label: string): TeamLifecycleReadOnlyIdentityGateway {
  return {
    listTeamIdentities: vi.fn().mockResolvedValue([]),
    getTeamIdentity: vi.fn().mockResolvedValue(null),
    captureExternalWriterTeamIdentities: vi.fn().mockResolvedValue({
      active: [],
      retiredCandidates: [],
      label,
    }),
  };
}

describe('hosted team identity gateway binding', () => {
  it('moves existing consumers from startup snapshots to the live hosted worker', async () => {
    const startup = gateway('startup');
    const live = gateway('live');
    const binding = createHostedTeamIdentityGatewayBinding(startup);

    await binding.gateway.getTeamIdentity(teamId);
    expect(startup.getTeamIdentity).toHaveBeenCalledOnce();

    binding.bindLiveGateway(live);
    await binding.gateway.getTeamIdentity(teamId);
    await binding.gateway.captureExternalWriterTeamIdentities({ retirementCandidates: [] });

    expect(live.getTeamIdentity).toHaveBeenCalledOnce();
    expect(live.captureExternalWriterTeamIdentities).toHaveBeenCalledOnce();
  });

  it('rejects rebinding or pretending the startup reader is the live worker', () => {
    const startup = gateway('startup');
    const binding = createHostedTeamIdentityGatewayBinding(startup);

    expect(() => binding.bindLiveGateway(startup)).toThrow(
      'hosted-team-identity-live-gateway-invalid'
    );
    binding.bindLiveGateway(gateway('live'));
    expect(() => binding.bindLiveGateway(gateway('other'))).toThrow(
      'hosted-team-identity-live-gateway-already-bound'
    );
  });
});
