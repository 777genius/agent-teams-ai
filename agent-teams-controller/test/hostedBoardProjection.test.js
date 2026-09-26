const fs = require('fs');
const path = require('path');

const { hostedBoardIdentity, hostedBoardProjection } = require('../src/index.js');

const TEAM_ID = `team_${'d'.repeat(32)}`;
const file = (id, fields = {}) => ({
  name: `${id}.json`,
  text: JSON.stringify({ id, subject: `Task ${id}`, status: 'pending', ...fields }),
});

describe('hostedBoardProjection', () => {
  it('hides deleted and internal tasks', () => {
    const tasks = hostedBoardProjection.hostedBoardTasks(TEAM_ID, [
      file('a', { blocks: ['b'] }),
      file('b', { blockedBy: ['a'] }),
      file('gone', { status: 'deleted' }),
      file('hidden', { metadata: { _internal: true } }),
      { name: 'notes.txt', text: 'not a task' },
    ]);
    expect([...tasks.values()].map((task) => task.rawId)).toEqual(['a', 'b']);
    expect(tasks.get(hostedBoardIdentity.hostedTaskBoardTaskId(TEAM_ID, 'a'))).toMatchObject({
      rawId: 'a',
      status: 'pending',
      owner: null,
      description: null,
      blocks: ['b'],
    });

  });

  it('skips invalid task files and drops one-sided relationships like desktop', () => {
    const tasks = hostedBoardProjection.hostedBoardTasks(TEAM_ID, [
      file('a', { blocks: ['b'], related: ['c'] }),
      file('b'),
      file('c', { related: ['a'] }),
      file('bad', { status: 'unknown' }),
      { name: 'broken.json', text: '{not json' },
    ]);
    expect([...tasks.values()].map((task) => [task.rawId, task.blocks, task.related])).toEqual([
      ['a', [], ['c']],
      ['b', [], []],
      ['c', [], ['a']],
    ]);
  });

  it('places and orders tasks as the desktop kanban board does', () => {
    const tasks = hostedBoardProjection.hostedBoardTasks(TEAM_ID, [
      file('a'),
      file('b'),
      file('c', { status: 'completed' }),
      file('d', { status: 'completed' }),
    ]);
    const kanban = {
      tasks: { c: { column: 'review' } },
      // `c` is listed under todo but sits in review; `x` is not a board task.
      columnOrder: { todo: ['x', 'c', 'b', 'b'], review: ['c'] },
    };
    const column = (rawId, status) => hostedBoardProjection.hostedBoardColumnFor(kanban, rawId, status);
    expect([column('a', 'pending'), column('c', 'completed'), column('d', 'completed')]).toEqual(['todo', 'review', 'done']);

    const order = (name) => hostedBoardProjection.hostedBoardColumnOrder(kanban, name, tasks.values());
    expect(order('todo')).toEqual(['b', 'a']);
    expect(order('review')).toEqual(['c']);
    expect(order('done')).toEqual(['d']);
    expect(order('approved')).toEqual([]);
  });

  it('orders tasks without an explicit column order by display ID as desktop does', () => {
    const tasks = hostedBoardProjection.hostedBoardTasks(TEAM_ID, [
      file('x1', { displayId: '10' }),
      file('x2', { displayId: '9' }),
      file('x3', { displayId: 'abc' }),
      file('x4', { displayId: '2b' }),
    ]);
    expect(hostedBoardProjection.hostedBoardColumnOrder({}, 'todo', tasks.values())).toEqual(['x2', 'x1', 'x4', 'x3']);
  });

  it('maps active roster members exactly as the roster identity golden', () => {
    const golden = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../docs/hosted-roster-identity-golden.json'), 'utf8')
    );
    const active = hostedBoardProjection.hostedActiveRosterMembers(golden.teamId, {
      config: null,
      meta: golden.roster.membersMetaJson,
    });
    expect([...active].map(([memberId, name]) => ({ name, memberId }))).toEqual(
      golden.roster.activeMembers.map(({ name, memberId }) => ({ name, memberId }))
    );

    const duplicate = JSON.stringify({ version: 1, members: [{ name: 'bob' }, { name: 'Bob', agentId: 'bob-2' }] });
    expect(() => hostedBoardProjection.hostedActiveRosterMembers(golden.teamId, { config: null, meta: duplicate })).toThrow(
      'hosted-board-roster-ambiguous'
    );
  });
});
