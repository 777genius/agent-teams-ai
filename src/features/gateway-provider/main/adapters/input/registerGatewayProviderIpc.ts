import { randomUUID } from 'node:crypto';

import { createLogger } from '@shared/utils/logger';

import { GATEWAY_PROVIDER_CHANNELS } from '../../../contracts/index';

import type { GatewayProviderFeatureFacade } from '../../composition/createGatewayProviderFeature';
import type { IpcMain, WebContents } from 'electron';

const logger = createLogger('Feature:GatewayProvider:IPC');

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

export function registerGatewayProviderIpc(
  ipcMain: IpcMain,
  feature: GatewayProviderFeatureFacade
): void {
  const owners = new WeakMap<WebContents, { id: string; pending: Set<Promise<unknown>> }>();
  const ownerFor = (sender: WebContents) => {
    const existing = owners.get(sender);
    if (existing) return existing;
    const owner = { id: randomUUID(), pending: new Set<Promise<unknown>>() };
    owners.set(sender, owner);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (owners.get(sender) === owner) owners.delete(sender);
      sender.removeListener('render-process-gone', close);
      sender.removeListener('destroyed', close);
      sender.removeListener('did-start-navigation', navigate);
      void Promise.allSettled([...owner.pending])
        .then(() => feature.recoverGatewayDraftBindings(owner.id))
        .catch((error: unknown) =>
          logger.warn('Could not recover abandoned gateway drafts', error)
        );
    };
    const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) close();
    };
    sender.once('render-process-gone', close);
    sender.once('destroyed', close);
    sender.on('did-start-navigation', navigate);
    return owner;
  };
  ipcMain.handle(GATEWAY_PROVIDER_CHANNELS.listProfiles, () => feature.listGatewayProfiles());
  ipcMain.handle(GATEWAY_PROVIDER_CHANNELS.saveProfile, (_event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('Invalid profile request.');
    const input = request as Record<string, unknown>;
    return feature.saveGatewayProfile({
      id: typeof input.id === 'string' && input.id ? input.id : undefined,
      displayName: requireString(input.displayName, 'Profile name'),
      baseUrl: requireString(input.baseUrl, 'Gateway URL'),
      allowPrivateNetwork: input.allowPrivateNetwork === true,
    });
  });
  ipcMain.handle(GATEWAY_PROVIDER_CHANNELS.deleteProfile, (_event, id: unknown) => {
    return feature.deleteGatewayProfile(requireString(id, 'Profile id'));
  });
  ipcMain.handle(GATEWAY_PROVIDER_CHANNELS.probeModels, (_event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('Invalid probe request.');
    const input = request as Record<string, unknown>;
    return feature
      .probeGatewayModels({
        profileId: requireString(input.profileId, 'Profile id'),
        apiKey: requireString(input.apiKey, 'Gateway API key'),
      })
      .then((models) => ({ models }));
  });
  ipcMain.handle(GATEWAY_PROVIDER_CHANNELS.listBindings, (_event, teamName: unknown) => {
    return feature.listGatewayBindings(
      typeof teamName === 'string' && teamName.trim() ? teamName : undefined
    );
  });
  ipcMain.handle(GATEWAY_PROVIDER_CHANNELS.bindMember, async (event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('Invalid binding request.');
    const input = request as Record<string, unknown>;
    try {
      const owner = ownerFor(event.sender);
      const operation = feature.bindGatewayMember(
        {
          teamName: requireString(input.teamName, 'Team name'),
          memberName: requireString(input.memberName, 'Member name'),
          profileId: requireString(input.profileId, 'Profile id'),
          apiKey: requireString(input.apiKey, 'Gateway API key'),
        },
        owner.id
      );
      owner.pending.add(operation);
      try {
        return await operation;
      } finally {
        owner.pending.delete(operation);
      }
    } catch (error) {
      logger.warn('Failed to bind gateway member', error);
      throw error;
    }
  });
  ipcMain.handle(GATEWAY_PROVIDER_CHANNELS.unbindMember, (_event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('Invalid unbind request.');
    const input = request as Record<string, unknown>;
    const receipt = input.expectedBinding;
    if (receipt !== undefined && (!receipt || typeof receipt !== 'object'))
      throw new Error('Invalid expected gateway binding.');
    const expected = receipt as Record<string, unknown> | undefined;
    return feature.unbindGatewayMember({
      teamName: requireString(input.teamName, 'Team name'),
      memberName: requireString(input.memberName, 'Member name'),
      ...(expected
        ? {
            expectedBinding: {
              gatewayUsageRef: requireString(expected.gatewayUsageRef, 'Expected usage reference'),
              boundAt: requireString(expected.boundAt, 'Expected binding timestamp'),
            },
          }
        : {}),
    });
  });
}
