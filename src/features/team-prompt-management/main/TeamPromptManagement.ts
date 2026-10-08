import { createHash, randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_CONFIG_READ_BYTES, TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import {
  MAX_TEAM_METADATA_BYTES,
  TeamMetadataTooLargeError,
} from '@main/services/team/TeamMetadataSerialization';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isLeadMember } from '@shared/utils/leadDetection';

import { parseTeamManagementRequest, TeamManagementError } from '../core/managementPolicy';

import type {
  TeamManagementCommittedChange,
  TeamManagementResult,
  TeamManagementTarget,
} from '../contracts';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type {
  ReplaceMembersRequest,
  TeamChangeEvent,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamMember,
  TeamRuntimeState,
  TeamViewSnapshot,
} from '@shared/types';

export interface TeamPromptManagementPorts {
  run<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
  getContext(): Promise<AppConnectionContext>;
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  getTeamData(teamName: string): Promise<TeamViewSnapshot>;
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
  updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<unknown>;
  replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void>;
  deleteTeam(teamName: string): Promise<void>;
  emit(event: TeamChangeEvent): void;
}
interface ConfigurationSnapshot {
  configurationRevision: string;
  config: Record<string, unknown> | null;
  meta: Awaited<ReturnType<TeamMetaStore['getMeta']>>;
  members: TeamMember[];
  membersMetadataPresent: boolean;
  savedRequest: TeamCreateRequest | null;
  deletedAt?: string;
}
function activeTeammates(members: TeamMember[]): TeamMember[] {
  return members.filter((member) => !member.removedAt && !isLeadMember(member));
}
function rosterShape(members: { name: string; role?: string; workflow?: string }[]) {
  return members
    .map((member) => ({
      name: member.name,
      role: member.role?.trim() || undefined,
      workflow: member.workflow?.trim() || undefined,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
/** One admitted configuration conversation, using the existing launch/roster operation gate. */
export class TeamPromptManagement {
  private readonly metaStore = new TeamMetaStore();
  private readonly membersStore = new TeamMembersMetaStore();
  constructor(private readonly ports: TeamPromptManagementPorts) {}

  private async fingerprint(teamName: string): Promise<{
    revision: string;
    config: Record<string, unknown> | null;
    membersMetadataPresent: boolean;
  }> {
    const directory = join(getTeamsBasePath(), teamName);
    let identity;
    try {
      identity = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new TeamManagementError('TEAM_NOT_FOUND', `Team not found: ${teamName}`, 404);
    }
    if (!identity.isDirectory() || identity.isSymbolicLink())
      throw new TeamManagementError('TEAM_UNSUPPORTED', 'Team must be a local directory');
    const contents = await Promise.all(
      ['config.json', 'team.meta.json', 'members.meta.json'].map((name) =>
        this.readFingerprintFile(directory, name)
      )
    );
    let config: Record<string, unknown> | null = null;
    if (contents[0] !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents[0]);
      } catch {
        throw new TeamManagementError(
          'TEAM_CONFIGURATION_UNREADABLE',
          'config.json is invalid JSON'
        );
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new TeamManagementError(
          'TEAM_CONFIGURATION_UNREADABLE',
          'config.json must contain a configuration object'
        );
      config = parsed as Record<string, unknown>;
    }
    const hash = createHash('sha256').update(
      JSON.stringify({ teamName, directory: [identity.dev, identity.ino, identity.birthtimeMs] })
    );
    for (const content of contents) {
      hash.update(content === null ? '-:' : `+${Buffer.byteLength(content, 'utf8')}:`);
      if (content !== null) hash.update(content);
    }
    const revision = hash.digest('hex');
    return { revision, config, membersMetadataPresent: contents[2] !== null };
  }

  /** A single handle bounds both initial size and bytes read if the file grows after stat. */
  private async readFingerprintFile(directory: string, name: string): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const limit = name === 'config.json' ? MAX_CONFIG_READ_BYTES : MAX_TEAM_METADATA_BYTES;
    const unreadable = () =>
      new TeamManagementError(
        name === 'members.meta.json'
          ? 'TEAM_MEMBERS_METADATA_UNREADABLE'
          : 'TEAM_CONFIGURATION_UNREADABLE',
        `${name} must be a regular file within its supported ${limit}-byte limit`
      );
    try {
      const filePath = join(directory, name);
      const preflight = await lstat(filePath);
      if (!preflight.isFile() || preflight.size > limit) throw unreadable();
      handle = await open(filePath, 'r');
      const before = await handle.stat();
      if (!before.isFile() || before.size > limit) throw unreadable();
      const bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      if (length > limit || after.size > limit) throw unreadable();
      if (length !== before.size || after.size !== before.size)
        throw new TeamManagementError(
          'TEAM_CONFIGURATION_CHANGED',
          'Configuration changed during read'
        );
      return bytes.subarray(0, length).toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async read(teamName: string): Promise<ConfigurationSnapshot> {
    const before = await this.fingerprint(teamName);
    const [meta, membersMeta, savedRequest] = await Promise.all([
      this.metaStore.getMeta(teamName),
      this.membersStore.getMeta(teamName),
      this.ports.getSavedRequest(teamName),
    ]);
    if (before.membersMetadataPresent && !membersMeta)
      throw new TeamManagementError(
        'TEAM_MEMBERS_METADATA_UNREADABLE',
        'Saved member metadata is unreadable. Repair it before changing configuration'
      );
    if (!before.config && !meta)
      throw new TeamManagementError('TEAM_UNSUPPORTED', 'No supported saved team configuration');
    const after = await this.fingerprint(teamName);
    if (before.revision !== after.revision)
      throw new TeamManagementError(
        'TEAM_CONFIGURATION_CHANGED',
        'Configuration changed during read. Get a fresh snapshot'
      );
    return {
      configurationRevision: after.revision,
      config: after.config,
      meta,
      members: membersMeta?.members ?? [],
      membersMetadataPresent: after.membersMetadataPresent,
      savedRequest,
      deletedAt:
        typeof after.config?.deletedAt === 'string' ? after.config.deletedAt : meta?.deletedAt,
    };
  }

  async get(teamName: string): Promise<
    (
      | TeamViewSnapshot
      | {
          teamName: string;
          pendingCreate: true;
          savedRequest: TeamCreateRequest | null;
          deletedAt?: string;
        }
    ) & { configurationRevision: string; savedRequest: TeamCreateRequest | null }
  > {
    return this.ports.run(teamName, async () => {
      const snapshot = await this.read(teamName);
      const data = snapshot.config
        ? await this.ports.getTeamData(teamName)
        : {
            teamName,
            pendingCreate: true as const,
            savedRequest: snapshot.savedRequest,
            deletedAt: snapshot.deletedAt,
          };
      const runtime = await this.ports.getRuntimeState(teamName);
      if ((await this.fingerprint(teamName)).revision !== snapshot.configurationRevision)
        throw new TeamManagementError(
          'TEAM_CONFIGURATION_CHANGED',
          'Configuration changed during read'
        );
      return {
        ...data,
        isAlive: runtime.isAlive,
        savedRequest: snapshot.savedRequest,
        configurationRevision: snapshot.configurationRevision,
      };
    });
  }

  /** Keeps HTTP draft read/rename/launch admission inside the same operation as saved edits. */
  async runLaunch<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.ports.run(teamName, async () => {
      const snapshot = await this.read(teamName);
      if (snapshot.deletedAt)
        throw new TeamManagementError('TEAM_TRASHED', 'Restore the team before launch');
      return operation();
    });
  }

  private async admit(
    target: TeamManagementTarget,
    allowTrashed: boolean
  ): Promise<ConfigurationSnapshot> {
    const runtime = await this.ports.getRuntimeState(target.teamName);
    if (
      runtime.progress &&
      !['ready', 'failed', 'cancelled', 'disconnected'].includes(runtime.progress.state)
    )
      throw new TeamManagementError(
        'TEAM_PROVISIONING',
        'Wait for provisioning to finish before changing configuration'
      );
    if (runtime.isAlive)
      throw new TeamManagementError(
        'TEAM_ACTIVE',
        'Stop the team in the app before changing configuration'
      );
    const snapshot = await this.read(target.teamName);
    if (snapshot.configurationRevision !== target.expectedRevision)
      throw new TeamManagementError('TEAM_REVISION_MISMATCH', 'Get the team again before editing');
    if (!allowTrashed && snapshot.deletedAt)
      throw new TeamManagementError('TEAM_TRASHED', 'Restore the team in the app before editing');
    return snapshot;
  }

  private emit(teamName: string, change: TeamManagementCommittedChange): void {
    try {
      TeamConfigReader.invalidateTeam(teamName);
      this.ports.emit({ type: 'config', teamName, detail: 'config.json', management: change });
    } catch {
      // Persistence success does not depend on observer delivery.
    }
  }

  private async finish(
    teamName: string,
    context: AppConnectionContext,
    kind: TeamManagementCommittedChange['kind'],
    changedFields: TeamManagementCommittedChange['changedFields'],
    roster?: TeamManagementCommittedChange['roster'],
    readback?: ConfigurationSnapshot
  ): Promise<TeamManagementResult> {
    readback ??= await this.read(teamName);
    if (!changedFields.length)
      return { teamName, changed: false, configurationRevision: readback.configurationRevision };
    const change: TeamManagementCommittedChange = {
      operationId: randomUUID(),
      committedAt: new Date().toISOString(),
      kind,
      changedFields,
      ...(roster ? { roster } : {}),
      context,
    };
    this.emit(teamName, change);
    return {
      teamName,
      changed: true,
      configurationRevision: readback.configurationRevision,
      change,
    };
  }

  private async writeAndVerify(
    teamName: string,
    operation: () => Promise<void>,
    verify: (readback: ConfigurationSnapshot) => boolean
  ): Promise<ConfigurationSnapshot> {
    try {
      await operation();
      const readback = await this.read(teamName);
      if (!verify(readback))
        throw new Error('Committed configuration does not match the requested edit');
      return readback;
    } catch (error) {
      if (error instanceof TeamMetadataTooLargeError)
        throw new TeamManagementError(error.code, error.message, error.statusCode);
      let readback: ConfigurationSnapshot | null = null;
      try {
        readback = await this.read(teamName);
      } catch {
        /* Cannot claim a complete commit without readback. */
      }
      if (readback && verify(readback)) return readback;
      throw new TeamManagementError(
        'TEAM_MUTATION_UNCERTAIN',
        error instanceof Error ? error.message : 'Read back the team before retrying',
        409,
        {
          state: readback ? 'partial' : 'uncertain',
          ...(readback ? { configurationRevision: readback.configurationRevision } : {}),
        }
      );
    }
  }

  async update(teamName: string, body: unknown): Promise<TeamManagementResult> {
    const target = parseTeamManagementRequest(teamName, body, true);
    return this.ports.withExpectedContext(target.expectedContext, () =>
      this.ports.run(teamName, async () => {
        const snapshot = await this.admit(target, false);
        let committed = snapshot;
        const changedFields: TeamManagementCommittedChange['changedFields'] = [];
        let roster: TeamManagementCommittedChange['roster'];
        if (target.metadata) {
          const patch = target.metadata;
          for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
            const current = snapshot.config
              ? snapshot.config[key === 'displayName' ? 'name' : key]
              : snapshot.meta?.[key];
            if (
              (typeof current === 'string' ? current.trim() : '') !== patch[key] ||
              (snapshot.meta && (snapshot.meta[key] ?? '') !== patch[key])
            )
              changedFields.push(key);
          }
          if (changedFields.length)
            committed = await this.writeAndVerify(
              teamName,
              async () => {
                if (snapshot.config)
                  await this.ports.updateConfig(teamName, {
                    ...(patch.displayName !== undefined ? { name: patch.displayName } : {}),
                    ...(patch.description !== undefined ? { description: patch.description } : {}),
                    ...(patch.color !== undefined ? { color: patch.color } : {}),
                  });
                else
                  await this.metaStore.updateMeta(teamName, (meta) => {
                    if (!meta) throw new Error('Saved configuration disappeared');
                    return { ...meta, ...patch };
                  });
              },
              (readback) =>
                Object.keys(patch).every((key) => {
                  const field = key as keyof typeof patch;
                  const actual = readback.config
                    ? readback.config[field === 'displayName' ? 'name' : field]
                    : readback.meta?.[field];
                  const saved = readback.meta?.[field];
                  return (
                    (actual ?? '') === patch[field] &&
                    (!readback.meta || (saved ?? '') === patch[field])
                  );
                })
            );
        } else if (target.leadInstructions !== undefined) {
          if (!snapshot.meta || !snapshot.savedRequest)
            throw new TeamManagementError(
              'TEAM_UNSUPPORTED',
              'This imported team has no saved launch request'
            );
          if ((snapshot.meta.prompt ?? '') !== target.leadInstructions) {
            changedFields.push('leadInstructions');
            committed = await this.writeAndVerify(
              teamName,
              () =>
                this.metaStore.updateMeta(teamName, (meta) => {
                  if (!meta) throw new Error('Saved configuration disappeared');
                  return { ...meta, prompt: target.leadInstructions };
                }),
              (readback) => (readback.meta?.prompt ?? '') === target.leadInstructions
            );
          }
        } else if (target.members) {
          if (snapshot.config && !snapshot.membersMetadataPresent)
            throw new TeamManagementError(
              'TEAM_ROSTER_METADATA_MISSING',
              'This stopped team has no authoritative member metadata for safe roster replacement'
            );
          const previous = activeTeammates(snapshot.members);
          if (!snapshot.meta)
            throw new TeamManagementError(
              'TEAM_UNSUPPORTED',
              'This imported team has no authoritative editable roster'
            );
          if (
            JSON.stringify(rosterShape(previous)) !== JSON.stringify(rosterShape(target.members))
          ) {
            changedFields.push('members');
            const byName = new Map(previous.map((member) => [member.name.toLowerCase(), member]));
            const merged = target.members.map((member) => ({
              ...byName.get(member.name.toLowerCase()),
              ...member,
              role: member.role,
              workflow: member.workflow,
            }));
            const names = new Set(target.members.map((member) => member.name.toLowerCase()));
            const added = target.members.filter((member) => !byName.has(member.name.toLowerCase()));
            const removed = previous.filter((member) => !names.has(member.name.toLowerCase()));
            roster = {
              before: previous.length,
              after: target.members.length,
              added: added.length,
              removed: removed.length,
              names: [...added, ...removed].slice(0, 3).map((member) => member.name),
            };
            committed = await this.writeAndVerify(
              teamName,
              () => this.ports.replaceMembers(teamName, { members: merged }),
              (readback) =>
                JSON.stringify(rosterShape(activeTeammates(readback.members))) ===
                JSON.stringify(rosterShape(target.members!))
            );
          }
        }
        return this.finish(
          teamName,
          target.expectedContext,
          'edited',
          changedFields,
          roster,
          committed
        );
      })
    );
  }

  async trash(teamName: string, body: unknown): Promise<TeamManagementResult> {
    const target = parseTeamManagementRequest(teamName, body, false);
    return this.ports.withExpectedContext(target.expectedContext, () =>
      this.ports.run(teamName, async () => {
        const snapshot = await this.admit(target, true);
        if (snapshot.deletedAt)
          return this.finish(teamName, target.expectedContext, 'trashed', [], undefined, snapshot);
        const committed = await this.writeAndVerify(
          teamName,
          () => this.ports.deleteTeam(teamName),
          (readback) => Boolean(readback.deletedAt)
        );
        return this.finish(
          teamName,
          target.expectedContext,
          'trashed',
          ['deletedAt'],
          undefined,
          committed
        );
      })
    );
  }

  async create(
    request: TeamCreateConfigRequest,
    expectedContext?: AppConnectionContext
  ): Promise<TeamManagementResult> {
    const operation = () =>
      this.ports.run(request.teamName, async () => {
        const context = expectedContext ?? (await this.ports.getContext());
        await this.ports.createTeamConfig(request);
        let committed: ConfigurationSnapshot;
        try {
          committed = await this.read(request.teamName);
        } catch {
          throw new TeamManagementError(
            'TEAM_MUTATION_UNCERTAIN',
            'Draft saved but readback failed. Get the original teamName before retrying',
            409,
            { state: 'uncertain' }
          );
        }
        return this.finish(
          request.teamName,
          context,
          'created',
          [
            ...(['displayName', 'description', 'color'] as const).filter(
              (key) => request[key] !== undefined
            ),
            ...(request.prompt ? ['leadInstructions' as const] : []),
            'members',
          ],
          {
            before: 0,
            after: request.members.length,
            added: request.members.length,
            removed: 0,
            names: request.members.slice(0, 3).map((member) => member.name),
          },
          committed
        );
      });
    return expectedContext
      ? this.ports.withExpectedContext(expectedContext, operation)
      : operation();
  }
}
