import { createImportPublication } from './importPublication.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, parse } from 'node:path';
import { TeamOwnerError } from '../team/contracts.js';
import { digest, effectId } from '../team/identity.js';
import { createFilesystemTeamOwner } from '../adapters/team/createFilesystemTeamOwner.js';
import { withTeamFileFence, writeTeamJson } from '../adapters/team/ControllerAdapter.js';
import { admitRegistryTeamNamespace } from '../adapters/team-registry/admitRegistryTeamNamespace.js';
import { hostedTeamDefinitionSchema } from '../team-registry/definition.js';
import { teamRegistryRecordSchema } from '../team-registry/contracts.js';
import { importedReferenceTeam, qualifyImportReferences } from './references.js';
import { importRequestSchema, snapshotHeaderSchema } from './contracts.js';
import {
  readImportedTaskAttachment,
  readImportedMessageAttachment,
} from '../attachments/readImportedTaskAttachment.js';
import {
  plainImportAncestors,
  readImportBytes,
  safeImportPath,
  snapshotJson,
  validateStoppedSnapshot,
} from './snapshot.js';
import type {
  StoppedTeamSnapshot,
  StoppedTeamImportRequest,
  StoppedImportContext,
} from './contracts.js';
import type { HostedTeamDefinition } from '../team-registry/definition.js';
import type { TeamRegistryRecord } from '../team-registry/contracts.js';

interface ProductFile {
  path: string;
  base64: string;
  sha256: string;
}
interface ImportIntent {
  schemaVersion: 1;
  ownerId: string;
  profileId: string;
  principalId: string;
  commandId: string;
  fingerprint: string;
  request: StoppedTeamImportRequest;
  snapshot: StoppedTeamSnapshot;
  definition: HostedTeamDefinition;
  record: TeamRegistryRecord;
  files: ProductFile[];
  phase: 'prepared' | 'installed' | 'published';
}
export interface StoppedImportReceipt {
  commandId: string;
  phase: 'held' | 'published';
  record: TeamRegistryRecord;
  source: { sourceId: string; snapshotDigest: string };
}
export interface StoppedImportOptions {
  root: string;
  ownerId: string;
  profileId: string;
  principalId: string;
  contextIds: readonly string[];
  assertWriter(): void;
  /** Trusted final lifecycle storage maintenance only; never import/read/tool admission. */
  assertLifecycleWriter?(): void;
  /** Registry create and import share this authority fence and collision inventory. */
  existingRecords(): readonly Pick<TeamRegistryRecord, 'teamId' | 'teamName'>[];
  /** Required: bind exact internal/archive/gap navigation before imported handle discovery. */
  bindOrigin(record: TeamRegistryRecord, context: StoppedImportContext): void;
  /** Pure save-only admission: exact supported product shape, target scope and no delivery.
   * Recipe/account/native availability belongs to a later explicit Launch, not data transfer. */
  validateConfiguration(definition: HostedTeamDefinition): void;
  attach(definition: HostedTeamDefinition): void;
  isRetired?(definition: HostedTeamDefinition): boolean;
}
const hold = (): never => {
  throw new TeamOwnerError('hold');
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Detached import only. Original immutable intent includes every byte/map before destination writes. */
export class FileStoppedTeamImport {
  private readonly directory: string;
  constructor(private readonly options: StoppedImportOptions) {
    plainImportAncestors(options.root);
    this.directory = join(options.root, '.host-team-registry', 'imports');
  }
  private authorize(contextId: string, retained = false): void {
    if (retained && this.options.assertLifecycleWriter) this.options.assertLifecycleWriter();
    else this.options.assertWriter();
    if (!this.options.contextIds.includes(contextId)) throw new TeamOwnerError('forbidden');
  }
  private ensure(directory: string): void {
    let part = parse(directory).root;
    for (const name of directory.slice(part.length).split('/').filter(Boolean)) {
      part = join(part, name);
      try {
        const stat = lstatSync(part);
        if (!stat.isDirectory() || stat.isSymbolicLink()) hold();
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          !part.startsWith(`${this.options.root}/`)
        )
          throw error;
        this.options.assertWriter();
        mkdirSync(part, { mode: 0o700 });
      }
    }
    plainImportAncestors(directory);
  }
  private fenced<T>(action: () => T): T {
    this.options.assertWriter();
    this.ensure(this.directory);
    return withTeamFileFence(join(this.options.root, '.host-team-registry', 'authority'), () => {
      this.options.assertWriter();
      plainImportAncestors(this.directory);
      return action();
    });
  }
  private path(commandId: string): string {
    if (!commandId || commandId.length > 256 || commandId.includes('\0'))
      throw new TeamOwnerError('invalid');
    return join(this.directory, `${digest(commandId)}.json`);
  }
  private read(commandId: string, retained = false): ImportIntent | undefined {
    const path = this.path(commandId);
    try {
      plainImportAncestors(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 192 * 1024 * 1024) hold();
    const value = JSON.parse(
      readImportBytes(path, 192 * 1024 * 1024).toString('utf8')
    ) as ImportIntent;
    if (
      value.commandId !== commandId ||
      value.schemaVersion !== 1 ||
      value.ownerId !== this.options.ownerId ||
      value.profileId !== this.options.profileId ||
      value.principalId !== this.options.principalId ||
      !['prepared', 'installed', 'published'].includes(value.phase)
    )
      hold();
    this.authorize(value.request.contextId, retained);
    const expected = this.prepare(
      commandId,
      value.request,
      validateStoppedSnapshot(value.snapshot)
    );
    if (
      value.fingerprint !== expected.fingerprint ||
      digest(value.definition) !== digest(expected.definition) ||
      digest(value.record) !== digest(expected.record) ||
      digest(value.files) !== digest(expected.files)
    )
      hold();
    return value;
  }
  private receipt(intent: ImportIntent, held = false): StoppedImportReceipt {
    return structuredClone({
      commandId: intent.commandId,
      phase: held ? 'held' : 'published',
      record: intent.record,
      source: { sourceId: intent.request.sourceId, snapshotDigest: intent.request.snapshotDigest },
    });
  }
  private prepare(
    commandId: string,
    request: StoppedTeamImportRequest,
    snapshot: StoppedTeamSnapshot
  ): ImportIntent {
    if (
      !commandId ||
      commandId.length > 256 ||
      commandId.includes('\0') ||
      request.snapshotDigest !== snapshot.digest ||
      request.sourceId !== snapshot.header.sourceId
    )
      throw new TeamOwnerError('invalid');
    const identity = [
      this.options.ownerId,
      this.options.profileId,
      this.options.principalId,
      commandId,
      snapshot.digest,
    ];
    const teamId = effectId('stopped-import-team', ...identity),
      handleId = effectId('stopped-import-handle', ...identity);
    const scope = {
      projectId: request.contextId,
      workspaceId: request.contextId,
      teamId,
      runId: effectId('stopped-import-idle', ...identity),
      memberId: 'user',
      generation: '1',
    };
    const definition = hostedTeamDefinitionSchema.parse({
      scope,
      binding: {
        backendId: this.options.ownerId,
        teamId,
        teamName: request.teamName,
      },
      savedSettings: qualifyImportReferences(
        snapshot.header.savedSettings,
        snapshot,
        request.teamName
      ),
      members: qualifyImportReferences(snapshot.header.members, snapshot, request.teamName),
      grants: [
        {
          principalId: this.options.principalId,
          memberName: 'user',
          permissions: ['read', 'task.write', 'message.write', 'process.write', 'admin'],
        },
      ],
    });
    const { displayName, description, color } = snapshot.header.savedSettings;
    const record = teamRegistryRecordSchema.parse({
      contextId: request.contextId,
      teamId,
      teamName: request.teamName,
      ...(displayName === undefined ? {} : { displayName }),
      ...(description === undefined ? {} : { description }),
      ...(color === undefined ? {} : { color }),
      members: definition.members.map((member) => ({
        memberId: member.memberId,
        label: member.name,
      })),
      binding: { schemaVersion: 1, handleId, scope },
    });
    const team = `teams/${request.teamName}`,
      metadata = `${team}/.host-owner/import`;
    if (
      Buffer.byteLength(
        JSON.stringify({ references: snapshot.references, gaps: snapshot.header.gaps })
      ) >
      256 * 1024
    )
      hold();
    const files: ProductFile[] = [];
    const add = (path: string, bytes: Uint8Array) =>
      files.push({
        path: safeImportPath(path),
        base64: Buffer.from(bytes).toString('base64'),
        sha256: sha(bytes),
      });
    const blobPaths = new Map(
      snapshot.blobs.map((blob) => [
        blob.originalPath,
        `${metadata}/blobs/${blob.category}/${blob.path}`,
      ])
    );
    const rewriteBlobs = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewriteBlobs);
      if (!value || typeof value !== 'object') return value;
      const row = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(row).map(([key, item]) => [
          key,
          key === 'filePath' &&
          typeof item === 'string' &&
          typeof row.filename === 'string' &&
          typeof row.mimeType === 'string'
            ? join(this.options.root, blobPaths.get(item) ?? hold())
            : rewriteBlobs(item),
        ])
      );
    };
    for (const file of snapshot.files) {
      if (file.disposition === 'excluded') continue;
      const bytes = Buffer.from(file.base64!, 'base64');
      let target: string;
      if (file.category === 'tasks' && file.disposition === 'product')
        target = `tasks/${request.teamName}/${file.path}`;
      else if (file.category === 'team' && file.disposition === 'product')
        target = `${team}/${file.path}`;
      else if (file.category === 'attachments' || file.category === 'task-attachments')
        target = `${metadata}/blobs/${file.category}/${file.path}`;
      else target = `${metadata}/archive/${file.category}/${file.path}`;
      let product =
        file.disposition === 'product' && file.path.endsWith('.json')
          ? rewriteBlobs(qualifyImportReferences(snapshotJson(file), snapshot, request.teamName))
          : undefined;
      if (file.category === 'team' && file.path === 'kanban-state.json') {
        const board = product as Record<string, unknown>;
        if (board.teamName !== snapshot.header.sourceTeamName) hold();
        product = { ...board, teamName: request.teamName };
      }
      add(target, product === undefined ? bytes : Buffer.from(JSON.stringify(product)));
    }
    // Every original body/reference remains source-qualified via this exact import map.
    add(
      `${metadata}/source.json`,
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          sourceOwnerId: snapshot.header.sourceOwnerId,
          sourceId: snapshot.header.sourceId,
          sourceTeamName: snapshot.header.sourceTeamName,
          sourceRevision: snapshot.header.sourceRevision,
          snapshotDigest: snapshot.digest,
          destination: record.binding,
          gaps: snapshot.header.gaps,
          references: snapshot.references.map((ref) => ({
            ...ref,
            canonicalTeamName: importedReferenceTeam(snapshot, ref, request.teamName),
            target:
              ref.target === 'internal'
                ? {
                    kind: 'destination',
                    handleId,
                    teamId,
                    teamName: request.teamName,
                    taskId: ref.taskId,
                  }
                : ref.target === 'source-archive'
                  ? {
                      kind: 'archive',
                      ownerId: snapshot.header.sourceOwnerId,
                      teamName: ref.teamName,
                      taskId: ref.taskId,
                    }
                  : {
                      kind: 'gap',
                      ownerId: snapshot.header.sourceOwnerId,
                      teamName: ref.teamName,
                      taskId: ref.taskId,
                    },
          })),
          blobs: snapshot.blobs.map((blob) => ({
            ...blob,
            destination: blobPaths.get(blob.originalPath),
          })),
          census: snapshot.files.map(({ base64: _base64, ...file }) => file),
          roots: snapshot.roots,
        })
      )
    );
    if (new Set(files.map((file) => file.path)).size !== files.length)
      throw new TeamOwnerError('conflict');
    return {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      profileId: this.options.profileId,
      principalId: this.options.principalId,
      commandId,
      fingerprint: digest({ ...request, commandId, identity }),
      request,
      snapshot,
      definition,
      record,
      files,
      phase: 'prepared',
    };
  }
  private bindOrigin(intent: ImportIntent): void {
    const { header, references, digest: snapshotDigest } = intent.snapshot;
    this.options.bindOrigin(
      structuredClone(intent.record),
      structuredClone({
        sourceOwnerId: header.sourceOwnerId,
        sourceId: header.sourceId,
        sourceTeamName: header.sourceTeamName,
        snapshotDigest,
        references: references.map((ref) => ({
          ...ref,
          canonicalTeamName: importedReferenceTeam(intent.snapshot, ref, intent.record.teamName),
        })),
        gaps: header.gaps,
      })
    );
  }
  /** Post-publication state may evolve, but loss/replacement never authorizes recreation. */
  private verifyPublished(intent: ImportIntent): void {
    const team = join(this.options.root, 'teams', intent.record.teamName);
    plainImportAncestors(join(team, '.host-owner', 'import'));
    const state = JSON.parse(
      readImportBytes(join(team, '.host-owner/state.json'), 1024 * 1024).toString('utf8')
    ) as { binding?: unknown; ready?: unknown };
    if (state.ready !== true || digest(state.binding) !== digest(intent.definition.binding)) hold();
    const origin =
      intent.files.find((file) => file.path.endsWith('/.host-owner/import/source.json')) ?? hold();
    if (
      sha(readImportBytes(join(this.options.root, origin.path), 20 * 1024 * 1024)) !== origin.sha256
    )
      hold();
  }
  private isPublished(intent: ImportIntent): boolean {
    if (intent.phase !== 'published') return false;
    try {
      this.verifyPublished(intent);
      return true;
    } catch {
      return false;
    }
  }
  private install(intent: ImportIntent): void {
    if (this.options.isRetired?.(intent.definition)) hold();
    const root = this.options.root,
      definition = intent.definition,
      removedMembers =
        intent.snapshot.header.removedMembers === undefined
          ? undefined
          : snapshotHeaderSchema.shape.removedMembers.parse(
              qualifyImportReferences(
                intent.snapshot.header.removedMembers,
                intent.snapshot,
                intent.record.teamName
              )
            );
    const marker = join(root, 'teams', definition.binding.teamName, '.host-owner/state.json');
    if (intent.phase === 'published') {
      this.verifyPublished(intent);
      this.bindOrigin(intent);
      this.options.attach(structuredClone(definition));
      return;
    }
    admitRegistryTeamNamespace(root, definition.binding, false, false);
    createFilesystemTeamOwner({
      root,
      binding: definition.binding,
      members: definition.members.map(({ memberId, name, role, settings }) => ({
        memberId,
        name,
        role,
        ...(settings === undefined ? {} : { settings }),
      })),
      savedSettings: definition.savedSettings!,
      ...(removedMembers === undefined ? {} : { removedMembers }),
      grants: definition.grants.map(({ principalId, memberName, permissions }) => ({
        principalId,
        memberName,
        permissions,
      })),
    });
    for (const file of intent.files) {
      this.options.assertWriter();
      const path = join(root, file.path),
        parent = path.slice(0, path.lastIndexOf('/'));
      this.ensure(parent);
      try {
        const existing = lstatSync(path);
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          sha(readImportBytes(path, 20 * 1024 * 1024)) !== file.sha256
        )
          hold();
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Complete private candidate precedes no-overwrite hard-link publication; crash remnants stay retained.
      const candidate = join(this.directory, `.candidate-${randomUUID()}`),
        fd = openSync(candidate, 'wx', 0o600);
      try {
        writeFileSync(fd, Buffer.from(file.base64, 'base64'));
      } finally {
        closeSync(fd);
      }
      linkSync(candidate, path);
      unlinkSync(candidate);
    }
    for (const file of intent.files)
      if (sha(readImportBytes(join(root, file.path), 20 * 1024 * 1024)) !== file.sha256) hold();
    const expected = new Set([
      ...intent.files.map((file) => file.path),
      `teams/${definition.binding.teamName}/config.json`,
      `teams/${definition.binding.teamName}/.host-owner/state.json`,
    ]);
    const census = (directory: string): void => {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) hold();
      for (const name of readdirSync(directory)) {
        const path = join(directory, name),
          relative = path.slice(root.length + 1),
          stat = lstatSync(path);
        if (stat.isSymbolicLink()) hold();
        if (stat.isDirectory()) {
          if (![...expected].some((file) => file.startsWith(`${relative}/`))) hold();
          census(path);
        } else if (!stat.isFile() || !expected.has(relative)) hold();
      }
    };
    census(join(root, 'teams', definition.binding.teamName));
    if (intent.files.some((file) => file.path.startsWith(`tasks/${definition.binding.teamName}/`)))
      census(join(root, 'tasks', definition.binding.teamName));
    const state = JSON.parse(readImportBytes(marker, 1024 * 1024).toString('utf8')) as unknown;
    const expectedState = {
      schemaVersion: 1,
      binding: definition.binding,
      members: definition.members,
      ...(removedMembers === undefined ? {} : { removedMembers }),
      grants: definition.grants.map((grant) => ({ ...grant, revision: 1 })),
      ready: true,
      // This destination is a new product-only owner, never the imported source Runtime.
      runtimeNeverLaunched: true,
      savedSettings: definition.savedSettings,
    };
    if (digest(state) !== digest(expectedState)) hold();
    const config = JSON.parse(
      readImportBytes(
        join(root, 'teams', definition.binding.teamName, 'config.json'),
        1024 * 1024
      ).toString('utf8')
    ) as unknown;
    if (
      digest(config) !==
      digest({
        name: definition.binding.teamName,
        savedSettings: definition.savedSettings,
        members: definition.members.map((member) => ({
          ...member.settings,
          name: member.name,
          ...(member.settings === undefined ? {} : { role: member.role }),
          agentType: member.role === 'lead' ? 'team-lead' : 'general-purpose',
        })),
      })
    )
      hold();
    intent.phase = 'installed';
    this.options.assertWriter();
    writeTeamJson(this.path(intent.commandId), intent);
    this.bindOrigin(intent);
    this.options.attach(structuredClone(definition)); // Still unpublished: attaches only the same initialized owner, never a Runtime.
    intent.phase = 'published';
    this.options.assertWriter();
    writeTeamJson(this.path(intent.commandId), intent);
  }
  import(commandId: string, raw: unknown, detached: StoppedTeamSnapshot): StoppedImportReceipt {
    const request = importRequestSchema.parse(raw),
      snapshot = validateStoppedSnapshot(detached);
    this.authorize(request.contextId);
    return this.fenced(() => {
      const existing = this.read(commandId),
        prepared = this.prepare(commandId, request, snapshot);
      if (existing && existing.fingerprint !== prepared.fingerprint)
        throw new TeamOwnerError('conflict');
      const intent = existing ?? prepared;
      if (!existing) {
        this.options.validateConfiguration(structuredClone(intent.definition));
        const existingRecords = this.options.existingRecords(),
          imports = this.readAll();
        if (existingRecords.length + imports.length >= 256) hold();
        if (
          existingRecords.some(
            (row) =>
              row.teamName.toLowerCase() === request.teamName.toLowerCase() ||
              row.teamId === intent.definition.binding.teamId
          ) ||
          imports.some(
            (row) => row.request.teamName.toLowerCase() === request.teamName.toLowerCase()
          )
        )
          throw new TeamOwnerError('conflict');
        admitRegistryTeamNamespace(this.options.root, intent.definition.binding, true, false);
        if (Buffer.byteLength(JSON.stringify(intent)) > 192 * 1024 * 1024) hold();
        this.options.assertWriter();
        writeTeamJson(this.path(commandId), intent);
      }
      try {
        this.install(intent);
        return this.receipt(intent);
      } catch {
        const observed = this.read(commandId)!;
        return this.receipt(observed, !this.isPublished(observed));
      }
    });
  }
  retry(commandId: string, contextId: string): StoppedImportReceipt | null {
    this.authorize(contextId);
    return this.fenced(() => {
      const intent = this.read(commandId);
      if (!intent) return null;
      if (intent.request.contextId !== contextId) throw new TeamOwnerError('forbidden');
      try {
        this.install(intent);
        return this.receipt(intent);
      } catch {
        const observed = this.read(commandId)!;
        return this.receipt(observed, !this.isPublished(observed));
      }
    });
  }
  /** Reconnects committed products only. Incomplete imports require the original explicit retry. */
  attachPublished(): void {
    for (const intent of this.readAll())
      if (intent.phase === 'published') {
        try {
          this.install(intent);
        } catch {
          /* Retain debt; catalog reports held without recreation. */
        }
      }
  }
  readOrigin(teamId: string, contextId: string): StoppedImportContext | null {
    this.authorize(contextId);
    const intent = this.readAll().find(
      (row) => row.record.teamId === teamId && row.request.contextId === contextId
    );
    if (!intent) return null;
    if (!this.isPublished(intent)) hold();
    const { header, references, digest: snapshotDigest } = intent.snapshot;
    return structuredClone({
      sourceOwnerId: header.sourceOwnerId,
      sourceId: header.sourceId,
      sourceTeamName: header.sourceTeamName,
      snapshotDigest,
      references: references.map((ref) => ({
        ...ref,
        canonicalTeamName: importedReferenceTeam(intent.snapshot, ref, intent.record.teamName),
      })),
      gaps: header.gaps,
    });
  }
  /** Trusted lifecycle composition only; caller supplies the original exact Team owner fence. */
  publication(teamId: string, withTeamFence: <T>(operation: () => T) => T) {
    const found = this.readAll(true).filter((intent) => intent.record.teamId === teamId);
    if (!found.length) return undefined;
    if (found.length !== 1 || found[0]!.phase !== 'published') return hold();
    const intent = found[0]!;
    return createImportPublication({
      root: this.options.root,
      binding: intent.definition.binding,
      commandId: intent.commandId,
      sourceId: intent.request.sourceId,
      snapshotDigest: intent.request.snapshotDigest,
      files: intent.files,
      withTeamFence,
      assertCurrent: () => {
        if (this.options.assertLifecycleWriter) this.options.assertLifecycleWriter();
        else this.options.assertWriter();
        const retained = this.read(intent.commandId, true);
        if (
          !retained ||
          retained.phase !== 'published' ||
          retained.fingerprint !== intent.fingerprint
        )
          hold();
        const state = JSON.parse(
          readImportBytes(
            join(this.options.root, 'teams', intent.record.teamName, '.host-owner/state.json'),
            1024 * 1024
          ).toString('utf8')
        ) as { ready?: unknown; binding?: unknown };
        if (state.ready !== true || digest(state.binding) !== digest(intent.definition.binding))
          hold();
      },
    });
  }
  readTaskAttachment(teamId: string, currentTask: unknown, payload: unknown) {
    const found = this.readAll().filter((intent) => intent.record.teamId === teamId);
    if (found.length !== 1) return hold();
    const intent = found[0]!;
    const assertCurrent = () => {
      this.authorize(intent.request.contextId);
      if (!this.isPublished(intent)) hold();
    };
    assertCurrent();
    const authority = {
      root: this.options.root,
      teamName: intent.record.teamName,
      task: currentTask,
      files: intent.files,
      gaps: intent.snapshot.header.gaps,
      assertCurrent,
    };
    if (payload && typeof payload === 'object' && 'messageMode' in payload) {
      const { messageMode, ...input } = payload as Record<string, unknown>;
      return readImportedMessageAttachment(authority, input, messageMode === 'list');
    }
    return readImportedTaskAttachment(authority, payload);
  }
  listImports(contextId: string): StoppedImportReceipt[] {
    this.authorize(contextId);
    return this.readAll()
      .filter((row) => row.request.contextId === contextId)
      .map((row) => this.receipt(row, !this.isPublished(row)));
  }
  catalog() {
    const intents = this.readAll();
    return {
      teams: intents
        .filter((row) => this.options.isRetired?.(row.definition) || this.isPublished(row))
        .map((row) => structuredClone(row.record)),
      held: intents
        .filter((row) => !this.options.isRetired?.(row.definition) && !this.isPublished(row))
        .map((row) => ({
          commandId: row.commandId,
          phase: 'held' as const,
          record: structuredClone(row.record),
        })),
    };
  }
  private readAll(retained = false): ImportIntent[] {
    if (retained && this.options.assertLifecycleWriter) this.options.assertLifecycleWriter();
    else this.options.assertWriter();
    plainImportAncestors(this.options.root);
    let names: string[];
    try {
      plainImportAncestors(this.directory);
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    plainImportAncestors(this.directory);
    for (const name of names) {
      const info = lstatSync(join(this.directory, name));
      if (!info.isFile() || info.isSymbolicLink()) hold();
    }
    const records = names.filter(
      (name) => !name.startsWith('.candidate-') && !name.startsWith('.tmp.')
    );
    if (records.length > 256 || names.length > 8192) hold();
    return records.map((name) => {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) return hold();
      const record = JSON.parse(
        readImportBytes(join(this.directory, name), 192 * 1024 * 1024).toString('utf8')
      ) as ImportIntent;
      if (`${digest(record.commandId)}.json` !== name) return hold();
      return this.read(record.commandId, retained)!;
    });
  }
  lookup(
    commandId: string,
    contextId: string,
    expected?: StoppedTeamImportRequest
  ): StoppedImportReceipt | null {
    this.authorize(contextId);
    const intent = this.read(commandId);
    if (!intent) return null;
    if (intent.request.contextId !== contextId) throw new TeamOwnerError('forbidden');
    if (
      expected !== undefined &&
      digest(importRequestSchema.parse(expected)) !== digest(intent.request)
    )
      throw new TeamOwnerError('conflict');
    return this.receipt(intent, !this.isPublished(intent));
  }
  records(contextId?: string): TeamRegistryRecord[] {
    if (contextId !== undefined) this.authorize(contextId);
    return this.readAll()
      .filter(
        (row) =>
          this.isPublished(row) && (contextId === undefined || row.request.contextId === contextId)
      )
      .map((row) => structuredClone(row.record));
  }
}
