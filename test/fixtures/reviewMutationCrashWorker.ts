import { readFile } from 'fs/promises';

import { ReviewMutationCoordinator } from '../../src/features/review-mutations/main';
import { ReviewDecisionStore } from '../../src/main/services/team/ReviewDecisionStore';
import {
  type ReviewMutationJournalRecord,
  ReviewMutationJournalStore,
} from '../../src/main/services/team/ReviewMutationJournalStore';
import { atomicWriteAsync } from '../../src/main/utils/atomicWrite';
import { setClaudeBasePathOverride } from '../../src/main/utils/pathDecoder';

import type { ReviewMutationPhase } from '../../src/features/review-mutations/contracts';

type CrashPoint = ReviewMutationPhase | 'after_disk_effect' | 'after_decision_effect' | 'none';

interface AuditState {
  diskAttempts: number;
  diskWrites: number;
  decisionAttempts: number;
}

const [mode, claudeBasePath, filePath, auditPath, crashPointValue, operationShapeValue] =
  process.argv.slice(2);
if ((mode !== 'run' && mode !== 'recover') || !claudeBasePath || !filePath || !auditPath) {
  throw new Error('Invalid review mutation crash worker arguments');
}

const crashPoint = (crashPointValue ?? 'none') as CrashPoint;
const operationShape =
  operationShapeValue === 'decision-only-redo' || operationShapeValue === 'disk-redo'
    ? operationShapeValue
    : 'disk';
const teamName = 'review-crash-test';
const persistenceScope = {
  scopeKey: 'task-task-1',
  scopeToken: 'task:task-1:review-crash-fixture',
};
const beforeContent = 'before\n';
const afterContent = 'after\n';
const diskRedoAction = {
  id: 'fixture-disk-action',
  createdAt: '2026-07-17T12:00:00.000Z',
  kind: 'disk' as const,
  action: {
    snapshot: { filePath, beforeContent, afterContent },
    originalIndex: 0,
  },
};
const persistedState = {
  hunkDecisions: {
    'fixture-change:0': operationShape === 'decision-only-redo' ? 'accepted' : 'rejected',
  } as const,
  fileDecisions: {},
  hunkContextHashesByFile: {},
  reviewActionHistory:
    operationShape === 'disk-redo'
      ? [diskRedoAction]
      : operationShape === 'decision-only-redo'
        ? [
            {
              id: 'fixture-hunk-action',
              createdAt: '2026-07-17T12:00:00.000Z',
              kind: 'hunk' as const,
              action: { filePath, originalIndex: 0 },
            },
          ]
        : [],
  reviewRedoHistory: [],
};

setClaudeBasePathOverride(claudeBasePath);

const journal = new ReviewMutationJournalStore();
const decisions = new ReviewDecisionStore();

async function readAudit(): Promise<AuditState> {
  try {
    return JSON.parse(await readFile(auditPath, 'utf8')) as AuditState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { diskAttempts: 0, diskWrites: 0, decisionAttempts: 0 };
  }
}

async function updateAudit(update: (current: AuditState) => AuditState): Promise<void> {
  const next = update(await readAudit());
  await atomicWriteAsync(auditPath, JSON.stringify(next), {
    durability: 'strict',
    syncDirectory: true,
  });
}

function crashNow(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not terminate the crash worker');
}

function crashIf(point: CrashPoint): void {
  if (crashPoint === point) crashNow();
}

async function applyDisk(
  record: ReviewMutationJournalRecord
): Promise<ReviewMutationJournalRecord> {
  const step = record.diskSteps?.[0];
  if (!step && operationShape === 'decision-only-redo') return record;
  if (!step || step.type !== 'write') throw new Error('Crash fixture disk step is missing');
  if (step.status === 'applied') return record;
  await updateAudit((current) => ({ ...current, diskAttempts: current.diskAttempts + 1 }));
  const currentContent = await readFile(filePath, 'utf8');
  if (currentContent === beforeContent) {
    await atomicWriteAsync(filePath, afterContent, {
      durability: 'strict',
      syncDirectory: true,
    });
    await updateAudit((current) => ({ ...current, diskWrites: current.diskWrites + 1 }));
  } else if (currentContent !== afterContent) {
    throw new Error('Crash fixture file changed unexpectedly');
  }
  crashIf('after_disk_effect');
  return journal.checkpoint({
    ...record,
    diskSteps: [{ ...step, status: 'applied' }],
  });
}

async function commitDecisions(record: ReviewMutationJournalRecord): Promise<void> {
  await updateAudit((current) => ({
    ...current,
    decisionAttempts: current.decisionAttempts + 1,
  }));
  await decisions.save(teamName, persistenceScope.scopeKey, {
    scopeToken: persistenceScope.scopeToken,
    ...persistedState,
    expectedRevision: record.expectedDecisionRevision,
    mutationId: record.id,
  });
  crashIf('after_decision_effect');
}

const coordinator = new ReviewMutationCoordinator(journal, {
  afterPhasePersisted: (phase) => crashIf(phase),
});

if (mode === 'run') {
  if (operationShape === 'disk-redo') {
    await decisions.save(teamName, persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [],
      reviewRedoHistory: [
        {
          action: diskRedoAction,
          decisionSnapshot: {
            hunkDecisions: persistedState.hunkDecisions,
            fileDecisions: {},
          },
          hunkContextHashesByFile: {},
        },
      ],
      expectedRevision: 0,
    });
  }
  await coordinator.execute(
    {
      teamName,
      persistenceScope,
      reviewScope: { teamName, taskId: 'task-1' },
      kind: operationShape === 'disk' ? 'undo' : 'redo',
      decisions: [],
      fileContents: [],
      diskSteps:
        operationShape === 'decision-only-redo'
          ? []
          : [
              {
                id: 'fixture-step',
                type: 'write',
                filePath,
                expectedContent: beforeContent,
                content: afterContent,
                status: 'pending',
              },
            ],
      persistedState,
      expectedDecisionRevision: operationShape === 'disk-redo' ? 1 : 0,
    },
    { applyDisk, commitDecisions }
  );
} else {
  for (const record of await journal.list(teamName, persistenceScope)) {
    await coordinator.resume(record, { applyDisk, commitDecisions });
  }
  process.stdout.write(
    JSON.stringify({
      fileContent: await readFile(filePath, 'utf8'),
      decisions: await decisions.load(
        teamName,
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      ),
      pendingRecords: (await journal.list(teamName, persistenceScope)).length,
      audit: await readAudit(),
    })
  );
}
