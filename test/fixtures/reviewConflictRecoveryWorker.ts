import { ReviewDraftHistoryStore } from '../../src/features/change-review-history/main/infrastructure/ReviewDraftHistoryStore';
import { ReviewDecisionStore } from '../../src/main/services/team/ReviewDecisionStore';
import { setClaudeBasePathOverride } from '../../src/main/utils/pathDecoder';

const [mode, claudeBasePath] = process.argv.slice(2);
if (!mode || !claudeBasePath) throw new Error('Invalid review conflict worker arguments');
setClaudeBasePathOverride(claudeBasePath);

const teamName = 'review-conflict-e2e';
const scopeKey = 'task-restart';
const decisionScopeToken = 'task:restart:req:conflict:src:one';
const draftScopeToken = 'task:restart:draft:conflict:src:one';
const filePath = '/synthetic/review-conflict.ts';
const editorState = (doc: string) => ({
  doc,
  history: { done: [doc], undone: [] },
});

if (mode === 'create-and-crash') {
  const decisions = new ReviewDecisionStore();
  await decisions.save(teamName, scopeKey, {
    scopeToken: decisionScopeToken,
    hunkDecisions: { 'synthetic:0': 'accepted' },
    fileDecisions: {},
    expectedRevision: 0,
  });
  await decisions
    .save(teamName, scopeKey, {
      scopeToken: decisionScopeToken,
      hunkDecisions: { 'synthetic:0': 'rejected' },
      fileDecisions: {},
      expectedRevision: 0,
    })
    .catch(() => undefined);

  const drafts = new ReviewDraftHistoryStore();
  const canonical = await drafts.saveEntry(teamName, scopeKey, draftScopeToken, {
    filePath,
    codec: 'codemirror-history-v1',
    revision: 1,
    expectedRevision: 0,
    expectedGeneration: null,
    diskBaseline: 'A',
    editorState: editorState('AB'),
  });
  await drafts
    .saveEntry(teamName, scopeKey, draftScopeToken, {
      filePath,
      codec: 'codemirror-history-v1',
      revision: 1,
      expectedRevision: 0,
      expectedGeneration: null,
      diskBaseline: 'A',
      editorState: editorState('AC'),
    })
    .catch(() => undefined);
  const [candidate] = await drafts.loadConflictCandidates(
    teamName,
    scopeKey,
    draftScopeToken
  );
  await drafts.replaceConflictCandidate(
    teamName,
    scopeKey,
    draftScopeToken,
    candidate!.entry!,
    {
      filePath,
      codec: 'codemirror-history-v1',
      revision: 3,
      diskBaseline: 'A',
      editorState: editorState('ACD'),
    },
    1,
    canonical.generation
  );
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => undefined);
}

if (mode === 'swap-and-crash') {
  const decisions = new ReviewDecisionStore();
  const [candidate] = await decisions.loadConflictCandidates(
    teamName,
    scopeKey,
    decisionScopeToken
  );
  await decisions.resolveConflictCandidate(
    teamName,
    scopeKey,
    decisionScopeToken,
    candidate!.id,
    'recover-candidate',
    1
  );
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => undefined);
}

if (mode === 'inspect') {
  const decisions = new ReviewDecisionStore();
  const drafts = new ReviewDraftHistoryStore();
  process.stdout.write(
    JSON.stringify({
      decisions: await decisions.load(teamName, scopeKey, decisionScopeToken),
      decisionCandidates: await decisions.loadConflictCandidates(
        teamName,
        scopeKey,
        decisionScopeToken
      ),
      draftCandidates: await drafts.loadConflictCandidates(teamName, scopeKey, draftScopeToken),
    })
  );
}
