import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { describe, expect, it } from 'vitest';

type MemberLifecycleHostProbe = {
  memberLifecycleHost: {
    readConfigForStrictDecision(teamName: string): Promise<unknown>;
  };
};

describe('TeamProvisioningService member lifecycle host', () => {
  it('binds member lifecycle host callbacks to the service receiver', async () => {
    const configReader = {
      marker: 'reader-bound',
      async getConfig(this: { marker: string }, teamName: string) {
        return {
          name: `${this.marker}:${teamName}`,
          members: [],
        };
      },
    };
    const service = new TeamProvisioningService(
      configReader as unknown as ConstructorParameters<typeof TeamProvisioningService>[0]
    );
    const host = (service as unknown as MemberLifecycleHostProbe).memberLifecycleHost;

    await expect(host.readConfigForStrictDecision('alpha')).resolves.toMatchObject({
      name: 'reader-bound:alpha',
    });
  });
});
