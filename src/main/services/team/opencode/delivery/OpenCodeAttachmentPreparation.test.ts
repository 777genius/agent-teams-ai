import { OPEN_CODE_SOLO_MEMBER_NAME } from '@features/team-runtime-lanes';
import { describe, expect, it } from 'vitest';

import { resolveOpenCodeSoloMemberIdentityFromDirectory } from '../../provisioning/TeamProvisioningOpenCodeSoloRuntime';

import { resolveOpenCodeDeliveryModel } from './OpenCodeAttachmentPreparation';

import type { OpenCodeMemberDirectory } from './OpenCodeMemberMessageDeliveryPorts';

describe('OpenCode solo attachment model target', () => {
  it('uses the actual resolved launch model for the generated solo identity', () => {
    const directory: OpenCodeMemberDirectory = {
      config: { name: 'TEST-solo', projectPath: '/TEST/solo', members: [] },
      metaMembers: [],
      teamMeta: {
        providerId: 'opencode',
        launchIdentity: {
          selectedModel: 'default',
          resolvedLaunchModel: 'new-source/ResolvedModel',
        },
      },
    };
    const identity = resolveOpenCodeSoloMemberIdentityFromDirectory(
      OPEN_CODE_SOLO_MEMBER_NAME,
      directory
    );
    expect(identity?.ok).toBe(true);
    if (!identity?.ok) throw new Error('Solo fixture did not resolve');
    expect(resolveOpenCodeDeliveryModel({ identity, directory, run: null })).toBe(
      'new-source/ResolvedModel'
    );
  });
});
