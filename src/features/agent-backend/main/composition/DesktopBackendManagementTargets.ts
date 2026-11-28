import { captureManagedProviderRuntimePreferences } from '@features/runtime-provider-management/main';

import {
  assertBackendRequestGuard,
  BackendRoutingError,
  ownerKey,
} from '../application/backendBinding';
import { refreshCapturedRuntimeConfiguration } from '../application/refreshCapturedRuntimeConfiguration';
import { captureProviderManagement } from '../infrastructure/CapturedProviderManagement';
import { capturedRuntimeSourceGrant } from '../infrastructure/capturedRuntimeSourceGrant';
import { captureRuntimeSources } from '../infrastructure/CapturedRuntimeSources';
import {
  prepareMainWindowsRuntimeConfiguration,
  prepareMainWindowsRuntimeSource,
  prepareMainWindowsRuntimeSourceRecovery,
} from '../infrastructure/CapturedWindowsRuntimeSources';

import type { BackendRequestGuard } from '../application/backendBinding';
import type { CapturedProviderManagement } from '../infrastructure/CapturedProviderManagement';
import type { DesktopBackendDescriptor } from '../infrastructure/loadDesktopBackendDescriptor';
import type { DesktopBackendCompositionContext } from './DesktopBackendCompositionContext';
import type { RuntimeSourceSummary } from '@agent-teams/legacy-agent-host/runtime-sources';

/** Original management captures keep consulting the feature's live owner fences. */
export class DesktopBackendManagementTargets {
  constructor(private readonly context: DesktopBackendCompositionContext) {}

  managementTargetId(
    selected: NonNullable<DesktopBackendDescriptor['management']>[number]
  ): string {
    if (!this.context.descriptor) throw new BackendRoutingError('hold');
    return capturedRuntimeSourceGrant(this.context.descriptor, selected).targetId;
  }

  captureManagementTarget(
    selected: NonNullable<DesktopBackendDescriptor['management']>[number] | undefined,
    guard?: BackendRequestGuard,
    revision?: RuntimeSourceSummary
  ): CapturedProviderManagement {
    const router = this.context.router;
    if (this.context.state !== 'ready' || !selected || !router)
      throw new BackendRoutingError('unavailable');
    const owner = this.context.clients.get(ownerKey(selected.owner));
    if (!owner) throw new BackendRoutingError('hold');
    const profileId = revision?.profileId ?? selected.profileId;
    const configRevision = revision?.configRevision ?? selected.configRevision;
    return captureProviderManagement({
      targetId: this.managementTargetId({ ...selected, profileId, configRevision }),
      profileId,
      configRevision,
      ...(selected.preferences ? { preferences: selected.preferences } : {}),
      refreshConfiguration: () => this.captureCurrentManagementTarget(selected, guard),
      client: owner.client,
      start: () => router.startOwner(selected.owner),
      ownerAvailable: () =>
        !this.context.sealed &&
        this.context.state === 'ready' &&
        this.context.clients.get(ownerKey(selected.owner)) === owner,
      foregroundCurrent: () => guard?.isCurrent() ?? true,
    });
  }

  async captureCurrentManagementTarget(
    selected: NonNullable<DesktopBackendDescriptor['management']>[number] | undefined,
    guard?: BackendRequestGuard
  ): Promise<CapturedProviderManagement> {
    const sources = await this.captureSourceTarget(selected, guard);
    return this.captureManagementTarget(
      selected,
      guard,
      sources ? await refreshCapturedRuntimeConfiguration(sources, selected) : undefined
    );
  }

  async captureSourceTarget(
    selected: NonNullable<DesktopBackendDescriptor['management']>[number] | undefined,
    guard?: BackendRequestGuard
  ) {
    assertBackendRequestGuard(guard);
    const router = this.context.router;
    if (this.context.sealed || this.context.state !== 'ready' || !selected || !router)
      throw new BackendRoutingError('unavailable');
    const owner = this.context.clients.get(ownerKey(selected.owner));
    if (!owner) throw new BackendRoutingError('hold');
    const handshake = await router.startOwner(selected.owner);
    assertBackendRequestGuard(guard);
    if (this.context.sealed || this.context.clients.get(ownerKey(selected.owner)) !== owner)
      throw new BackendRoutingError('unavailable');
    if (!handshake.capabilities.includes('runtime.sources')) return undefined;
    if (!this.context.descriptor) throw new BackendRoutingError('hold');
    const grant = capturedRuntimeSourceGrant(this.context.descriptor, selected);
    const ownerAvailable = () =>
      !this.context.sealed &&
      this.context.state === 'ready' &&
      this.context.clients.get(ownerKey(selected.owner)) === owner;
    const nativeCurrent = () => ownerAvailable() && (guard?.isCurrent() ?? true);
    return captureRuntimeSources({
      grant,
      client: owner.client,
      start: () => router.startOwner(selected.owner),
      ownerAvailable,
      foregroundCurrent: () => guard?.isCurrent() ?? true,
      ...(owner.nativeCustody
        ? {
            prepareNativePublication: (input) =>
              prepareMainWindowsRuntimeSource(owner.nativeCustody!, grant, input, nativeCurrent),
            prepareNativeRecovery: () =>
              prepareMainWindowsRuntimeSourceRecovery(owner.nativeCustody!, grant, nativeCurrent),
            prepareNativeConfiguration: (input) =>
              prepareMainWindowsRuntimeConfiguration(
                owner.nativeCustody!,
                grant,
                input,
                nativeCurrent
              ),
          }
        : {}),
      ...(selected.runtimeId === 'opencode' && selected.preferences
        ? {
            capturePreferences: () =>
              captureManagedProviderRuntimePreferences(
                selected.preferences!,
                () =>
                  !this.context.sealed &&
                  this.context.state === 'ready' &&
                  this.context.clients.get(ownerKey(selected.owner)) === owner &&
                  (guard?.isCurrent() ?? true)
              ),
          }
        : {}),
    });
  }
}
