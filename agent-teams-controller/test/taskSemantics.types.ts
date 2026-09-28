import {
  planColumnTransition,
  resolveBlockers,
  resolveColumnOrder,
  resolveReview,
  type BlockerFact,
  type TaskSemanticSnapshot,
} from 'agent-teams-controller/task-semantics';

const task: TaskSemanticSnapshot = {
  key: 'task-1',
  status: 'completed',
  reviewState: 'needsFix',
  history: [{ kind: 'review_changes_requested' }],
  placement: null,
};
const blockers: BlockerFact[] = [{ kind: 'known_task', key: task.key, task }];
const review: 'none' | 'review' | 'needsFix' | 'approved' = resolveReview(task).state;
const decision = planColumnTransition({ task, targetColumn: 'done', blockers });
if (decision.allowed && decision.transition.kind === 'set_status') {
  const reset: boolean = decision.transition.resetReview;
  void reset;
}
const blocked = resolveBlockers(blockers);
const order = resolveColumnOrder({
  canonicalKeys: [task.key],
  explicitKeys: [],
  canonicalColumnComplete: true,
  sourceRevision: 'r1',
  explicitOrderRevision: 'r1',
});
void [review, blocked, order];
