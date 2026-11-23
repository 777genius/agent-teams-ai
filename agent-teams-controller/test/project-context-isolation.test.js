const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createController } = require('../src/index.js');

describe('project-scoped native team storage', () => {
  const sandboxes = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-project-alias-'));
    sandboxes.push(claudeDir);
    const makeTeam = (teamName) => {
      const teamDir = path.join(claudeDir, 'teams', teamName);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify({
        name: teamName,
        leadSessionId: 'lead-' + teamName,
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
        ],
      }));
      return createController({ teamName, claudeDir });
    };
    return { claudeDir, makeTeam };
  }

  it('uses separate task board, durable inbox, and session roots for distinct project aliases', () => {
    const f = setup();
    const a = f.makeTeam('ptc-project-a');
    const b = f.makeTeam('ptc-project-b');
    const taskA = a.taskBoard.createTask({ subject: 'Implement project A' });
    const taskB = b.taskBoard.createTask({ subject: 'Implement project B' });

    expect(a.taskBoard.listTasks().map((t) => t.subject)).toEqual(['Implement project A']);
    expect(b.taskBoard.listTasks().map((t) => t.subject)).toEqual(['Implement project B']);
    expect(fs.existsSync(path.join(f.claudeDir, 'tasks', 'ptc-project-a', taskA.id + '.json')))
      .toBe(true);
    expect(fs.existsSync(path.join(f.claudeDir, 'tasks', 'ptc-project-b', taskB.id + '.json')))
      .toBe(true);

    const messageA = a.messages.sendMessage({ from: 'bob', to: 'user', text: 'A completed' });
    const messageB = b.messages.sendMessage({ from: 'bob', to: 'user', text: 'B completed' });
    const inbox = (teamName) => JSON.parse(fs.readFileSync(
      path.join(f.claudeDir, 'teams', teamName, 'inboxes', 'user.json'), 'utf8'
    ));
    const inboxA = inbox('ptc-project-a');
    const inboxB = inbox('ptc-project-b');
    expect(inboxA.some((m) => m.text === 'A completed')).toBe(true);
    expect(inboxB.some((m) => m.text === 'B completed')).toBe(true);
    expect(inboxA.some((m) => m.text === 'B completed')).toBe(false);
    expect(inboxB.some((m) => m.text === 'A completed')).toBe(false);
    expect(messageA.messageId).not.toBe(messageB.messageId);

    // Recreating controllers simulates a desktop restart without migrating
    // or merging any physical native history.
    expect(f.makeTeam('ptc-project-a').taskBoard.listTasks().map((t) => t.subject))
      .toContain('Implement project A');
  });

  it('retains the original shared team namespace when selected project changes', () => {
    const f = setup();
    const original = f.makeTeam('legacy-shared');
    original.taskBoard.createTask({ subject: 'Shared legacy task' });
    const restarted = createController({ teamName: 'legacy-shared', claudeDir: f.claudeDir });
    expect(restarted.taskBoard.listTasks().map((t) => t.subject))
      .toContain('Shared legacy task');
    expect(fs.existsSync(path.join(f.claudeDir, 'tasks', 'legacy-shared'))).toBe(true);
  });
});
