import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT_ENTRYPOINTS = [
  'src/features/team-provisioning/index.ts',
  'src/features/team-message-delivery/index.ts',
  'src/features/team-runtime-operations/index.ts',
  'src/features/team-task-board/index.ts',
  'src/features/team-view-read-model/index.ts',
] as const;

const GENERIC_APPLICATION_PORTS = [
  'src/features/team-provisioning/core/application/ports/RuntimeDeliveryPort.ts',
  'src/features/team-message-delivery/core/application/ports/TeamMessageDeliveryPorts.ts',
  'src/features/team-runtime-operations/core/application/ports/TeamRuntimeOperationPorts.ts',
  'src/features/team-task-board/core/application/ports/TeamTaskBoardInteractionPorts.ts',
  'src/features/team-task-board/core/application/ports/TeamTaskBoardPorts.ts',
  'src/features/team-view-read-model/core/application/ports/TeamViewReadModelPorts.ts',
] as const;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('team public contract boundaries', () => {
  it.each(ROOT_ENTRYPOINTS)('%s is a deliberate root entrypoint', (path) => {
    const contents = source(path);

    expect(contents).not.toMatch(/\bexport\s+(?:type\s+)?\*/);
    expect(contents).not.toMatch(/OpenCode|opencode|Claude/);
    expect(contents).not.toContain('/compatibility/');
    expect(contents).not.toContain('/main/');
  });

  it.each(GENERIC_APPLICATION_PORTS)(
    '%s contains no provider-specific application vocabulary',
    (path) => {
      expect(source(path)).not.toMatch(/OpenCode|opencode|Claude/);
    }
  );

  it('keeps generic runtime delivery DTOs separate from provider compatibility', () => {
    const genericContracts = [
      'src/features/team-provisioning/contracts/runtime-delivery.ts',
      'src/features/team-message-delivery/contracts/runtime-delivery.ts',
    ];
    const compatibilityContract = source(
      'src/features/team-message-delivery/contracts/compatibility/open-code-delivery.ts'
    );

    for (const path of genericContracts) {
      expect(source(path)).not.toMatch(/OpenCode|opencode|Claude/);
    }
    expect(compatibilityContract).toContain('OpenCodeRuntimeDeliveryStatus');
    expect(compatibilityContract).toContain('toRuntimeDeliveryStatus');
  });

  it('publishes the missing team-view-read-model root channels', () => {
    const root = source('src/features/team-view-read-model/index.ts');

    expect(root).toContain('TEAM_GET_DATA');
    expect(root).toContain('TEAM_GET_MEMBER_ACTIVITY_META');
    expect(root).toContain('TEAM_GET_MESSAGES_PAGE');
    expect(root).toContain("from './contracts/channels'");
  });

  it('publishes the generic provisioning runtime-delivery API from the stable root', () => {
    const root = source('src/features/team-provisioning/index.ts');

    expect(root).toContain('RuntimeDeliveryApi');
    expect(root).not.toContain('TeamProvisioningRuntimeDeliveryApi');
  });

  it('preserves legacy transport values behind neutral constant names', () => {
    expect(source('src/features/team-message-delivery/contracts/channels.ts')).toContain(
      "TEAM_GET_RUNTIME_DELIVERY_STATUS = 'team:getOpenCodeRuntimeDeliveryStatus'"
    );
    expect(source('src/features/team-runtime-operations/contracts/channels.ts')).toContain(
      "TEAM_GET_RUNTIME_LOGS = 'team:getClaudeLogs'"
    );
    expect(source('src/features/team-runtime-operations/contracts/channels.ts')).toContain(
      "TEAM_RETRY_FAILED_RUNTIME_LANES = 'team:retryFailedOpenCodeSecondaryLanes'"
    );
  });
});
