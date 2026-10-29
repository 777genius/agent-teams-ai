import { projectCapturedReviewEvidence } from './capturedReviewEvidence.js';
import type { ChangesWithEvidence } from './capturedReviewEvidence.js';
import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { LedgerArtifactReader } from './LedgerArtifactReader.js';
import { LedgerFileReader } from './LedgerFileReader.js';
import { encodeTaskId, TASK_CHANGE_LEDGER_READ_LIMITS } from './artifactPaths.js';
import { buildSnippets, projectJournalEventsForUi } from './eventProjection.js';
import { buildFallbackFilesFromGroupedSnippets, groupSnippets } from './fileProjection.js';
import {
  collectReviewDiagnostics,
  collectWarnings,
  withSummaryStateDiagnostics,
} from './diagnostics.js';
import type { AgentChangeSet } from './contracts.js';
import type { EvidenceEvent, EvidenceNotice } from './ledgerTypes.js';

const LIMIT = TASK_CHANGE_LEDGER_READ_LIMITS;
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/u.test(value);

/** Every inventory member is an actual immutable event actor, never a Task assignee hint. */
export class AgentChangeLedgerReader {
  private readonly files = new LedgerFileReader();
  private readonly artifacts = new LedgerArtifactReader(this.files);

  async readAgentChanges(params: {
    teamName: string;
    memberName: string;
    actorId: string;
    projectDir: string;
    projectPath?: string;
  }): Promise<AgentChangeSet> {
    return (await this.readAgentChangesWithEvidence(params)).changes;
  }

  async readAgentChangesWithEvidence(params: {
    teamName: string;
    memberName: string;
    actorId: string;
    projectDir: string;
    projectPath?: string;
  }): Promise<ChangesWithEvidence<AgentChangeSet>> {
    if (!id(params.actorId)) throw new Error('Invalid ledger actor');
    const root = resolve(params.projectDir);
    const events: EvidenceEvent[] = [];
    const notices: EvidenceNotice[] = [];
    const warnings = new Set<string>();
    let bytes = 0,
      entries = 0,
      inspected = 0,
      recovered = false;
    // Refuse aliases even when a symlink resolves back inside the evidence root.
    const safe = async (target: string): Promise<boolean> => {
      let cursor = target;
      for (;;) {
        try {
          const info = await lstat(cursor);
          if (info.isSymbolicLink() || (await realpath(cursor)) !== cursor) return false;
        } catch {
          return false;
        }
        if (cursor === root) return true;
        const parent = dirname(cursor);
        if (parent === cursor || !cursor.startsWith(root + '/')) return false;
        cursor = parent;
      }
    };
    const read = async (file: string, kind: 'events' | 'notices', generic: boolean) => {
      if (++inspected > 1024) throw new Error('Agent ledger inventory capped');
      let info;
      try {
        info = await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (!info.isFile() || !(await safe(file))) {
        recovered = true;
        warnings.add('Agent evidence artifact was unsafe or unavailable.');
        return;
      }
      bytes += info.size;
      if (bytes > LIMIT.journalBytes) throw new Error('Agent ledger byte budget exceeded');
      const validate = (row: Record<string, unknown>) => {
        if (!id(row.agentId) || !id(row.toolUseId) || typeof row.timestamp !== 'string')
          return false;
        if (
          generic
            ? row.artifactKind !== 'agent-input' ||
              row.agentId !== params.actorId ||
              !id(row.inputId) ||
              !id(row.messageId) ||
              row.taskId !== undefined
            : !id(row.taskId)
        )
          return false;
        if (kind === 'notices')
          return typeof row.message === 'string' && row.message.length <= 8192;
        return (
          typeof row.filePath === 'string' &&
          typeof row.relativePath === 'string' &&
          ['create', 'modify', 'delete'].includes(String(row.operation)) &&
          [
            'file_edit',
            'file_write',
            'notebook_edit',
            'bash_simulated_sed',
            'shell_snapshot',
            'powershell_snapshot',
            'post_tool_hook_snapshot',
            'opencode_toolpart_write',
            'opencode_toolpart_edit',
            'opencode_toolpart_apply_patch',
          ].includes(String(row.source)) &&
          ['exact', 'high', 'medium', 'low', 'ambiguous'].includes(String(row.confidence)) &&
          Number.isSafeInteger(row.executionSeq) &&
          Number(row.executionSeq) >= 0 &&
          (row.warnings === undefined ||
            (Array.isArray(row.warnings) &&
              row.warnings.length <= 128 &&
              row.warnings.every((value) => typeof value === 'string' && value.length <= 8192)))
        );
      };
      const result = await this.artifacts.readJournalEntries<EvidenceEvent | EvidenceNotice>({
        projectDir: root,
        filePath: file,
        schemaVersion: 1,
        idField: kind === 'events' ? 'eventId' : 'noticeId',
        validate,
      });
      if (result.rejected) {
        recovered = true;
        warnings.add('Agent evidence artifact was capped or unavailable.');
        return;
      }
      entries += result.entries.length;
      if (entries > LIMIT.journalEntries) throw new Error('Agent ledger entry budget exceeded');
      recovered ||= result.recovered;
      for (const row of result.entries)
        if (row.agentId === params.actorId) {
          if (kind === 'events') events.push(row as EvidenceEvent);
          else notices.push(row as EvidenceNotice);
        }
    };
    for (const kind of ['events', 'notices'] as const) {
      const directory = join(root, '.board-task-changes', kind);
      try {
        if (!(await safe(directory))) {
          await lstat(directory);
          recovered = true;
          warnings.add('Task evidence inventory was unsafe.');
        } else {
          // opendir is streaming: a hostile directory cannot allocate an unbounded names array.
          const names: string[] = [];
          let directoryEntries = 0;
          for await (const item of await opendir(directory)) {
            if (++directoryEntries > 512) throw new Error('Agent ledger inventory capped');
            if (!item.name.endsWith('.jsonl')) {
              recovered = true;
              continue;
            }
            names.push(item.name);
          }
          for (const name of names.sort()) await read(join(directory, name), kind, false);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await read(
        join(root, '.board-task-changes', 'agents', encodeTaskId(params.actorId), `${kind}.jsonl`),
        kind,
        true
      );
    }
    // Same event copied by an interrupted import is one effect; conflicting identities refuse safely.
    const unique = new Map<string, EvidenceEvent>();
    for (const event of events) {
      const prior = unique.get(event.eventId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(event))
        throw new Error('Conflicting agent event identity');
      unique.set(event.eventId, event);
    }
    const projected = projectJournalEventsForUi(
      [...unique.values()].sort(
        (a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId)
      )
    );
    const snippets = await buildSnippets(this.files, root, projected);
    const summary = buildFallbackFilesFromGroupedSnippets(
      groupSnippets(snippets),
      params.projectPath
    );
    for (const file of summary.files) {
      file.diffStatKnown = file.snippets.every(
        ({ ledger }) =>
          ledger &&
          (ledger.textAvailability === 'patch-text' ||
            ((ledger.originalFullContent !== null || ledger.beforeState?.exists === false) &&
              (ledger.modifiedFullContent !== null || ledger.afterState?.exists === false)))
      );
      if (!file.diffStatKnown) warnings.add('Some captured file statistics are unavailable.');
    }
    for (const warning of collectWarnings(projected, notices, { recovered })) warnings.add(warning);
    // An empty capture inventory proves no captured changes, never complete native execution coverage.
    warnings.add(
      'Agent evidence includes captured inputs only; native interval and workspace coverage remain partial.'
    );
    const warningList = [...warnings].slice(0, 128);
    const diagnostics = collectReviewDiagnostics(projected, notices, { recovered });
    const changes: AgentChangeSet = {
      teamName: params.teamName,
      memberName: params.memberName,
      actorId: params.actorId,
      files: summary.files,
      totalLinesAdded: summary.totalLinesAdded,
      totalLinesRemoved: summary.totalLinesRemoved,
      totalFiles: summary.files.length,
      computedAt: new Date().toISOString(),
      warnings: warningList,
      diffStatCompleteness: 'partial',
      reviewDiagnostics: withSummaryStateDiagnostics(diagnostics, {
        integrity: 'partial',
        diffStatCompleteness: 'partial',
      }),
      provenance: {
        sourceKind: 'ledger',
        integrity: 'partial',
        sourceFingerprint: createHash('sha256')
          .update(
            JSON.stringify({
              actorId: params.actorId,
              events: [...unique.values()],
              notices,
            })
          )
          .digest('hex'),
      },
    };
    return { changes, evidence: projectCapturedReviewEvidence([...unique.values()]) };
  }
}
