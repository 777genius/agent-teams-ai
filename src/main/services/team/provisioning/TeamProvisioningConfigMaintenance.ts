import * as path from 'path';

import {
  assertConfigRawLeadOnlyForLaunch,
  buildMembersMetaWritePayload,
  collectConfigLaunchBaseNamesFromConfigMembers,
  collectConfigLaunchBaseNamesFromMetaMembers,
  getPrelaunchConfigBackupPath,
  planCliAutoSuffixedConfigMemberCleanup,
  planCliAutoSuffixedMetaMemberCleanup,
  planTeamConfigLaunchNormalization,
  selectMembersMetaTeammates,
} from './TeamProvisioningConfigLaunchNormalization';
import {
  type TeamProvisioningEffectiveLaunchState,
  updateTeamConfigPostLaunch,
} from './TeamProvisioningConfigMaterialization';
import { mergeAndRemoveDuplicateInboxes } from './TeamProvisioningInboxDuplicateMerge';

import type { TeamCreateRequest, TeamMember } from '@shared/types';

export interface TeamProvisioningConfigMaintenanceReadOptions {
  timeoutMs: number;
  maxBytes: number;
}

export interface TeamProvisioningConfigMaintenanceMembersMetaStore {
  getMembers(teamName: string): Promise<TeamMember[]>;
  writeMembers(
    teamName: string,
    members: TeamMember[],
    options?: { providerBackendId?: TeamCreateRequest['providerBackendId'] }
  ): Promise<void>;
}

export interface TeamProvisioningConfigMaintenancePorts {
  getTeamsBasePath(): string;
  getProjectsBasePath(): string;
  readRegularFileUtf8(
    filePath: string,
    options: TeamProvisioningConfigMaintenanceReadOptions
  ): Promise<string | null | undefined>;
  writeFileUtf8(filePath: string, contents: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  readDir(dirPath: string): Promise<string[]>;
  stat(filePath: string): Promise<{ isFile(): boolean; mtimeMs: number }>;
  withCanonicalInboxLock(filePath: string, fn: () => Promise<void>): Promise<void>;
  scanForNewestProjectSession(input: {
    projectPath: string;
    knownSessions: string[];
    projectsBasePath: string;
    ports: {
      readDir(dirPath: string): Promise<string[]>;
      stat(filePath: string): Promise<{ isFile(): boolean; mtimeMs: number }>;
    };
  }): Promise<string | null>;
  membersMetaStore: TeamProvisioningConfigMaintenanceMembersMetaStore;
  invalidateTeam(teamName: string): void;
  getLanguage(): string;
  now(): number;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
  };
}

export interface TeamProvisioningConfigMaintenanceLimits {
  teamJsonReadTimeoutMs: number;
  teamConfigMaxBytes: number;
  teamInboxMaxBytes: number;
}

export interface TeamProvisioningConfigMaintenanceOptions {
  ports: TeamProvisioningConfigMaintenancePorts;
  limits: TeamProvisioningConfigMaintenanceLimits;
}

export class TeamProvisioningConfigMaintenance {
  constructor(private readonly options: TeamProvisioningConfigMaintenanceOptions) {}

  /**
   * Immediately update projectPath in config.json at launch start, before CLI spawn.
   * Ensures TeamDetailView shows the correct project path even if provisioning
   * is interrupted. On failure, restorePrelaunchConfig() reverts to the backup.
   */
  async updateConfigProjectPath(teamName: string, cwd: string): Promise<void> {
    const configPath = this.getConfigPath(teamName);
    try {
      const raw = await this.readTeamConfig(configPath);
      if (!raw) {
        throw new Error('config.json unreadable');
      }
      const config = JSON.parse(raw) as Record<string, unknown>;

      config.projectPath = cwd;

      const pathHistory = Array.isArray(config.projectPathHistory)
        ? (config.projectPathHistory as string[]).filter((p) => typeof p === 'string' && p !== cwd)
        : [];
      pathHistory.push(cwd);
      config.projectPathHistory = pathHistory.slice(-500);

      await this.options.ports.writeFileUtf8(configPath, JSON.stringify(config, null, 2));
      this.options.ports.invalidateTeam(teamName);
      this.options.ports.logger.info(
        `[${teamName}] Updated config.projectPath immediately: ${cwd}`
      );
    } catch (error) {
      // Non-fatal: updateConfigPostLaunch will update it later if provisioning succeeds.
      this.options.ports.logger.warn(
        `[${teamName}] Failed to update projectPath early: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Single atomic read-mutate-write for post-launch config updates.
   * Combines session history append and projectPath update to avoid
   * race conditions with the CLI writing to the same file.
   */
  async updateConfigPostLaunch(
    teamName: string,
    projectPath: string,
    detectedSessionId: string | null,
    color?: string,
    launchState?: TeamProvisioningEffectiveLaunchState
  ): Promise<void> {
    const configPath = this.getConfigPath(teamName);
    await updateTeamConfigPostLaunch(
      { teamName, projectPath, detectedSessionId, color, launchState },
      {
        readConfig: () => this.readTeamConfig(configPath),
        writeConfig: (raw) => this.options.ports.writeFileUtf8(configPath, raw),
        invalidateTeam: (name) => this.options.ports.invalidateTeam(name),
        scanForNewestSession: (scanProjectPath, knownSessions) =>
          this.options.ports.scanForNewestProjectSession({
            projectPath: scanProjectPath,
            knownSessions,
            projectsBasePath: this.options.ports.getProjectsBasePath(),
            ports: {
              readDir: (dirPath) => this.options.ports.readDir(dirPath),
              stat: (filePath) => this.options.ports.stat(filePath),
            },
          }),
        getLanguage: () => this.options.ports.getLanguage(),
        info: (message) => this.options.ports.logger.info(message),
        warn: (message) => this.options.ports.logger.warn(message),
      }
    );
  }

  async cleanupCliAutoSuffixedMembers(teamName: string): Promise<void> {
    const configPath = this.getConfigPath(teamName);

    try {
      const raw = await this.readTeamConfig(configPath);
      if (raw) {
        const cleanupPlan = planCliAutoSuffixedConfigMemberCleanup(raw);
        if (cleanupPlan) {
          cleanupPlan.config.members = cleanupPlan.nextMembers;
          await this.options.ports.writeFileUtf8(
            configPath,
            JSON.stringify(cleanupPlan.config, null, 2)
          );
          this.options.ports.invalidateTeam(teamName);
          this.options.ports.logger.warn(
            `[${teamName}] Removed CLI auto-suffixed members from config.json: ${cleanupPlan.removedNames.join(', ')}`
          );
        }
      }
    } catch {
      // best-effort
    }

    let activeNamesForInboxCleanup = new Set<string>();
    try {
      const metaMembers = await this.options.ports.membersMetaStore.getMembers(teamName);
      if (metaMembers.length > 0) {
        const cleanupPlan = planCliAutoSuffixedMetaMemberCleanup(metaMembers);

        if (cleanupPlan.removedNames.length > 0) {
          await this.options.ports.membersMetaStore.writeMembers(teamName, cleanupPlan.nextMembers);
          this.options.ports.logger.warn(
            `[${teamName}] Removed CLI auto-suffixed members from members.meta.json: ${cleanupPlan.removedNames.join(', ')}`
          );
        }

        activeNamesForInboxCleanup = cleanupPlan.activeNamesForInboxCleanup;
      }
    } catch {
      // best-effort
    }

    // Also attempt inbox cleanup (merge alice-2.json into alice.json).
    if (activeNamesForInboxCleanup.size > 0) {
      try {
        await this.mergeAndRemoveDuplicateInboxes(teamName, activeNamesForInboxCleanup);
      } catch {
        // best-effort
      }
    }
  }

  async assertConfigLeadOnlyForLaunch(teamName: string): Promise<void> {
    const raw = await this.readTeamConfig(this.getConfigPath(teamName));
    assertConfigRawLeadOnlyForLaunch(raw);
  }

  async normalizeTeamConfigForLaunch(teamName: string, configRaw: string): Promise<void> {
    const configPath = this.getConfigPath(teamName);
    const backupPath = getPrelaunchConfigBackupPath(configPath);
    const normalizationPlan = planTeamConfigLaunchNormalization(configRaw);
    if (!normalizationPlan) return;

    // Try to determine base teammate names for inbox cleanup (prefer meta).
    let baseNames = new Set<string>();
    try {
      const metaMembers = await this.options.ports.membersMetaStore.getMembers(teamName);
      baseNames = collectConfigLaunchBaseNamesFromMetaMembers(metaMembers);
    } catch {
      // ignore
    }
    if (baseNames.size === 0) {
      baseNames = collectConfigLaunchBaseNamesFromConfigMembers(normalizationPlan.members);
    }

    // Backup current config on disk for crash recovery / debugging.
    try {
      await this.options.ports.writeFileUtf8(backupPath, configRaw);
    } catch (error) {
      this.options.ports.logger.warn(
        `[${teamName}] Failed to write config prelaunch backup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Write normalized config atomically.
    normalizationPlan.config.members = normalizationPlan.leadMembers;
    try {
      await this.options.ports.writeFileUtf8(
        configPath,
        JSON.stringify(normalizationPlan.config, null, 2)
      );
      this.options.ports.invalidateTeam(teamName);
      this.options.ports.logger.info(
        `[${teamName}] Normalized config.json for launch: kept ${normalizationPlan.leadMembers.length} lead member(s)`
      );
    } catch (error) {
      this.options.ports.logger.warn(
        `[${teamName}] Failed to normalize config.json for launch: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    // Best-effort: merge and remove suffixed inboxes like alice-2.json to avoid UI duplicates.
    await this.mergeAndRemoveDuplicateInboxes(teamName, baseNames);
  }

  /**
   * Restore config.json from prelaunch backup if launch fails after normalization.
   */
  async restorePrelaunchConfig(teamName: string): Promise<void> {
    const configPath = this.getConfigPath(teamName);
    const backupPath = getPrelaunchConfigBackupPath(configPath);
    try {
      const backupRaw = await this.options.ports.readRegularFileUtf8(backupPath, {
        timeoutMs: this.options.limits.teamJsonReadTimeoutMs,
        maxBytes: this.options.limits.teamConfigMaxBytes,
      });
      if (!backupRaw) {
        return;
      }
      await this.options.ports.writeFileUtf8(configPath, backupRaw);
      this.options.ports.invalidateTeam(teamName);
      this.options.ports.logger.info(
        `[${teamName}] Restored config.json from prelaunch backup after launch failure`
      );
    } catch {
      this.options.ports.logger.debug(
        `[${teamName}] No prelaunch backup to restore (or read failed)`
      );
    }
  }

  /**
   * Remove the prelaunch backup file after a successful launch.
   */
  async cleanupPrelaunchBackup(teamName: string): Promise<void> {
    const backupPath = getPrelaunchConfigBackupPath(this.getConfigPath(teamName));
    try {
      await this.options.ports.unlink(backupPath);
    } catch {
      // Backup may not exist - that's fine
    }
  }

  async mergeAndRemoveDuplicateInboxes(
    teamName: string,
    baseNames: ReadonlySet<string>
  ): Promise<void> {
    await mergeAndRemoveDuplicateInboxes({
      inboxDir: path.join(this.options.ports.getTeamsBasePath(), teamName, 'inboxes'),
      baseNames,
      timeoutMs: this.options.limits.teamJsonReadTimeoutMs,
      maxBytes: this.options.limits.teamInboxMaxBytes,
      ports: {
        readDir: (dirPath) => this.options.ports.readDir(dirPath),
        readRegularFileUtf8: (filePath, options) =>
          this.options.ports.readRegularFileUtf8(filePath, options),
        writeFileUtf8: (filePath, contents) => this.options.ports.writeFileUtf8(filePath, contents),
        unlink: (filePath) => this.options.ports.unlink(filePath),
        withCanonicalInboxLock: (filePath, fn) =>
          this.options.ports.withCanonicalInboxLock(filePath, fn),
      },
    });
  }

  async persistMembersMeta(teamName: string, request: TeamCreateRequest): Promise<void> {
    const teammateMembers = selectMembersMetaTeammates(request.members);
    if (teammateMembers.length === 0) {
      return;
    }

    const joinedAt = this.options.ports.now();

    try {
      const membersToWrite = buildMembersMetaWritePayload(
        teammateMembers.map((member) => ({
          ...member,
          joinedAt,
        }))
      );
      await this.options.ports.membersMetaStore.writeMembers(teamName, membersToWrite, {
        providerBackendId: request.providerBackendId,
      });
    } catch (error) {
      this.options.ports.logger.warn(
        `[${teamName}] Failed to persist members.meta.json: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private getConfigPath(teamName: string): string {
    return path.join(this.options.ports.getTeamsBasePath(), teamName, 'config.json');
  }

  private async readTeamConfig(configPath: string): Promise<string | null> {
    return (
      (await this.options.ports.readRegularFileUtf8(configPath, {
        timeoutMs: this.options.limits.teamJsonReadTimeoutMs,
        maxBytes: this.options.limits.teamConfigMaxBytes,
      })) ?? null
    );
  }
}
