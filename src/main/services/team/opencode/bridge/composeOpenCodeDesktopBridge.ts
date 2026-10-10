import { createOpenCodeGroupChatRunGetter } from '@features/team-group-chats/main';
import { join } from 'path';

import { OpenCodeRuntimeLaunchAuthorityWriter } from '../store/OpenCodeRuntimeLaunchAuthorityWriter';
import { OpenCodeRuntimeManifestEvidenceReader } from '../store/OpenCodeRuntimeManifestEvidenceReader';

import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
} from './OpenCodeBridgeCommandLedgerStore';
import { createOpenCodeBridgeClientIdentity, OpenCodeBridgeCommandHandshakePort } from './OpenCodeBridgeHandshakeClient';
import { OpenCodeReadinessBridge } from './OpenCodeReadinessBridge';
import { OpenCodeStateChangingBridgeCommandService } from './OpenCodeStateChangingBridgeCommandService';

import type { OpenCodeBridgeCommandClient } from './OpenCodeBridgeCommandClient';
import type { OpenCodeReadinessBridgeOptions } from './OpenCodeReadinessBridge';
import type { TeamAgentRuntimeSnapshot } from '@shared/types';

/** One runtime handshake identity owns readiness, commands and group run proof. */
export function composeOpenCodeDesktopBridge(deps: {
  bridge: OpenCodeBridgeCommandClient;
  controlDirectory: string;
  teamsBasePath: string;
  identity: Parameters<typeof createOpenCodeBridgeClientIdentity>[0];
  readOpenCodeRuntimeStatus: OpenCodeReadinessBridgeOptions['readOpenCodeRuntimeStatus'];
  snapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}) {
  const clientIdentity = createOpenCodeBridgeClientIdentity(deps.identity);
  const handshake = new OpenCodeBridgeCommandHandshakePort({ bridge: deps.bridge, clientIdentity });
  const manifestOptions = { teamsBasePath: deps.teamsBasePath };
  const manifest = new OpenCodeRuntimeManifestEvidenceReader(manifestOptions);
  const commands = new OpenCodeStateChangingBridgeCommandService({
    expectedClientIdentity: clientIdentity,
    handshakePort: handshake,
    leaseStore: createOpenCodeBridgeCommandLeaseStore({ filePath: join(deps.controlDirectory, 'command-leases.json') }),
    ledger: createOpenCodeBridgeCommandLedgerStore({ filePath: join(deps.controlDirectory, 'command-ledger.json') }),
    bridge: deps.bridge,
    launchAuthorityWriter: new OpenCodeRuntimeLaunchAuthorityWriter(manifestOptions),
    manifestReader: manifest,
  });
  return {
    readiness: new OpenCodeReadinessBridge(deps.bridge, {
      stateChangingCommands: commands, appVersion: clientIdentity.appVersion,
      readOpenCodeRuntimeStatus: deps.readOpenCodeRuntimeStatus,
    }),
    groupRun: createOpenCodeGroupChatRunGetter({
      clientIdentity, handshake, manifest, snapshot: deps.snapshot,
    }),
  };
}
