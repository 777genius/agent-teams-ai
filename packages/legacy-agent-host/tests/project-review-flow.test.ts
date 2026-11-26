import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertProjectReviewFlowIdle } from '../dist/team-project-context/HostProjectReviewFlow.js';
import { projectTeamFixture, openProjectTeamFixture } from './projectTeamFixture.ts';

const policy = { reviewFlow: 'human_approval' as const, reviewFlowPrompt: 'TEST original policy' };
const command = (commandId: string, settings: typeof policy | null = policy) => ({
  commandId, operation: 'task.board.review-flow' as const, payload: { settings },
});
function projectReviewView(view: ReturnType<ReturnType<typeof projectTeamFixture>['review']['read']>) {
  assert.ok('projectTeam' in view, 'TEST selected logical project definition');
  return view;
}
function family(t: Parameters<typeof projectTeamFixture>[0]) {
  const f = projectTeamFixture(t), logical = f.create().record;
  f.prepare(logical, 'TEST-project-one');
  const other = join(f.root, 'TEST-other'); mkdirSync(other);
  f.prepare(logical, 'TEST-project-two', other);
  const children = f.registry.list(f.contextId).teams.filter(row => row.projectContext)
    .sort((a, b) => a.binding.handleId.localeCompare(b.binding.handleId));
  return { ...f, logical, children, selected: f.target(logical) };
}

test('logical review policy covers every existing project, including running histories, and aliases remain read-only', t => {
  const f = family(t);
  assert.equal(projectReviewView(f.review.read(f.selected)).projectTeam?.saved, false);
  for (const child of f.children) f.live.add(child.teamId);
  const receipt = f.review.execute(f.selected, command('TEST-policy'));
  assert.equal(receipt?.phase, 'completed');
  assert.equal(projectReviewView(f.review.read(f.selected)).projectTeam?.saved, true);
  for (const child of f.children) {
    assert.deepEqual(f.target(child).team.connection.readQueries!.getReviewFlowSettings().settings, policy);
    assert.throws(() => f.review.execute(f.target(child), command('TEST-no-alias-write')));
  }
  f.live.clear();
  const third = join(f.root, 'TEST-third'); mkdirSync(third);
  f.prepare(f.logical, 'TEST-project-three', third);
  assert.deepEqual(f.target(f.child(f.logical, third)).team.connection.readQueries!.getReviewFlowSettings().settings, policy);
  f.review.execute(f.selected, command('TEST-remove', null));
  assert.deepEqual(projectReviewView(f.review.read(f.selected)).projectTeam?.settings, null);
  assert.equal(projectReviewView(f.review.read(f.selected)).projectTeam?.saved, true, 'explicit inheritance differs from never saved');
});

test('failed policy still attempts the remaining captured boards; cold read/lookup is inert and exact original resumes', t => {
  const f = family(t), failed = f.target(f.children[0]!).team;
  const connection = failed.connection;
  failed.connection = { ...connection, execute() { throw new Error('TEST unavailable board'); } };
  assert.throws(() => f.review.execute(f.selected, command('TEST-original')));
  assert.deepEqual(f.target(f.children[1]!).team.connection.readQueries!.getReviewFlowSettings().settings, policy);
  assert.equal(f.review.lookup(f.selected, 'TEST-original'), null);
  const store = f.stores.get(f.logical.teamId)!, prepared = store.read('project-review-flow/current.json');
  assert.throws(() => assertProjectReviewFlowIdle(store));
  assert.throws(() => f.prepare(f.logical, 'TEST-not-a-policy-continuation'));
  assert.throws(() => f.review.execute(f.selected, command('TEST-new-policy')));
  f.close();
  const cold = openProjectTeamFixture(f.root);
  try {
    const selected = cold.target(f.logical);
    assert.deepEqual(projectReviewView(cold.review.read(selected)).pending, { commandId: 'TEST-original', settings: policy });
    assert.equal(cold.review.lookup(selected, 'TEST-original'), null);
    assert.deepEqual(cold.stores.get(f.logical.teamId)!.read('project-review-flow/current.json'), prepared);
    assert.equal(cold.review.execute(selected, command('TEST-original'))?.phase, 'completed');
    for (const child of f.children)
      assert.deepEqual(cold.target(child).team.connection.readQueries!.getReviewFlowSettings().settings, policy);
    assert.doesNotThrow(() => assertProjectReviewFlowIdle(cold.stores.get(f.logical.teamId)!));
    assert.equal(cold.review.lookup(selected, 'TEST-original')?.commandId, 'TEST-original');
  } finally { cold.close(); }
});

test('atomic current publication after a settled policy survives interruption before the first new board effect', t => {
  const f = family(t), store = f.stores.get(f.logical.teamId)!;
  f.review.execute(f.selected, command('TEST-settled'));
  const write = store.write.bind(store);
  store.write = (path, value) => {
    write(path, value);
    if (path === 'project-review-flow/current.json' && (value as { commandId?: string }).commandId === 'TEST-next')
      throw new Error('TEST crash after atomic current publication');
  };
  assert.throws(() => f.review.execute(f.selected, command('TEST-next', null)));
  store.write = write;
  assert.deepEqual(f.selected.team.connection.readQueries!.getReviewFlowSettings().settings, policy);
  f.close();
  const cold = openProjectTeamFixture(f.root);
  try {
    assert.deepEqual(projectReviewView(cold.review.read(cold.target(f.logical))).pending, { commandId: 'TEST-next', settings: null });
    assert.equal(cold.review.execute(cold.target(f.logical), command('TEST-next', null))?.phase, 'completed');
    assert.equal(cold.review.lookup(cold.target(f.logical), 'TEST-settled')?.commandId, 'TEST-settled');
  } finally { cold.close(); }
});

test('revoking a captured child grant never turns a partial policy into completed approval', t => {
  const f = family(t), child = f.target(f.children[0]!).team, connection = child.connection;
  child.connection = { ...connection, execute() { throw new Error('TEST lost before effect'); } };
  assert.throws(() => f.review.execute(f.selected, command('TEST-revoked')));
  child.connection = connection;
  connection.revoke(f.principalId);
  assert.throws(() => f.review.execute(f.selected, command('TEST-revoked')));
  assert.equal(f.review.lookup(f.selected, 'TEST-revoked'), null);
  assert.throws(() => assertProjectReviewFlowIdle(f.stores.get(f.logical.teamId)!));
});
