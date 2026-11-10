import { parseNumericSuffixName, validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';
import YAML from 'yaml';

import type { TeamImportFolderSnapshot } from '../application/models/TeamImportFolderSnapshot';
import type { TeamImportPreview, TeamImportWarning } from '@features/team-import/contracts';

const MEMBER_PREFIX = `## Team collaboration
- When the lead assigns this board task, use task_start to mark it in progress.
- Follow the workflow below.
- Post the result to the board with task_add_comment.
- Mark the task completed with task_complete, then notify the lead with message_send.`;

const LEAD_PREFIX = `## Team collaboration
- Create board work with task_create. Always provide subject. Set owner only to an actual team member name.
- Use message_send to notify a member when a separate notification is useful.
- Read completed work from task comments after the member calls task_add_comment and task_complete.
- Create dependent work sequentially and independent work in parallel.
- Use Bash directly for work that does not need a teammate.
- Do not spawn replacement subagents with the built-in Task tool. Use the configured team members and board tasks.
- Wait for an explicit user request before starting the imported workflow.`;

interface ParsedFrontmatter {
  name?: string;
  skills: string[];
}

interface RewrittenClaudeMd {
  content: string;
  warnings: TeamImportWarning[];
  blockingErrors: string[];
}

export type TeamImportNameValidationCode =
  | 'teamNameRequired'
  | 'teamNameInvalidFormat'
  | 'teamNameReserved';

type ImportedMemberValidationCode = 'memberReserved' | 'memberInvalid' | 'memberReservedSuffix';

const WINDOWS_RESERVED_TEAM_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function parseTeamImportFrontmatter(content: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { skills: [] };

  try {
    const parsed: unknown = YAML.parse(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { skills: [] };
    const fields = parsed as Record<string, unknown>;
    const name = typeof fields.name === 'string' ? fields.name.trim() || undefined : undefined;
    const skills = Array.isArray(fields.skills)
      ? fields.skills
          .filter((skill): skill is string => typeof skill === 'string')
          .map((skill) => skill.trim())
          .filter(Boolean)
      : [];
    return { name, skills: [...new Set(skills)] };
  } catch {
    return { skills: [] };
  }
}

export function extractTeamImportMarkdownBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

export function suggestTeamImportName(folderName: string): string {
  const normalized = folderName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (!normalized) return 'imported-team';
  return WINDOWS_RESERVED_TEAM_NAMES.has(normalized) ? `team-${normalized}` : normalized;
}

export function validateTeamImportName(teamName: string): TeamImportNameValidationCode | null {
  const trimmed = teamName.trim();
  if (!trimmed) return 'teamNameRequired';
  if (trimmed.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    return 'teamNameInvalidFormat';
  }
  if (WINDOWS_RESERVED_TEAM_NAMES.has(trimmed)) {
    return 'teamNameReserved';
  }
  return null;
}

function validateImportedMemberName(name: string): ImportedMemberValidationCode | null {
  if (!name.trim()) return 'memberInvalid';
  const lower = name.toLowerCase();
  if (lower === 'user' || lower === 'team-lead' || lower === 'lead') {
    return 'memberReserved';
  }
  const formatError = validateTeamMemberNameFormat(name);
  if (formatError) return 'memberInvalid';
  const suffix = parseNumericSuffixName(name);
  if (suffix && suffix.suffix >= 2) {
    return 'memberReservedSuffix';
  }
  return null;
}

function buildMemberWorkflow(skills: string[], body: string): string {
  const skillLine =
    skills.length > 0
      ? `- Use the Skill tool when useful for: ${skills.join(', ')}.`
      : '- Use project skills when the workflow requires them.';
  return `${MEMBER_PREFIX}\n${skillLine}\n\n${body.trim()}`.trim();
}

function findTaskCalls(content: string): {
  calls: Array<{ start: number; end: number; text: string; args: string }>;
  malformedCalls: string[];
} {
  const calls: Array<{ start: number; end: number; text: string; args: string }> = [];
  const malformedCalls: string[] = [];
  const startPattern = /\bTask\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(content))) {
    const openIndex = content.indexOf('(', match.index);
    let quote: '"' | "'" | null = null;
    let escaped = false;
    let depth = 1;
    let index = openIndex + 1;
    for (; index < content.length; index += 1) {
      const char = content[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      malformedCalls.push(content.slice(match.index, match.index + 120));
      continue;
    }
    calls.push({
      start: match.index,
      end: index + 1,
      text: content.slice(match.index, index + 1),
      args: content.slice(openIndex + 1, index),
    });
    startPattern.lastIndex = index + 1;
  }
  return { calls, malformedCalls };
}

function decodeQuotedArgument(value: string): string {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function parseTaskArguments(args: string): Record<string, string | boolean> | null {
  const parsed: Record<string, string | boolean> = {};
  const ranges: Array<[number, number]> = [];
  const argumentPattern =
    /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|true|false)/g;
  let match: RegExpExecArray | null;
  while ((match = argumentPattern.exec(args))) {
    const rawValue = match[2];
    parsed[match[1]] =
      rawValue === 'true' ? true : rawValue === 'false' ? false : decodeQuotedArgument(rawValue);
    ranges.push([match.index, argumentPattern.lastIndex]);
  }
  if (ranges.length === 0) return null;
  let remainder = args;
  for (const [start, end] of ranges.reverse()) {
    remainder = `${remainder.slice(0, start)}${remainder.slice(end)}`;
  }
  if (remainder.replace(/[\s,]/g, '')) return null;
  return parsed;
}

export function rewriteClaudeMdForTeamImport(
  claudeMd: string,
  memberNames: readonly string[]
): RewrittenClaudeMd {
  const warnings: TeamImportWarning[] = [];
  const blockingErrors: string[] = [];
  const canonicalMembers = new Map(memberNames.map((name) => [name.toLowerCase(), name]));
  const { calls, malformedCalls } = findTaskCalls(claudeMd);
  let result = claudeMd;

  for (const malformedCall of malformedCalls) {
    warnings.push({ code: 'unsafeTaskCall', call: malformedCall });
  }
  if (malformedCalls.length > 0) {
    blockingErrors.push('One or more Task calls could not be converted safely.');
  }

  for (const call of calls.reverse()) {
    const args = parseTaskArguments(call.args);
    const description = typeof args?.description === 'string' ? args.description.trim() : '';
    const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
    if (!args || !description || !prompt) {
      warnings.push({ code: 'unsafeTaskCall', call: call.text.slice(0, 120) });
      blockingErrors.push('One or more Task calls could not be converted safely.');
      continue;
    }

    const requestedOwner =
      typeof args.subagent_type === 'string' ? args.subagent_type.trim().toLowerCase() : '';
    const owner = requestedOwner ? canonicalMembers.get(requestedOwner) : undefined;
    if (requestedOwner && !owner && requestedOwner !== 'general-purpose') {
      warnings.push({
        code: 'unknownTaskOwner',
        description,
        owner: String(args.subagent_type),
      });
    }

    const rewrittenArguments = [
      `subject=${JSON.stringify(description)}`,
      `description=${JSON.stringify(description)}`,
      `prompt=${JSON.stringify(prompt)}`,
      ...(owner ? [`owner=${JSON.stringify(owner)}`, 'startImmediately=true'] : []),
    ];
    const replacement = `task_create(${rewrittenArguments.join(', ')})`;
    result = `${result.slice(0, call.start)}${replacement}${result.slice(call.end)}`;
  }

  result = result
    .replace(
      /(?:use|用)\s+(?:the\s+)?Task\s+(?:tool\s+)?(?:to\s+dispatch|派发)(?:（subagent_type:\s*`?general-purpose`?）)?/gi,
      'use task_create to create board work'
    )
    .replace(/^或者用 claude CLI 的 --agents 参数加载本地 subagent 文件.*$\r?\n?/gm, '')
    .trim();

  return { content: result, warnings, blockingErrors: [...new Set(blockingErrors)] };
}

export function buildTeamImportPreview(
  snapshot: TeamImportFolderSnapshot
): Omit<TeamImportPreview, 'reviewId'> {
  const warnings = [...snapshot.warnings];
  const blockingErrors: string[] = [];
  const members: TeamImportPreview['members'] = [];
  const seenNames = new Set<string>();

  for (const file of snapshot.agentFiles) {
    const frontmatter = parseTeamImportFrontmatter(file.content);
    const name = (frontmatter.name || file.fileName.replace(/\.md$/i, '')).trim();
    const validationError = validateImportedMemberName(name);
    const normalized = name.toLowerCase();
    if (validationError) {
      warnings.push({ code: validationError, fileName: file.fileName, name });
      continue;
    }
    if (seenNames.has(normalized)) {
      warnings.push({ code: 'duplicateMember', fileName: file.fileName, name });
      continue;
    }
    seenNames.add(normalized);
    members.push({
      name,
      role: 'member',
      workflow: buildMemberWorkflow(
        frontmatter.skills,
        extractTeamImportMarkdownBody(file.content)
      ),
    });
  }

  if (members.length === 0) {
    blockingErrors.push('No valid agent definitions were found in agents/ or .claude/agents/.');
  }

  let prompt: string | undefined;
  if (snapshot.claudeMd) {
    const rewritten = rewriteClaudeMdForTeamImport(
      snapshot.claudeMd,
      members.map((member) => member.name)
    );
    warnings.push(...rewritten.warnings);
    blockingErrors.push(...rewritten.blockingErrors);
    prompt = `${LEAD_PREFIX}\n\n## Imported orchestration workflow\n\n${rewritten.content}`;
  } else {
    warnings.push({ code: 'missingClaudeMd' });
  }

  const skillsFound = [
    ...new Set(
      snapshot.skills
        .map((skill) => parseTeamImportFrontmatter(skill.content).name || skill.directoryName)
        .filter(Boolean)
    ),
  ].sort((left, right) => left.localeCompare(right));

  return {
    suggestedTeamName: suggestTeamImportName(snapshot.folderName),
    projectPath: snapshot.projectPath,
    members,
    prompt,
    skillsFound,
    warnings,
    blockingErrors,
  };
}
