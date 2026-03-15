import YAML from 'yaml';

import type { SkillDraftFile, SkillDraftTemplateInput } from '@shared/types/extensions';

const SKILL_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;
const SECTION_TITLES = ['When to use', 'Steps', 'Notes'] as const;

export interface SkillDraftOptions {
  rawContent: string;
  includeScripts: boolean;
  includeReferences: boolean;
  includeAssets: boolean;
}

export interface SkillTemplateParseResult extends Partial<SkillDraftTemplateInput> {
  bodyMarkdown?: string;
  hasStructuredSections: boolean;
  hasUnstructuredBody: boolean;
}

function trimTrailingWhitespace(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n')
    .trim();
}

export function buildSkillTemplate(input: SkillDraftTemplateInput): string {
  const whenToUse = normalizeSectionContent(input.whenToUse, [
    '- Add the conditions where this skill should be selected.',
  ]);
  const steps = normalizeSectionContent(input.steps, [
    '1. Describe the first step.',
    '2. Describe the second step.',
  ]);
  const notes = normalizeSectionContent(input.notes, [
    '- Add caveats, review rules, or references.',
  ]);
  const lines = [
    '---',
    `name: ${input.name || 'New Skill'}`,
    `description: ${input.description || 'Describe what this skill helps with.'}`,
    ...(input.license ? [`license: ${input.license}`] : []),
    ...(input.compatibility ? [`compatibility: ${input.compatibility}`] : []),
    ...(input.invocationMode === 'manual-only' ? ['disable-model-invocation: true'] : []),
    '---',
    '',
    `# ${input.name || 'New Skill'}`,
    '',
    input.description || 'Describe what this skill helps with.',
    '',
    '## When to use',
    ...whenToUse,
    '',
    '## Steps',
    ...steps,
    '',
    '## Notes',
    ...notes,
  ];

  return trimTrailingWhitespace(lines.join('\n'));
}

export function readSkillTemplateContent(rawContent: string): SkillTemplateParseResult {
  const content = rawContent.replace(/^\uFEFF/u, '');
  const match = content.match(SKILL_FRONTMATTER_PATTERN);
  if (!match) {
    return {
      hasStructuredSections: false,
      hasUnstructuredBody: content.trim().length > 0,
      bodyMarkdown: content.trim() || undefined,
    };
  }

  try {
    const parsed = YAML.parse(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const bodyMarkdown = (match[2] ?? '').trim() || undefined;
      return {
        hasStructuredSections: false,
        hasUnstructuredBody: Boolean(bodyMarkdown),
        bodyMarkdown,
      };
    }

    const data = parsed as Record<string, unknown>;
    const body = match[2] ?? '';
    const whenToUse = extractSection(body, 'When to use');
    const steps = extractSection(body, 'Steps');
    const notes = extractSection(body, 'Notes');
    const bodyMarkdown = body.trim() || undefined;
    const hasStructuredSections = Boolean(whenToUse || steps || notes);
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      license: typeof data.license === 'string' ? data.license : undefined,
      compatibility: typeof data.compatibility === 'string' ? data.compatibility : undefined,
      invocationMode: data['disable-model-invocation'] === true ? 'manual-only' : 'auto',
      whenToUse,
      steps,
      notes,
      bodyMarkdown,
      hasStructuredSections,
      hasUnstructuredBody: Boolean(bodyMarkdown) && !hasStructuredSections,
    };
  } catch {
    const bodyMarkdown = (match[2] ?? '').trim() || undefined;
    return {
      hasStructuredSections: false,
      hasUnstructuredBody: Boolean(bodyMarkdown),
      bodyMarkdown,
    };
  }
}

export function readSkillTemplateInput(rawContent: string): Partial<SkillDraftTemplateInput> {
  const {
    bodyMarkdown: _bodyMarkdown,
    hasStructuredSections: _hasStructuredSections,
    hasUnstructuredBody: _hasUnstructuredBody,
    ...input
  } = readSkillTemplateContent(rawContent);
  return input;
}

export function updateSkillTemplateFrontmatter(
  rawContent: string,
  input: SkillDraftTemplateInput
): string {
  const content = rawContent.replace(/^\uFEFF/u, '');
  const match = content.match(SKILL_FRONTMATTER_PATTERN);
  const body = match ? (match[2] ?? '') : content;

  let data: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = YAML.parse(match[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      data = {};
    }
  }

  data.name = input.name || 'New Skill';
  data.description = input.description || 'Describe what this skill helps with.';

  if (input.license) {
    data.license = input.license;
  } else {
    delete data.license;
  }

  if (input.compatibility) {
    data.compatibility = input.compatibility;
  } else {
    delete data.compatibility;
  }

  if (input.invocationMode === 'manual-only') {
    data['disable-model-invocation'] = true;
  } else {
    delete data['disable-model-invocation'];
  }

  const frontmatter = YAML.stringify(data).trimEnd();
  const normalizedBody = body.replace(/^\n+/u, '');
  return `---\n${frontmatter}\n---${normalizedBody ? `\n\n${normalizedBody}` : '\n'}`;
}

export function buildSkillDraftFiles(options: SkillDraftOptions): SkillDraftFile[] {
  const files: SkillDraftFile[] = [{ relativePath: 'SKILL.md', content: options.rawContent }];

  if (options.includeReferences) {
    files.push({
      relativePath: 'references/README.md',
      content: '# References\n\nAdd supporting docs, examples, or links for this skill.\n',
    });
  }

  if (options.includeScripts) {
    files.push({
      relativePath: 'scripts/README.md',
      content: '# Scripts\n\nAdd optional helper scripts used by this skill.\n',
    });
  }

  if (options.includeAssets) {
    files.push({
      relativePath: 'assets/README.md',
      content: '# Assets\n\nStore screenshots or other bundled assets here.\n',
    });
  }

  return files;
}

function normalizeSectionContent(value: string, fallbackLines: string[]): string[] {
  const lines = value
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(
      (line, index, allLines) =>
        line.length > 0 || allLines.some((candidate) => candidate.length > 0)
    );

  return lines.some((line) => line.trim().length > 0) ? lines : fallbackLines;
}

function extractSection(body: string, title: (typeof SECTION_TITLES)[number]): string | undefined {
  const normalizedBody = body.replace(/\r\n/g, '\n');
  const heading = `## ${title}\n`;
  const startIndex = normalizedBody.indexOf(heading);
  if (startIndex === -1) {
    return undefined;
  }

  const bodyStartIndex = startIndex + heading.length;
  const nextSectionIndex = SECTION_TITLES.map((sectionTitle) =>
    sectionTitle === title ? -1 : normalizedBody.indexOf(`\n## ${sectionTitle}\n`, bodyStartIndex)
  )
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const rawSection =
    nextSectionIndex === undefined
      ? normalizedBody.slice(bodyStartIndex)
      : normalizedBody.slice(bodyStartIndex, nextSectionIndex);

  return rawSection.trim() || undefined;
}
