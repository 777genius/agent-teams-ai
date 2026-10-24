import { reviewMethodKind } from '../team/reviewMethodKind.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, relative, isAbsolute, sep } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { AgentChangeLedgerReader, TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { FileContentResolver } from '@agent-teams/task-change-ledger/review-content';
import { GitDiffFallback } from '@agent-teams/task-change-ledger/review-git';
import { ReviewApplier } from '@agent-teams/task-change-ledger/review-apply';
import {
  createReviewWriter,
  resolveAuthorizedReviewRoot,
  validateAuthorizedReviewFilePath,
  collectAuthoritativeReviewedFiles,
} from '@agent-teams/task-change-ledger/review-writer';
import {
  bindReviewWriterRequest,
  dispatchReviewWriter,
} from '@agent-teams/task-change-ledger/review-transport';
import type {
  ReviewWriterRequest,
  ReviewOriginScope,
  ReviewWriterWireRequest,
} from '@agent-teams/task-change-ledger/review-transport';
import type {
  TaskChangeRequestOptions,
  TaskChangeSetV2,
  TeamTaskChangeSummaryRequest,
  TeamTaskChangeSummariesResponse,
  FileChangeSummary,
} from '@agent-teams/task-change-ledger/contracts';
import type { ReviewProcessStartProbe } from '@agent-teams/task-change-ledger/review-storage';
import type { HostedTeam } from './MemberEntry.js';
import { evidenceProjectDir } from '../evidence/evidenceProjectDir.js';
import { assertReviewOrigin } from './reviewOrigin.js';
import { resolveCapturedReviewWorkspaces } from './CapturedReviewWorkspaces.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { CapturedReviewWorkspaceSet } from './CapturedReviewWorkspaces.js';
import { digest } from '../team/identity.js';
import type { CapturedReviewEvidence } from '@agent-teams/task-change-ledger';

export interface HostTeamReviewOptions {
  team: HostedTeam;
  /** Captured Host lease/lifecycle/workspace policy, supplied only by trusted composition. */
  assertCurrent(): void;
  principalId: string;
  ownerStorageRoot: string;
  /** Captured canonical native workspace; never a renderer project selector. */
  projectPath?: string;
  /** Trusted legacy/main UI context only; captured historical roots never derive from it. */
  currentProjectPath?(): string | undefined;
  /** Trusted initial profile only; never renderer data or current saved workspace. */
  initialRuntimeMembers?: readonly RuntimeMemberProfile[];
  processStartProbe: ReviewProcessStartProbe;
}

/** One captured Team owns its Reader, content tokens and the existing portable writer. */
export function createHostTeamReview(options: HostTeamReviewOptions) {
  const sourceCurrent = options.assertCurrent.bind(options);
  sourceCurrent();
  const owner = options.team.owner;
  const principal = options.principalId;
  const teamName = options.team.definition.binding.teamName;
  const projectPath = options.projectPath;
  const mainProject = () => options.currentProjectPath?.() ?? projectPath;
  const projectDir = evidenceProjectDir(options.ownerStorageRoot, teamName);
  const connection = owner.connect(principal);
  const reader = new TaskChangeLedgerReader();
  const agentReader = new AgentChangeLedgerReader();
  const resolver = new FileContentResolver({ mode: 'ledger-only' });
  const git = new GitDiffFallback();
  const commands = owner.reviewCommands(principal);
  const context = new AsyncLocalStorage<{
    revision: number;
    action: 'read' | 'control';
    origin?: ReviewOriginScope;
    command?: { commandId: string; fingerprint: string; uncertain?: boolean };
    workspaces?: CapturedReviewWorkspaceSet;
    mainRoot?: { path: string; identity: string };
  }>();
  let disposed = false;
  const assertCurrent = () => {
    sourceCurrent();
    if (disposed) throw new Error('Review owner is unavailable');
    const active = context.getStore();
    active?.workspaces?.assertCurrent();
    if (active?.mainRoot) {
      const { path, identity } = active.mainRoot;
      if (mainProject() !== path) throw new Error('Main workspace selection changed');
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path ||
        digest({ dev: info.dev, ino: info.ino }) !== identity) throw new Error('Captured main workspace changed');
    }
    owner.withLaunchAuthority(principal, 'read', () => {});
    const captured = context.getStore();
    if (!captured) throw new Error('Review request authority is unavailable');
    owner.withLaunchAuthority(principal, captured.action, (revision) => {
      if (revision !== captured.revision) throw new Error('Review authority changed');
    });
  };
  const run = async <T>(
    action: 'read' | 'control',
    callback: () => Promise<T>,
    origin?: ReviewOriginScope
  ): Promise<T> => {
    sourceCurrent();
    if (disposed) throw new Error('Review owner is unavailable');
    const revision = owner.withLaunchAuthority(principal, action, (value) => value);
    return context.run(
      { revision, action, ...(origin ? { origin: structuredClone(origin) } : {}) },
      async () => {
        assertCurrent();
        const result = await callback();
        assertCurrent();
        return result;
      }
    );
  };
  const assertTeam = (value: string) => {
    assertCurrent();
    if (value !== teamName) throw new Error('Review belongs to another Team');
  };
  const workspaceProof = (origin: ReviewOriginScope, selected: {
    evidence: readonly CapturedReviewEvidence[];
    changes: { files: FileChangeSummary[]; actorId?: string };
  }) => resolveCapturedReviewWorkspaces({ team: options.team, ownerStorageRoot: options.ownerStorageRoot,
    origin, evidence: selected.evidence, files: selected.changes.files, principalId: principal,
    ...(options.initialRuntimeMembers ? { initialRuntimeMembers: options.initialRuntimeMembers } : {}),
    ...(selected.changes.actorId ? { actorId: selected.changes.actorId } : {}),
    ...(mainProject() ? { legacyProjectPath: mainProject()! } : {}),
  });
  const readTaskEvidence = async (taskId: string, details: boolean) => {
    assertCurrent();
    connection.getTask(taskId);
    const result = await reader.readTaskChangesWithEvidence({
      teamName,
      taskId,
      projectDir,
      ...(mainProject() ? { projectPath: mainProject()! } : {}),
      includeDetails: details,
    });
    assertCurrent();
    connection.getTask(taskId);
    if (!result.changes) throw new Error('Canonical task change evidence is unavailable');
    let changes = result.changes;
    if (result.evidence.length && changes.scope) {
      const proof = workspaceProof({ taskId }, { ...result, changes });
      const actor = proof.actors.find(actor => actor.actorId === changes.scope!.memberName);
      // Presentation only. Immutable raw actor IDs, rows, fingerprints and scope tokens stay intact.
      if (actor) changes = { ...changes, scope: { ...changes.scope, memberName: actor.label } };
      proof.assertCurrent();
    }
    return { ...result, changes };
  };
  const checkEvidence = (evidence: readonly unknown[]) => {
    const captured = context.getStore()?.workspaces;
    if (captured && captured.evidenceFingerprint !== digest(evidence)) throw new Error('Captured review evidence changed');
  };
  const readTask = async (taskId: string, details: boolean): Promise<TaskChangeSetV2> => {
    const result = await readTaskEvidence(taskId, details);
    checkEvidence(result.evidence);
    return result.changes;
  };
  const readAgentEvidence = async (memberName: string) => {
    assertCurrent();
    const roster = connection.readRoster();
    const identities = [...roster.members, ...roster.removedMembers].filter(
      (member) => member.name === memberName
    );
    const ids = new Set(identities.map((member) => member.memberId));
    if (ids.size !== 1) throw new Error('Canonical agent identity is unavailable or ambiguous');
    const actorId = identities[0]!.memberId;
    const result = await agentReader.readAgentChangesWithEvidence({
      teamName,
      memberName,
      actorId,
      projectDir,
      ...(mainProject() ? { projectPath: mainProject()! } : {}),
    });
    assertCurrent();
    const current = connection.readRoster();
    if (
      ![...current.members, ...current.removedMembers].some(
        (member) => member.memberId === actorId && member.name === memberName
      )
    )
      throw new Error('Review agent identity changed');
    return result;
  };
  const readAgent = async (memberName: string) => {
    const result = await readAgentEvidence(memberName);
    checkEvidence(result.evidence);
    return result.changes;
  };
  const originWorkspaces = async () => {
    assertCurrent();
    const current = context.getStore();
    const origin = current?.origin;
    if (!current || !origin || (!origin.taskId && !origin.memberName)) throw new Error('Captured review origin is required');
    const selected = origin.taskId
      ? await readTaskEvidence(origin.taskId, true)
      : await readAgentEvidence(origin.memberName!);
    assertCurrent();
    const next = workspaceProof(origin, selected);
    if (current.workspaces && current.workspaces.evidenceFingerprint !== next.evidenceFingerprint)
      throw new Error('Captured review evidence changed');
    current.workspaces ??= next;
    current.workspaces.assertCurrent();
    return current.workspaces;
  };
  const writer = createReviewWriter({
    teamsRoot: join(options.ownerStorageRoot, 'teams'),
    processStartProbe: options.processStartProbe,
    commandReceipts: {
      capture() {
        assertCurrent();
        const current = context.getStore();
        return current?.command && current.origin
          ? { ...current.command, origin: structuredClone(current.origin) }
          : undefined;
      },
      committed(proof) {
        assertCurrent();
        commands.confirmCommitted(proof);
      },
      uncertain() {
        assertCurrent();
        const active = context.getStore();
        if (!active?.command) throw new Error('Original review command is unavailable');
        active.command.uncertain = true;
      },
    },
    applier: new ReviewApplier({ assertCurrent }),
    authorization: {
      assertTeam,
      assertCurrent,
      async getConfig(value) {
        assertTeam(value);
        const captured = await originWorkspaces();
        assertCurrent();
        return { members: captured.roots.map(root => ({ cwd: root.path })) };
      },
    },
    changes: {
      async getTaskChanges(value, taskId) {
        assertTeam(value);
        return readTask(taskId, true);
      },
      async getAgentChanges(value, memberName) {
        assertTeam(value);
        return readAgent(memberName);
      },
    },
    content: {
      invalidateFile: resolver.invalidateFile.bind(resolver),
      async getFileContent(value, memberName, filePath, _suppliedSnippets) {
        assertTeam(value);
        const origin = context.getStore()?.origin;
        if (!origin?.taskId && !origin?.memberName) throw new Error('Review origin is unavailable');
        if (origin.memberName && memberName && origin.memberName !== memberName)
          throw new Error('Review member differs from originating view');
        const changes = origin.taskId
          ? await readTask(origin.taskId, true)
          : await readAgent(origin.memberName!);
        const file = changes.files.find((item) => item.filePath === filePath);
        if (!file) throw new Error('File is not part of the originating review');
        const result = await resolver.getFileContent(teamName, memberName, filePath, file.snippets);
        assertCurrent();
        return result;
      },
    },
  });
  const authorizePaths = async (requestedProject: string, filePaths: string[]) => {
    assertCurrent();
    if (!Array.isArray(filePaths) || filePaths.length > 256) throw new Error('Invalid captured review path scope');
    const current = context.getStore();
    if (!current) throw new Error('Review request unavailable');
    const origin = current.origin;
    let configured: readonly { path: string; identity: string }[];
    let reviewedFiles: ReturnType<typeof collectAuthoritativeReviewedFiles> | null = null;
    if (origin?.taskId || origin?.memberName) {
      const captured = await originWorkspaces();
      assertCurrent();
      const changes = origin.taskId ? await readTask(origin.taskId, true) : await readAgent(origin.memberName!);
      assertCurrent();
      if (origin.taskId && origin.memberName && 'scope' in changes && changes.scope?.memberName !== origin.memberName)
        throw new Error('Review member differs from captured Task actor');
      reviewedFiles = collectAuthoritativeReviewedFiles(changes.files);
      configured = captured.roots;
    } else {
      // Unbound compatibility is deliberately confined to the configured main workspace.
      const selectedMain = mainProject();
      if (!selectedMain || requestedProject !== selectedMain) throw new Error('Invalid captured review path scope');
      const info = lstatSync(selectedMain);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(selectedMain) !== selectedMain) throw new Error('Captured main workspace unavailable');
      current.mainRoot = { path: selectedMain, identity: digest({ dev: info.dev, ino: info.ino }) };
      configured = [current.mainRoot];
    }
    const roots = await Promise.all(configured.map(async selected => {
      const root = await resolveAuthorizedReviewRoot(selected.path);
      assertCurrent();
      if (!root || root.realPath !== selected.path) throw new Error('Captured review workspace changed');
      return root;
    }));
    const partitions = new Map<string, string[]>();
    const paths: string[] = [];
    for (const filePath of filePaths) {
      const authorized = await validateAuthorizedReviewFilePath(
        { roots, reviewedFiles, resolutionMemberName: '' }, filePath,
        { requireReviewedFile: reviewedFiles !== null });
      assertCurrent();
      const selected = configured.filter(root => {
        const rel = relative(root.path, authorized);
        return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      }).sort((a, b) => b.path.length - a.path.length)[0];
      if (!selected) throw new Error('Captured review root unavailable');
      const group = partitions.get(selected.path) ?? [];
      group.push(authorized); partitions.set(selected.path, group);
      paths.push(authorized);
    }
    return { paths, roots: [...partitions].map(([projectPath, filePaths]) => ({ projectPath, filePaths })),
      identity: digest({ origin, roots: configured, evidence: current.workspaces?.evidenceFingerprint }) };
  };
  return {
    invoke(
      request: ReviewWriterRequest | ReviewWriterWireRequest,
      origin: ReviewOriginScope,
      metadata?: { commandId: string }
    ) {
      const bound = bindReviewWriterRequest(request, teamName);
      assertReviewOrigin(bound, origin);
      // The old content tuple has no task slot. Its authority is the immutable outer
      // origin, resolved by the content port; never reinterpret it as an agent-wide read.
      const admitted: ReviewWriterRequest =
        bound.method === 'getFileContent'
          ? { method: 'getFileContent', args: [teamName, undefined, bound.args[2], []] }
          : bound;
      const kind = reviewMethodKind(bound.method);
      const action = kind === 'read' ? 'read' : 'control';
      return run(
        action,
        async () => {
          if (kind !== 'mutation') return dispatchReviewWriter(writer, admitted);
          if (!metadata || typeof metadata.commandId !== 'string')
            throw new Error('Review command identity is required');
          const admission = commands.admit(metadata.commandId, origin, admitted);
          if (admission.kind === 'completed') return admission.response;
          const current = context.getStore();
          if (!current) throw new Error('Review request authority is unavailable');
          current.command = { commandId: metadata.commandId, fingerprint: admission.fingerprint };
          try {
            const response = await dispatchReviewWriter(writer, admitted);
            assertCurrent();
            if (current.command.uncertain) commands.hold(metadata.commandId, admission.fingerprint);
            else commands.complete(metadata.commandId, admission.fingerprint, response);
            return response;
          } catch (error) {
            try {
              commands.hold(metadata.commandId, admission.fingerprint);
            } catch {
              /* Original prepared receipt remains unknown. */
            }
            throw error;
          }
        },
        origin
      );
    },
    recoveryRead(origin: ReviewOriginScope) {
      return run(
        'control',
        async () => {
          for (const scope of commands.retainedRecoveryScopes(origin)) {
            assertCurrent();
            await writer.loadDecisions(teamName, scope.scopeKey, scope.scopeToken);
            assertCurrent();
          }
          return commands.recoveryRead(origin);
        },
        origin
      );
    },
    lookupCommand(
      commandId: string,
      origin: ReviewOriginScope,
      expected?: ReviewWriterRequest | ReviewWriterWireRequest
    ) {
      const bound = expected ? bindReviewWriterRequest(expected, teamName) : undefined;
      if (bound) assertReviewOrigin(bound, origin);
      return run('control', async () => commands.lookup(commandId, origin, bound) ?? null);
    },
    invalidateSummaries(taskIds: string[]) {
      return run('read', async () => {
        if (!Array.isArray(taskIds) || taskIds.length > 512)
          throw new Error('Invalid task summary request');
        for (const taskId of taskIds) connection.getTask(taskId);
      });
    },
    getTaskChanges(taskId: string, requestOptions: TaskChangeRequestOptions = {}) {
      return run('read', () => readTask(taskId, !requestOptions.summaryOnly));
    },
    getTaskSummaries(
      requests: TeamTaskChangeSummaryRequest[]
    ): Promise<TeamTaskChangeSummariesResponse> {
      return run('read', async () => {
        if (!Array.isArray(requests) || requests.length > 512)
          throw new Error('Invalid task summary request');
        const items = [];
        for (const request of requests) {
          try {
            items.push({
              taskId: request.taskId,
              changeSet: await readTask(request.taskId, false),
            });
          } catch {
            assertCurrent();
            items.push({
              taskId: request.taskId,
              changeSet: null,
              error: 'Canonical task change evidence is unavailable',
            });
          }
        }
        return { teamName, items, computedAt: new Date().toISOString() };
      });
    },
    getAgentChanges(memberName: string) {
      return run('read', () => readAgent(memberName));
    },
    getChangeStats(memberName: string) {
      return run('read', async () => {
        const changes = await readAgent(memberName);
        if (!changes.totalFiles || changes.files.some((file) => file.diffStatKnown === false))
          throw new Error('Canonical agent change statistics are unavailable');
        return {
          linesAdded: changes.totalLinesAdded,
          linesRemoved: changes.totalLinesRemoved,
          filesChanged: changes.totalFiles,
          completeness: 'partial' as const,
          warnings: changes.warnings,
        };
      });
    },
    authorizeWatch(input: { projectPath: string; filePaths: string[]; scope?: ReviewOriginScope }) {
      return run('read', async () => {
        const authorized = await authorizePaths(input.projectPath, input.filePaths);
        return { kind: 'review-watch-authorization' as const,
          projectPath: authorized.roots[0]?.projectPath ?? mainProject() ?? input.projectPath,
          filePaths: authorized.paths, roots: authorized.roots, authorizationIdentity: authorized.identity };
      }, input.scope);
    },
    getGitFileLog(requestedProject: string, filePath: string, scope?: ReviewOriginScope) {
      return run('read', async () => {
        const authorized = await authorizePaths(requestedProject, [filePath]);
        const selected = authorized.roots[0];
        if (!selected || !authorized.paths[0]) throw new Error('Invalid review file');
        assertCurrent();
        return git.getFileLog(selected.projectPath, authorized.paths[0]);
      }, scope);
    },
    dispose() {
      disposed = true;
      writer.dispose();
    },
  };
}
export type HostTeamReview = ReturnType<typeof createHostTeamReview>;
