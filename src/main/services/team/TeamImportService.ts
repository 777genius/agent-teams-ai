/**
 * Team Import Service
 *
 * Inspects a local Claude Code agent team folder (agents/*.md or .claude/agents/*.md
 * + .claude/CLAUDE.md + .claude/skills/) and constructs a TeamImportPreviewResult
 * that can be fed to TeamDataService.createTeamConfig to build a draft team.
 *
 * Workflow rewriting is TS fixed-template (no LLM): member workflow = collaboration
 * prefix + original agent body; lead prompt = kanban prefix + CLAUDE.md verbatim.
 */

import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type { TeamImportPreviewResult, TeamProvisioningMemberInput } from '@shared/types/team';

const logger = createLogger('TeamImportService');

const MEMBER_PREFIX = `## 协作机制（在 agent-teams-ai team 里）
- 接到 lead 派的任务后，用 task_start 标记 in_progress
- 按下面流程干活
- 完成后用 task_add_comment 把结果 JSON 贴到 board（lead 读 comment 拿结果，这是主交付渠道）
- 再用 task_complete 标记 completed，用 message_send 通知 lead "done"`;

const LEAD_PREFIX = `## 协作机制（用 agent-teams MCP 工具操作 board）
- 派任务：task_create(owner="<member>", subject="...", description="...", prompt="<给 member 的指令>", startImmediately=true)
- 通知 member：message_send(member="<member>", text="...")
- 读 member 结果：member 干完会 task_add_comment（结果 JSON 贴在 comment）+ task_complete。你读该 task 的 comments 拿结果 JSON。
- member 的 task status 变 completed = 干完了。
- 串行：顺序派（Step N 完成再派 Step N+1）；并行：同时派 2 个 task_create（如写稿 ‖ 生图）
- 你自己干活（如跑发布脚本）用 Bash 工具，不必派 member
- ⚠️ 注意：用 task_create 派给 member，不要用 Task 工具 spawn sub-agent（软件里 member 是 team 成员，不是 sub-agent）
- ⚠️ 启动后等用户指令（对话/任务）再开始 pipeline，不要自动执行。用户说"开始"/"写一篇公众号"等明确指令后，才按下面的 pipeline 派任务。`;

/**
 * Parse simple YAML frontmatter. Extracts top-level scalar key:value pairs,
 * plus the `skills` array ([X, Y] format) and `name`.
 */
function parseFrontmatter(content: string): {
  name?: string;
  skills: string[];
  raw: Record<string, string>;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return { skills: [], raw: {} };

  const raw: Record<string, string> = {};
  let name: string | undefined;
  let skills: string[] = [];

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    raw[key] = value;
    if (key === 'name') name = value;
    if (key === 'skills') {
      const arrMatch = /\[([^\]]*)\]/.exec(value);
      if (arrMatch) {
        skills = arrMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      }
    }
  }
  return { name, skills, raw };
}

/** Extract markdown body after the frontmatter block. */
function extractBody(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  if (!match) return content;
  return content.slice(match[0].length);
}

/** Convert a folder name to kebab-case team name. */
function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Build member workflow = collaboration prefix + skill hint + original body. */
function buildMemberWorkflow(skills: string[], body: string): string {
  const skillLine =
    skills.length > 0
      ? `- skill：用 Skill tool 调用 ${skills.join('、')}`
      : `- skill：按需用 Skill tool 调用 .claude/skills/ 下的 skill`;
  return `${MEMBER_PREFIX}\n${skillLine}\n\n${body.trim()}`;
}

/** Rewrite CLAUDE.md for kanban model: Task() → task_create(), etc. */
function rewriteClaudeMdForKanban(claudeMd: string): string {
  let result = claudeMd;
  // 1. Task(description="X", prompt="Y") → task_create(owner="X", prompt="Y")（multiline match）
  result = result.replace(
    /Task\(\s*description\s*=\s*"([^"]*)"\s*,\s*prompt\s*=\s*"([^"]*)"\s*\)/g,
    'task_create(owner="$1", prompt="$2")'
  );
  // 2. "用 Task 工具派发（subagent_type: general-purpose）" → "用 task_create 派发"（兼容有无反引号）
  result = result.replace(
    /用 Task 工具派发（subagent_type:\s*`?general-purpose`?）/g,
    '用 task_create 派发'
  );
  // 3. $(date +%Y-%m-%d) → actual date (lead can't execute shell)
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  result = result.replace(/\$\(date \+%Y-%m-%d\)/g, `${yyyy}-${mm}-${dd}`);
  // 4. Remove "或者用 claude CLI 的 --agents 参数加载本地 subagent 文件" line (not applicable in software)
  result = result.replace(/^或者用 claude CLI 的 --agents 参数加载本地 subagent 文件.*$\n?/gm, '');
  return result.trim();
}

/** Build lead prompt = kanban prefix + rewritten CLAUDE.md (Task→task_create etc). */
function buildLeadPrompt(claudeMd: string): string {
  const rewritten = rewriteClaudeMdForKanban(claudeMd);
  return `${LEAD_PREFIX}\n\n## 编排逻辑（来自 .claude/CLAUDE.md，已适配看板模型）\n\n${rewritten}`;
}

async function readMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readSkillNames(skillsDir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
    const names: string[] = [];
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
          try {
            const content = await fs.promises.readFile(skillMd, 'utf8');
            const { name } = parseFrontmatter(content);
            names.push(name || e.name);
          } catch {
            names.push(e.name);
          }
        })
    );
    return names.sort();
  } catch {
    return [];
  }
}

/**
 * Inspect a local agent team folder and construct a preview.
 * Scans agents/*.md (root) or .claude/agents/*.md, .claude/CLAUDE.md, .claude/skills/.
 */
export async function inspectTeamFolder(folderPath: string): Promise<TeamImportPreviewResult> {
  const resolved = path.resolve(folderPath);
  const warnings: string[] = [];

  // Locate agent .md files: root agents/ first, then .claude/agents/
  const rootAgentsDir = path.join(resolved, 'agents');
  const claudeAgentsDir = path.join(resolved, '.claude', 'agents');
  let agentsDir = '';
  let agentFiles: string[] = [];
  agentFiles = await readMarkdownFiles(rootAgentsDir);
  if (agentFiles.length > 0) {
    agentsDir = rootAgentsDir;
  } else {
    agentFiles = await readMarkdownFiles(claudeAgentsDir);
    if (agentFiles.length > 0) agentsDir = claudeAgentsDir;
  }

  const members: TeamProvisioningMemberInput[] = [];
  for (const filename of agentFiles) {
    try {
      const content = await fs.promises.readFile(path.join(agentsDir, filename), 'utf8');
      const { name, skills } = parseFrontmatter(content);
      const memberName = name || filename.replace(/\.md$/, '');
      if (memberName === 'team-lead' || memberName === 'user') {
        warnings.push(`Skipped reserved member name in ${filename}: ${memberName}`);
        continue;
      }
      const body = extractBody(content);
      members.push({
        name: memberName,
        role: 'member',
        workflow: buildMemberWorkflow(skills, body),
      });
    } catch (error) {
      warnings.push(
        `Failed to read ${filename}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (members.length === 0) {
    warnings.push('No agent .md files found in agents/ or .claude/agents/');
  }

  // Read .claude/CLAUDE.md as lead prompt
  const claudeMdPath = path.join(resolved, '.claude', 'CLAUDE.md');
  let prompt: string | undefined;
  try {
    const claudeMd = await fs.promises.readFile(claudeMdPath, 'utf8');
    prompt = buildLeadPrompt(claudeMd);
  } catch {
    warnings.push('No .claude/CLAUDE.md found — lead prompt will be empty');
  }

  // Scan .claude/skills/
  const skillsDir = path.join(resolved, '.claude', 'skills');
  const skillsFound = await readSkillNames(skillsDir);

  const teamName = toKebabCase(path.basename(resolved));

  logger.debug(
    `Inspected ${resolved}: team=${teamName}, members=${members.length}, skills=${skillsFound.length}`
  );

  return {
    teamName,
    projectPath: resolved,
    members,
    prompt,
    claudeMdPath: fs.existsSync(claudeMdPath) ? claudeMdPath : undefined,
    skillsFound,
    warnings,
  };
}
