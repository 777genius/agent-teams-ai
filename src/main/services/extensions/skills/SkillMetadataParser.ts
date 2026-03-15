import * as path from 'node:path';

import { createLogger } from '@shared/utils/logger';
import type {
  SkillCatalogItem,
  SkillDetail,
  SkillDirectoryFlags,
  SkillInvocationMode,
  SkillValidationIssue,
} from '@shared/types/extensions';
import YAML from 'yaml';

import type { ResolvedSkillRoot } from './SkillRootsResolver';

const logger = createLogger('Extensions:SkillParser');

const ALLOWED_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'disable-model-invocation',
]);

const LARGE_SKILL_FILE_BYTES = 50_000;

interface ParsedFrontmatter {
  rawFrontmatter: string | null;
  body: string;
  data: Record<string, unknown>;
  issues: SkillValidationIssue[];
}

interface BuildSkillInput {
  skillDir: string;
  folderName: string;
  skillFile: string;
  rawContent: string;
  modifiedAt: number;
  flags: SkillDirectoryFlags;
  root: ResolvedSkillRoot;
}

export interface SkillRelatedFiles {
  referencesFiles: string[];
  scriptFiles: string[];
  assetFiles: string[];
}

export class SkillMetadataParser {
  parseCatalogItem(input: BuildSkillInput): SkillCatalogItem {
    const { folderName, flags, modifiedAt, rawContent, root, skillDir, skillFile } = input;
    const parsed = this.parseFrontmatter(rawContent);
    const metadata = this.normalizeMetadata(parsed.data.metadata);
    const name = this.readString(parsed.data.name);
    const description = this.readString(parsed.data.description);
    const issues = [...parsed.issues];
    const fileBaseName = path.basename(skillFile);

    if (!name) {
      issues.push({
        code: 'missing-name',
        message: 'Skill frontmatter is missing a valid `name` field.',
        severity: 'error',
      });
    }

    if (!description) {
      issues.push({
        code: 'missing-description',
        message: 'Skill frontmatter is missing a valid `description` field.',
        severity: 'error',
      });
    }

    if (name && folderName !== name) {
      issues.push({
        code: 'folder-name-mismatch',
        message: `Folder name "${folderName}" does not match skill name "${name}".`,
        severity: 'error',
      });
    }

    if (fileBaseName !== 'SKILL.md') {
      issues.push({
        code: 'nonstandard-file-name',
        message: `Using "${fileBaseName}" instead of the standard "SKILL.md".`,
        severity: 'warning',
      });
    }

    const unknownKeys = Object.keys(parsed.data).filter(
      (key) => !ALLOWED_FRONTMATTER_KEYS.has(key)
    );
    if (unknownKeys.length > 0) {
      issues.push({
        code: 'unknown-frontmatter-keys',
        message: `Unknown frontmatter keys: ${unknownKeys.join(', ')}.`,
        severity: 'warning',
      });
    }

    if (Buffer.byteLength(rawContent, 'utf8') > LARGE_SKILL_FILE_BYTES) {
      issues.push({
        code: 'large-skill-file',
        message: 'SKILL.md is large and may be expensive to load into context.',
        severity: 'warning',
      });
    }

    if (flags.hasScripts) {
      issues.push({
        code: 'has-scripts',
        message:
          'This skill includes a scripts directory. Review bundled scripts before trusting it.',
        severity: 'warning',
      });
    }

    const allowedTools = this.readAllowedTools(parsed.data['allowed-tools']);
    if (allowedTools) {
      issues.push({
        code: 'allowed-tools-advisory',
        message:
          '`allowed-tools` is present, but this app does not enforce or verify runtime compatibility.',
        severity: 'warning',
      });
    }

    const compatibility = this.readString(parsed.data.compatibility);
    if (
      compatibility &&
      /(network|internet|online|env|environment|api key|credential)/iu.test(compatibility)
    ) {
      issues.push({
        code: 'compatibility-advisory',
        message:
          '`compatibility` mentions environment or network requirements that this app cannot verify.',
        severity: 'warning',
      });
    }

    const isValid = !issues.some((issue) => issue.severity === 'error');

    return {
      id: skillDir,
      sourceType: 'filesystem',
      name: name ?? folderName,
      description: description ?? 'Invalid skill metadata',
      folderName,
      scope: root.scope,
      rootKind: root.rootKind,
      projectRoot: root.projectRoot,
      discoveryRoot: root.rootPath,
      skillDir,
      skillFile,
      license: this.readString(parsed.data.license),
      compatibility,
      metadata,
      allowedTools,
      invocationMode: this.readInvocationMode(parsed.data['disable-model-invocation']),
      flags,
      isValid,
      issues,
      modifiedAt,
    };
  }

  parseDetail(
    item: SkillCatalogItem,
    rawContent: string,
    relatedFiles: SkillRelatedFiles
  ): SkillDetail {
    const parsed = this.parseFrontmatter(rawContent);

    return {
      item,
      body: parsed.body,
      rawContent,
      rawFrontmatter: parsed.rawFrontmatter,
      referencesFiles: relatedFiles.referencesFiles,
      scriptFiles: relatedFiles.scriptFiles,
      assetFiles: relatedFiles.assetFiles,
    };
  }

  private parseFrontmatter(rawContent: string): ParsedFrontmatter {
    const content = rawContent.replace(/^\uFEFF/, '');
    if (!content.startsWith('---')) {
      return {
        rawFrontmatter: null,
        body: content,
        data: {},
        issues: [
          {
            code: 'missing-frontmatter',
            message: 'SKILL.md is missing YAML frontmatter.',
            severity: 'error',
          },
        ],
      };
    }

    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
    if (!match) {
      return {
        rawFrontmatter: null,
        body: content,
        data: {},
        issues: [
          {
            code: 'invalid-frontmatter',
            message: 'Unable to parse YAML frontmatter block.',
            severity: 'error',
          },
        ],
      };
    }

    const rawFrontmatter = match[1];
    const body = match[2] ?? '';

    try {
      const parsed = YAML.parse(rawFrontmatter);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          rawFrontmatter,
          body,
          data: {},
          issues: [
            {
              code: 'invalid-frontmatter',
              message: 'YAML frontmatter must be a mapping/object.',
              severity: 'error',
            },
          ],
        };
      }

      return {
        rawFrontmatter,
        body,
        data: parsed as Record<string, unknown>,
        issues: [],
      };
    } catch (error) {
      logger.warn('Failed to parse skill frontmatter', error);
      return {
        rawFrontmatter,
        body,
        data: {},
        issues: [
          {
            code: 'invalid-frontmatter',
            message: 'YAML frontmatter contains invalid syntax.',
            severity: 'error',
          },
        ],
      };
    }
  }

  private normalizeMetadata(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, String(entryValue)])
    );
  }

  private readString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private readAllowedTools(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value.trim() || undefined;
    }
    if (Array.isArray(value)) {
      const tools = value.map((entry) => String(entry).trim()).filter(Boolean);
      return tools.length > 0 ? tools.join(' ') : undefined;
    }
    return undefined;
  }

  private readInvocationMode(value: unknown): SkillInvocationMode {
    return value === true ? 'manual-only' : 'auto';
  }
}
