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
  'src/features/team-message-delivery/core/application/ports/TeamMessagePersistencePorts.ts',
  'src/features/team-runtime-operations/core/application/ports/TeamRuntimeOperationPorts.ts',
  'src/features/team-task-board/core/application/ports/TeamTaskBoardInteractionPorts.ts',
  'src/features/team-task-board/core/application/ports/TeamTaskBoardPorts.ts',
  'src/features/team-view-read-model/core/application/ports/TeamViewReadModelPorts.ts',
] as const;

const PROVIDER_NEUTRAL_MESSAGE_DELIVERY_CORE = [
  'src/features/team-message-delivery/core/application/services/InboxMessageDelivery.ts',
  'src/features/team-message-delivery/core/application/services/RuntimeDeliveryMonitor.ts',
  'src/features/team-message-delivery/core/application/use-cases/SendTeamMessageUseCase.ts',
  'src/features/team-message-delivery/core/domain/messageDeliveryRoutePolicy.ts',
  'src/features/team-message-delivery/core/domain/runtimeDeliveryProjection.ts',
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

  it.each(PROVIDER_NEUTRAL_MESSAGE_DELIVERY_CORE)(
    '%s keeps provider interpretation outside generic application and domain code',
    (path) => {
      expect(source(path)).not.toMatch(/opencode|claude|codex|anthropic/i);
    }
  );

  it('keeps persistence ports feature-owned and free of shared runtime DTOs', () => {
    const ports = source(
      'src/features/team-message-delivery/core/application/ports/TeamMessagePersistencePorts.ts'
    );

    expect(ports).not.toContain('@shared/types');
  });

  it('keeps generic runtime delivery DTOs separate from the narrow legacy adapter', () => {
    const genericContracts = [
      'src/features/team-provisioning/contracts/runtime-delivery.ts',
      'src/features/team-message-delivery/contracts/runtime-delivery.ts',
    ];
    const legacyBoundary = source(
      'src/features/team-message-delivery/main/composition/createDesktopTeamMessageDeliveryFeature.ts'
    );

    for (const path of genericContracts) {
      expect(source(path)).not.toMatch(/OpenCode|opencode|Claude/);
    }
    expect(legacyBoundary).toContain('OpenCodeRuntimeDeliveryStatus');
    expect(legacyBoundary).toContain('toRuntimeDeliveryStatus');
    expect(legacyBoundary).toContain('toLegacyRuntimeDeliveryStatus');
    expect(legacyBoundary).toContain('assertOpenCodeProvider');
  });

  it('keeps main and renderer public entrypoints on stable composition and port surfaces', () => {
    const main = source('src/features/team-message-delivery/main/index.ts');
    const renderer = source('src/features/team-message-delivery/renderer/index.ts');

    expect(main).toContain("from './composition/createTeamMessageDeliveryFeature'");
    expect(main).toContain("from './composition/createDesktopTeamMessageDeliveryFeature'");
    expect(main).toContain('registerTeamMessageDeliveryIpc');
    expect(main).toContain('TeamMessageDeliveryIpcDependencies');
    expect(main).not.toMatch(/adapters|infrastructure|OpenCode|electron/);
    expect(renderer).toContain("from './composition/createTeamMessageDeliveryRendererSlice'");
    expect(renderer).toContain("from './ports/TeamMessageDeliveryRendererPorts'");
    expect(renderer).not.toMatch(/adapters|infrastructure|OpenCode|electron/);
  });

  it('keeps app-shell consumers on the public team-message-delivery main entrypoint', () => {
    for (const path of [
      'src/main/ipc/teamFeatureCapabilities.ts',
      'src/main/ipc/teamFeatureComposition.ts',
      'src/main/ipc/teamLegacyAdapters.ts',
    ]) {
      const contents = source(path);
      expect(contents).not.toMatch(
        /(?:\.\.\/)+features\/team-message-delivery\/main\/|@features\/team-message-delivery\/main\//
      );
      expect(contents).toContain("from '@features/team-message-delivery/main'");
    }
  });

  it('publishes neutral runtime delivery status and debug details without compatibility aliases', () => {
    const root = source('src/features/team-message-delivery/index.ts');
    const messageContracts = source('src/features/team-message-delivery/contracts/index.ts');
    const runtimeContracts = source('src/features/team-runtime-operations/contracts/index.ts');

    for (const contents of [root, messageContracts]) {
      expect(contents).toContain('RuntimeDeliveryStatus');
      expect(contents).toContain('RuntimeDeliveryDebugDetails');
    }
    for (const contents of [root, messageContracts, runtimeContracts]) {
      expect(contents).not.toMatch(/OpenCode|opencode|Claude/);
      expect(contents).not.toContain('/compatibility/');
    }
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
    const desktopCompatibility = source('src/preload/constants/ipcChannels.ts');
    expect(desktopCompatibility).toContain(
      'TEAM_GET_RUNTIME_DELIVERY_STATUS as TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS'
    );
    expect(desktopCompatibility).toContain('TEAM_GET_RUNTIME_LOGS as TEAM_GET_CLAUDE_LOGS');
    expect(desktopCompatibility).toContain(
      'TEAM_RETRY_FAILED_RUNTIME_LANES as TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES'
    );
  });
});
