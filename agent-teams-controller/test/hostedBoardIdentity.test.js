const fs = require('fs');
const path = require('path');

const { hostedBoardIdentity } = require('../src/index.js');

const DOCS = path.resolve(__dirname, '../../docs');
const readGolden = (name) => JSON.parse(fs.readFileSync(path.join(DOCS, name), 'utf8'));

describe('hostedBoardIdentity', () => {
  it('matches the Product-Owner envelope golden formulas', () => {
    const { formulas } = readGolden('hosted-owner-bound-envelope-golden.json');

    expect(
      hostedBoardIdentity.hostedTaskBoardSourceGeneration(formulas.sourceGeneration.input)
    ).toBe(formulas.sourceGeneration.expected);
    expect(hostedBoardIdentity.hostedTaskBoardRevision(formulas.revision.input)).toBe(
      formulas.revision.expected
    );
    expect(
      hostedBoardIdentity.hostedTaskBoardTaskId(
        formulas.taskId.input.teamId,
        formulas.taskId.input.rawTaskId
      )
    ).toBe(formulas.taskId.expected);
  });

  it('matches the roster identity golden for every identity rule', () => {
    const golden = readGolden('hosted-roster-identity-golden.json');
    for (const { rawMemberName, memberId } of golden.formula) {
      expect(
        hostedBoardIdentity.hostedRosterMemberIdForIdentity(golden.teamId, rawMemberName)
      ).toBe(memberId);
    }

    const members = JSON.parse(golden.roster.membersMetaJson).members;
    const active = members
      .filter((member) => member.name !== 'user' && member.removedAt === undefined)
      .map((member) => ({
        name: member.name,
        memberId: hostedBoardIdentity.hostedRosterMemberId(golden.teamId, member),
      }));
    expect(active).toEqual(golden.roster.activeMembers);
  });

  it('keeps an explicit roster memberId and refuses a record without a name', () => {
    const explicit = `member_${'e3'.repeat(16)}`;
    expect(hostedBoardIdentity.hostedRosterMemberId(null, { name: 'x', memberId: explicit })).toBe(
      explicit
    );
    expect(hostedBoardIdentity.hostedRosterMemberId('team_1', { name: '' })).toBeNull();
    expect(hostedBoardIdentity.hostedRosterMemberId(null, { name: 'x' })).toBeNull();
  });

  it('derives a stable controller-shaped task id per hosted create command', () => {
    const teamId = `team_${'a1'.repeat(16)}`;
    const first = hostedBoardIdentity.hostedTaskIdForCommand(teamId, 'command_one');

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(hostedBoardIdentity.hostedTaskIdForCommand(teamId, 'command_one')).toBe(first);
    expect(hostedBoardIdentity.hostedTaskIdForCommand(teamId, 'command_two')).not.toBe(first);
    expect(
      hostedBoardIdentity.hostedTaskIdForCommand(`team_${'b2'.repeat(16)}`, 'command_one')
    ).not.toBe(first);
  });

  it('rejects duplicate or unsafe revision inputs', () => {
    const base = { sourceGeneration: 'generation_x', kanbanText: null, rosterFiles: [] };
    expect(() =>
      hostedBoardIdentity.hostedTaskBoardRevision({
        ...base,
        taskFiles: [
          { name: 'a.json', text: '{}' },
          { name: 'a.json', text: '{}' },
        ],
      })
    ).toThrow('hosted-task-board-revision-input-invalid');
    expect(() =>
      hostedBoardIdentity.hostedTaskBoardRevision({
        ...base,
        taskFiles: [{ name: '../a.json', text: '{}' }],
      })
    ).toThrow('hosted-task-board-revision-input-invalid');
  });

  it('stays free of filesystem access so desktop and the MCP bundle can import it anywhere', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../src/internal/hostedBoardIdentity.js'),
      'utf8'
    );
    expect(source).not.toMatch(/require\(['"](?:node:)?fs/);
  });
});
