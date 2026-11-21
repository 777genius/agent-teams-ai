import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { parseTeamProvisioningContext } from '@shared/utils/teamProvisioningContext';

import {
  isDesktopAgentBackendSelected,
  prepareDesktopCapturedTeam,
  prepareDesktopCreatedTeam,
} from '../agentBackend';

import { prepareLegacy } from './prepareLegacyProvisioningRequest';

import type { TeamProvisioningPreflightApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { IpcResult } from '@shared/types/ipc';
import type {
  TeamProvisioningPrepareContext,
  TeamProvisioningPrepareResult,
} from '@shared/types/team';
import type { IpcMainInvokeEvent } from 'electron';

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<IpcResult<TeamProvisioningPrepareResult>>;
type LegacyPrepare = (
  ...args: Parameters<TeamProvisioningPreflightApi['prepareForProvisioning']>
) => Promise<IpcResult<TeamProvisioningPrepareResult>>;
type TeamHostPrepare = (
  event: IpcMainInvokeEvent,
  context: Extract<TeamProvisioningPrepareContext, { kind: 'team' }>,
  ...args: Parameters<TeamProvisioningPreflightApi['prepareForProvisioning']>
) => Promise<TeamProvisioningPrepareResult>;

/** An existing dialog's Host intent must never run fork discovery/model tests. */
export function createPrepareProvisioningHandler(
  legacy: LegacyPrepare,
  selected: () => boolean = isDesktopAgentBackendSelected,
  host: TeamHostPrepare = (event, context, cwd, options) =>
    prepareDesktopCapturedTeam(event, context.teamName, {
      ...options,
      ...(cwd === undefined ? {} : { cwd }),
      ...(context.selectedModelChecks === undefined
        ? {}
        : { selectedModelChecks: context.selectedModelChecks }),
      ...(context.preparationId === undefined ? {} : { preparationId: context.preparationId }),
    })
): Handler {
  return async (event, ...args) => {
    let context;
    try {
      if (args.length > 8) throw new Error('Invalid provisioning context');
      context = parseTeamProvisioningContext(args[7]);
    } catch {
      return { success: false, error: 'Invalid provisioning context' };
    }
    if (context?.kind === 'team' && isHostTeamSelectionKey(context.teamName)) {
      const captured = context;
      return prepareLegacy(
        async (cwd, options) => ({
          success: true,
          data: await host(event, captured, cwd, options),
        }),
        ...args.slice(0, 7)
      );
    }
    if (selected() && context?.kind === 'create' && context.draft && context.preparationId) {
      const captured = context;
      return prepareLegacy(
        async (cwd) => ({
          success: true,
          data: await prepareDesktopCreatedTeam(event, captured, cwd),
        }),
        ...args.slice(0, 7)
      );
    }
    if (selected() && (!context || context.kind === 'create')) {
      // Until the captured Team preflight is connected, report the real gap.
      // A global Claude test or legacy preflight cannot establish this owner's
      // account/configuration/capability readiness.
      return {
        success: true,
        data: {
          ready: false,
          message: 'Captured Host provisioning checks are not connected yet.',
          details: ['Refresh after Host preparation is available. No legacy checks were run.'],
        },
      };
    }
    return prepareLegacy(legacy, ...args.slice(0, 7));
  };
}
