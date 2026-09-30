import {
  type AuthorityBinding,
  HOSTED_ROLES,
  type HostedAuthMode,
  type HostedRole,
  parseUserId,
  type UserId,
} from '../../contracts';

import type { HostedAccessAuthority } from './HostedAccessAuthority';
import type { HostedIdentityService } from './HostedIdentityService';
import type {
  HostedAuditEvent,
  HostedAuthModeResetResult,
  HostedIdentityRepositoryPort,
  HostedLocalRoleAssignment,
  HostedWorkspaceRegistration,
} from './identityPorts';
import type { PairingDrainProofPort } from './ports';

const WORKSPACE_ID_PATTERN = /^-?[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export interface HostedLocalUserView {
  readonly userId: UserId;
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
  readonly localRole: HostedRole | null;
}

export interface HostedLocalAdministrationDependencies {
  readonly mode: HostedAuthMode;
  readonly binding: AuthorityBinding;
  readonly authority: HostedAccessAuthority | null;
  readonly identities: HostedIdentityService;
  readonly repository: HostedIdentityRepositoryPort;
  readonly drainProof: PairingDrainProofPort;
  readonly now: () => number;
  readonly runWithBrowserStreamsDrained: <Value>(operation: () => Promise<Value>) => Promise<Value>;
  readonly blockPublicAccess: () => Promise<void>;
  readonly restorePublicAccess: () => void;
  readonly performAuthModeReset: (input: {
    readonly targetMode: HostedAuthMode;
    readonly resetGeneration: number;
    readonly auditEvent: HostedAuditEvent;
  }) => Promise<HostedAuthModeResetResult>;
}

function localControlError(code: string): Error {
  return new Error(`hosted_local_control_${code}`);
}

function validateWorkspaceId(workspaceId: string): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || workspaceId === '.' || workspaceId === '..') {
    throw localControlError('workspace_id_invalid');
  }
  return workspaceId;
}

function validateDisplayName(displayName: string): string {
  const value = displayName.trim();
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (value.length === 0 || value.length > 256 || hasControlCharacter) {
    throw localControlError('display_name_invalid');
  }
  return value;
}

/**
 * Local-only application boundary for deployment administration. The Unix
 * socket adapter is deliberately separate from the public HTTP controller.
 */
export class HostedLocalAdministration {
  private authModeResetInProgress = false;
  private personalResetInProgress = false;

  constructor(private readonly dependencies: HostedLocalAdministrationDependencies) {}

  async listUsers(): Promise<readonly HostedLocalUserView[]> {
    this.assertAdministrationActive();
    const users = await this.dependencies.repository.listUsers();
    return Promise.all(
      users.map(async (user) => {
        const assignment = await this.dependencies.repository.getLocalRoleAssignment(user.userId);
        return Object.freeze({
          userId: user.userId,
          displayName: user.displayName,
          status: user.status,
          localRole: assignment?.role ?? null,
        });
      })
    );
  }

  async setUserStatus(userIdValue: string, status: 'active' | 'disabled'): Promise<boolean> {
    this.assertAdministrationActive();
    if (this.dependencies.mode !== 'oidc') throw localControlError('oidc_mode_required');
    const userId = parseUserId(userIdValue);
    const changed = await this.dependencies.repository.setUserStatus({
      userId,
      status,
      now: this.dependencies.now(),
    });
    await this.dependencies.identities.auditLocalControl(
      `auth.local.user-${status === 'active' ? 'enable' : 'disable'}`,
      changed ? 'success' : 'denied',
      { userId, reason: changed ? null : 'user_not_found' }
    );
    return changed;
  }

  async setLocalRole(userIdValue: string, role: HostedRole): Promise<void> {
    this.assertAdministrationActive();
    if (this.dependencies.mode !== 'oidc') throw localControlError('oidc_mode_required');
    if (!HOSTED_ROLES.includes(role)) throw localControlError('role_invalid');
    const userId = parseUserId(userIdValue);
    const user = await this.dependencies.repository.getUser(userId);
    if (user === null) throw localControlError('user_not_found');
    if (user.status !== 'active') throw localControlError('user_disabled');
    const assignment: HostedLocalRoleAssignment = Object.freeze({
      userId,
      role,
      assignedAt: this.dependencies.now(),
      assignedBy: 'local-cli',
    });
    await this.dependencies.repository.setLocalRoleAssignment(assignment);
    await this.dependencies.identities.auditLocalControl('auth.local.role-set', 'success', {
      userId,
      role,
      effectiveAfter: 'reauthentication',
    });
  }

  async clearLocalRole(userIdValue: string): Promise<boolean> {
    this.assertAdministrationActive();
    if (this.dependencies.mode !== 'oidc') throw localControlError('oidc_mode_required');
    const userId = parseUserId(userIdValue);
    if ((await this.dependencies.repository.getUser(userId)) === null) {
      throw localControlError('user_not_found');
    }
    const cleared = await this.dependencies.repository.clearLocalRoleAssignment(userId);
    await this.dependencies.identities.auditLocalControl('auth.local.role-clear', 'success', {
      userId,
      cleared,
      effectiveAfter: 'reauthentication',
    });
    return cleared;
  }

  listWorkspaces(): Promise<readonly HostedWorkspaceRegistration[]> {
    this.assertAdministrationActive();
    return this.dependencies.repository.listWorkspaces();
  }

  async registerWorkspace(
    runtimeWorkspaceIdValue: string,
    displayNameValue: string
  ): Promise<HostedWorkspaceRegistration> {
    this.assertAdministrationActive();
    const runtimeWorkspaceId = validateWorkspaceId(runtimeWorkspaceIdValue);
    const displayName = validateDisplayName(displayNameValue);
    const registration = await this.dependencies.repository.registerWorkspace({
      runtimeWorkspaceId,
      workspaceId: await this.dependencies.identities.createWorkspaceId(),
      displayName,
      registeredAt: this.dependencies.now(),
      registeredBy: null,
    });
    await this.dependencies.identities.auditLocalControl(
      'auth.local.workspace-register',
      'success',
      { workspaceId: registration.workspaceId }
    );
    return registration;
  }

  async disableWorkspace(runtimeWorkspaceIdValue: string): Promise<boolean> {
    this.assertAdministrationActive();
    const runtimeWorkspaceId = validateWorkspaceId(runtimeWorkspaceIdValue);
    const disabled = await this.dependencies.repository.disableWorkspace(runtimeWorkspaceId);
    await this.dependencies.identities.auditLocalControl(
      'auth.local.workspace-disable',
      disabled ? 'success' : 'denied',
      { reason: disabled ? null : 'workspace_not_found_or_disabled' }
    );
    return disabled;
  }

  async grantWorkspace(userIdValue: string, runtimeWorkspaceIdValue: string) {
    this.assertAdministrationActive();
    const userId = parseUserId(userIdValue);
    const runtimeWorkspaceId = validateWorkspaceId(runtimeWorkspaceIdValue);
    const user = await this.dependencies.repository.getUser(userId);
    if (user === null) throw localControlError('user_not_found');
    if (user.status !== 'active') throw localControlError('user_disabled');
    const grant = await this.dependencies.repository.grantWorkspace({
      userId,
      runtimeWorkspaceId,
      grantGeneration: this.dependencies.binding.restoreGeneration,
      grantedAt: this.dependencies.now(),
      grantedBy: 'local-cli',
    });
    await this.dependencies.identities.auditLocalControl('auth.local.workspace-grant', 'success', {
      userId,
      workspaceId: grant.workspaceId,
      grantGeneration: grant.grantGeneration,
    });
    return grant;
  }

  async revokeWorkspaceGrant(
    userIdValue: string,
    runtimeWorkspaceIdValue: string
  ): Promise<boolean> {
    this.assertAdministrationActive();
    const userId = parseUserId(userIdValue);
    const runtimeWorkspaceId = validateWorkspaceId(runtimeWorkspaceIdValue);
    if ((await this.dependencies.repository.getUser(userId)) === null) {
      throw localControlError('user_not_found');
    }
    const revoked = await this.dependencies.repository.revokeWorkspaceGrant({
      userId,
      runtimeWorkspaceId,
    });
    await this.dependencies.identities.auditLocalControl(
      'auth.local.workspace-grant-revoke',
      revoked ? 'success' : 'denied',
      { userId, reason: revoked ? null : 'grant_not_found' }
    );
    return revoked;
  }

  async resetPersonal(resetGeneration: number): Promise<{ readonly resetGeneration: number }> {
    this.assertAdministrationActive();
    const authority = this.dependencies.authority;
    if (this.dependencies.mode !== 'personal' || authority === null) {
      throw localControlError('personal_mode_required');
    }
    if (!Number.isSafeInteger(resetGeneration) || resetGeneration <= 0) {
      throw localControlError('reset_generation_invalid');
    }
    this.personalResetInProgress = true;
    try {
      const drain = await this.dependencies.drainProof.confirmDrained({
        binding: this.dependencies.binding,
        purpose: 'host_reset',
        resetGeneration,
      });
      if (drain.status !== 'drained') {
        await this.dependencies.identities.auditLocalControl(
          'auth.local.personal-reset',
          'denied',
          {
            resetGeneration,
            reason: `drain_${drain.status}`,
          }
        );
        throw localControlError('pairing_drain_unconfirmed');
      }
      return await this.dependencies.runWithBrowserStreamsDrained(async () => {
        await this.dependencies.blockPublicAccess();
        const result = await authority.consumeResetGeneration(
          this.dependencies.binding,
          resetGeneration
        );
        if (!result.ok) {
          await this.dependencies.identities.auditLocalControl(
            'auth.local.personal-reset',
            'denied',
            {
              resetGeneration,
              reason: result.code,
            }
          );
          throw localControlError(result.code);
        }
        await this.dependencies.identities.auditLocalControl(
          'auth.local.personal-reset',
          'success',
          {
            resetGeneration,
          }
        );
        this.dependencies.restorePublicAccess();
        return Object.freeze({ resetGeneration: result.value.resetGeneration });
      });
    } finally {
      this.personalResetInProgress = false;
    }
  }

  async resetAuthMode(
    targetMode: HostedAuthMode,
    resetGeneration: number
  ): Promise<{
    readonly mode: HostedAuthMode;
    readonly resetGeneration: number;
    readonly restartRequired: true;
  }> {
    if (this.personalResetInProgress) throw localControlError('personal_reset_in_progress');
    if (targetMode !== 'personal' && targetMode !== 'oidc') {
      throw localControlError('auth_mode_invalid');
    }
    if (targetMode === this.dependencies.mode) {
      throw localControlError('auth_mode_unchanged');
    }
    if (!Number.isSafeInteger(resetGeneration) || resetGeneration <= 0) {
      throw localControlError('reset_generation_invalid');
    }
    if (this.authModeResetInProgress) throw localControlError('auth_mode_reset_in_progress');
    this.authModeResetInProgress = true;
    let auditEvent: HostedAuditEvent;
    try {
      const configuration = await this.dependencies.repository.readAuthConfiguration();
      if (
        configuration === null ||
        configuration.mode !== this.dependencies.mode ||
        resetGeneration <= configuration.resetGeneration
      ) {
        throw localControlError(
          configuration !== null && resetGeneration <= configuration.resetGeneration
            ? 'reset_generation_not_newer'
            : 'auth_mode_mismatch'
        );
      }
      const drain = await this.dependencies.drainProof.confirmDrained({
        binding: this.dependencies.binding,
        purpose: 'auth_mode_reset',
        resetGeneration,
        targetAuthMode: targetMode,
      });
      if (drain.status !== 'drained') {
        await this.dependencies.identities.auditLocalControl(
          'auth.local.auth-mode-reset',
          'denied',
          {
            targetMode,
            resetGeneration,
            reason: `drain_${drain.status}`,
          }
        );
        throw localControlError('auth_mode_drain_unconfirmed');
      }
      auditEvent = await this.dependencies.identities.createLocalControlAuditEvent(
        'auth.local.auth-mode-reset',
        'success',
        {
          targetMode,
          resetGeneration,
          drainEvidenceRef: drain.evidenceRef,
          restartRequired: true,
        }
      );
    } catch (error) {
      this.authModeResetInProgress = false;
      throw error;
    }

    return this.dependencies.runWithBrowserStreamsDrained(async () => {
      await this.dependencies.blockPublicAccess();
      let result: HostedAuthModeResetResult;
      try {
        result = await this.dependencies.performAuthModeReset({
          targetMode,
          resetGeneration,
          auditEvent,
        });
      } catch {
        // An indeterminate storage or secret-staging outcome remains closed.
        // Restart recovery decides whether the durable transition committed.
        throw localControlError('auth_mode_reset_indeterminate');
      }
      if (result !== 'committed') {
        this.authModeResetInProgress = false;
        this.dependencies.restorePublicAccess();
        await this.dependencies.identities.auditLocalControl(
          'auth.local.auth-mode-reset',
          'denied',
          { targetMode, resetGeneration, reason: result }
        );
        throw localControlError(result);
      }
      return Object.freeze({
        mode: targetMode,
        resetGeneration,
        restartRequired: true as const,
      });
    });
  }

  private assertAdministrationActive(): void {
    if (this.personalResetInProgress) {
      throw localControlError('personal_reset_in_progress');
    }
    if (this.authModeResetInProgress) {
      throw localControlError('auth_mode_reset_requires_restart');
    }
  }
}
