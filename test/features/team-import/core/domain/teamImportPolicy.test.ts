import {
  buildTeamImportPreview,
  parseTeamImportFrontmatter,
  rewriteClaudeMdForTeamImport,
  suggestTeamImportName,
} from '@features/team-import/core/domain/teamImportPolicy';
import { describe, expect, it } from 'vitest';

describe('teamImportPolicy', () => {
  it('parses inline and block skill frontmatter', () => {
    expect(
      parseTeamImportFrontmatter('---\nname: writer\nskills: [research, "editing"]\n---\nBody')
    ).toEqual({ name: 'writer', skills: ['research', 'editing'] });
    expect(
      parseTeamImportFrontmatter("---\nname: writer\nskills:\n  - research\n  - 'editing'\n---\n")
    ).toEqual({ name: 'writer', skills: ['research', 'editing'] });
  });

  it('rewrites Task calls with a required subject and an explicitly matched owner', () => {
    const rewritten = rewriteClaudeMdForTeamImport(
      'Task(prompt="Write the full draft", subagent_type="writer", description="Draft post")',
      ['writer']
    );

    expect(rewritten.content).toContain('task_create(');
    expect(rewritten.content).toContain('subject="Draft post"');
    expect(rewritten.content).toContain('description="Draft post"');
    expect(rewritten.content).toContain('prompt="Write the full draft"');
    expect(rewritten.content).toContain('owner="writer"');
    expect(rewritten.content).toContain('startImmediately=true');
    expect(rewritten.content).not.toContain('Task(');
  });

  it('never maps a task description to owner and preserves runtime date expressions', () => {
    const rewritten = rewriteClaudeMdForTeamImport(
      'Task(description="Research topic", prompt="Collect facts for $(date +%Y-%m-%d)")',
      ['researcher']
    );

    expect(rewritten.content).toContain('subject="Research topic"');
    expect(rewritten.content).not.toContain('owner="Research topic"');
    expect(rewritten.content).toContain('$(date +%Y-%m-%d)');
  });

  it('uses a valid bounded fallback for Unicode-only and long folder names', () => {
    expect(suggestTeamImportName('团队')).toBe('imported-team');
    expect(suggestTeamImportName('a'.repeat(100))).toHaveLength(64);
  });

  it('builds a reviewable preview and skips invalid or duplicate members', () => {
    const preview = buildTeamImportPreview({
      projectPath: '/project',
      folderName: 'Demo Team',
      agentFiles: [
        { fileName: 'writer.md', content: '---\nname: writer\n---\nWrite carefully.' },
        { fileName: 'duplicate.md', content: '---\nname: WRITER\n---\nDuplicate.' },
        { fileName: 'reserved.md', content: '---\nname: user\n---\nReserved.' },
      ],
      claudeMd: 'Task(description="Draft post", prompt="Write it", subagent_type="writer")',
      skills: [{ directoryName: 'editing', content: '---\nname: editing\n---\n' }],
      warnings: [],
    });

    expect(preview.suggestedTeamName).toBe('demo-team');
    expect(preview.members).toHaveLength(1);
    expect(preview.members[0].workflow).toContain('Write carefully.');
    expect(preview.prompt).toContain('owner="writer"');
    expect(preview.skillsFound).toEqual(['editing']);
    expect(preview.warnings.join('\n')).toContain('duplicate member');
    expect(preview.warnings.join('\n')).toContain('reserved');
    expect(preview.blockingErrors).toEqual([]);
  });

  it('blocks import when no valid agent definition remains', () => {
    const preview = buildTeamImportPreview({
      projectPath: '/project',
      folderName: 'Empty',
      agentFiles: [],
      skills: [],
      warnings: [],
    });

    expect(preview.blockingErrors).toHaveLength(1);
  });

  it('blocks confirmation when a Task call cannot be rewritten safely', () => {
    const preview = buildTeamImportPreview({
      projectPath: '/project',
      folderName: 'Demo',
      agentFiles: [{ fileName: 'writer.md', content: '---\nname: writer\n---\nWrite.' }],
      claudeMd: 'Task(unsupported={ nested: true })',
      skills: [],
      warnings: [],
    });

    expect(preview.blockingErrors).toContain(
      'One or more Task calls could not be converted safely.'
    );
  });
});
