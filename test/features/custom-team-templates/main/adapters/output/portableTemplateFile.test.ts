import {
  buildCustomTeamTemplateFileName,
  serializeCustomTeamTemplatePortableFile,
} from '@features/custom-team-templates/core/domain/portableTemplateFile';
import { describe, expect, it } from 'vitest';

import type { PortableCustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';

describe('buildCustomTeamTemplateFileName', () => {
  it('keeps an ordinary name and appends the JSON extension', () => {
    expect(buildCustomTeamTemplateFileName('Release Pipeline')).toBe('Release Pipeline.json');
  });

  it('removes path separators and traversal segments', () => {
    expect(buildCustomTeamTemplateFileName('../Evil/Name')).toBe('Evil Name.json');
    expect(buildCustomTeamTemplateFileName('..\\..\\windows\\system32')).toBe(
      'windows system32.json'
    );
    expect(buildCustomTeamTemplateFileName('..')).toBe('custom-team-template.json');
    expect(buildCustomTeamTemplateFileName('/')).toBe('custom-team-template.json');
  });

  it('removes Windows-reserved characters and control characters', () => {
    expect(buildCustomTeamTemplateFileName('a<b>c:d"e/f\\g|h?i*j\u0000k')).toBe(
      'a b c d e f g h i j k.json'
    );
  });

  it('does not produce a reserved Windows device name', () => {
    expect(buildCustomTeamTemplateFileName('CON')).toBe('template-CON.json');
    expect(buildCustomTeamTemplateFileName('lpt1')).toBe('template-lpt1.json');
  });

  it('preserves Unicode and bounds the basename length', () => {
    expect(buildCustomTeamTemplateFileName('تیم محصول')).toBe('تیم محصول.json');
    const longName = buildCustomTeamTemplateFileName('a'.repeat(300));
    expect(longName.length).toBeLessThanOrEqual(80 + '.json'.length);
    expect(longName.endsWith('.json')).toBe(true);
  });

  it('falls back for blank names', () => {
    expect(buildCustomTeamTemplateFileName('   ')).toBe('custom-team-template.json');
    expect(buildCustomTeamTemplateFileName('')).toBe('custom-team-template.json');
  });

  it('never returns a directory component', () => {
    for (const name of ['../x', 'C:\\temp\\x', '/etc/passwd', '\\\\server\\share\\x']) {
      const fileName = buildCustomTeamTemplateFileName(name);
      expect(fileName).not.toContain('/');
      expect(fileName).not.toContain('\\');
      expect(fileName).not.toContain('..');
    }
  });
});

describe('serializeCustomTeamTemplatePortableFile', () => {
  const portable: PortableCustomTeamTemplateV1 = {
    format: 'agent-teams-custom-template',
    schemaVersion: 1,
    name: 'Unicode ✅',
    description: 'Multiline\ndescription',
    teamPrompt: 'Line 1\nLine 2',
    members: [{ name: 'عضو', role: 'Role\nTwo', workflow: 'Do\nThis' }, { name: 'plain' }],
  };

  it('writes the fixed portable key order and keeps unicode/multiline content', () => {
    const serialized = serializeCustomTeamTemplatePortableFile(portable);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([
      'format',
      'schemaVersion',
      'name',
      'description',
      'teamPrompt',
      'members',
    ]);
    expect(parsed).toEqual(portable);
    expect(serialized.endsWith('\n')).toBe(true);
  });

  it('omits undefined optional fields and never leaks extra properties', () => {
    const withExtras = {
      ...portable,
      templateId: 'tmpl-secret',
      revision: 9,
      members: [{ name: 'plain', provider: 'attacker' }],
    } as unknown as PortableCustomTeamTemplateV1;
    const serialized = serializeCustomTeamTemplatePortableFile(withExtras);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty('templateId');
    expect(parsed).not.toHaveProperty('revision');
    expect(parsed.members).toEqual([{ name: 'plain' }]);
    expect(serialized).not.toContain('attacker');
  });

  it('is deterministic for the same input', () => {
    expect(serializeCustomTeamTemplatePortableFile(portable)).toBe(
      serializeCustomTeamTemplatePortableFile(portable)
    );
  });
});
