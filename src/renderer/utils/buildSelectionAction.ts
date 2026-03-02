/**
 * Builds an EditorSelectionAction from a selection info + action type.
 *
 * Extracted as a utility so it can be imported in tests
 * without pulling in CodeMirror dependencies.
 */

import { getBasename } from '@shared/utils/platformPath';

import type { EditorSelectionAction, EditorSelectionInfo } from '@shared/types/editor';

// =============================================================================
// Code fence language map (lowercase identifiers for markdown)
// =============================================================================

const CODE_FENCE_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  jsonl: 'json',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  php: 'php',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  toml: 'toml',
  ini: 'ini',
};

/** Maps file extension to a code fence language identifier (lowercase). */
export function getCodeFenceLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return CODE_FENCE_LANG[ext] ?? '';
}

/**
 * Builds a file-mention action (no code selection, just the file reference).
 * Used when triggering "Create Task" / "Write Teammate" from the file tree context menu.
 */
export function buildFileAction(
  type: EditorSelectionAction['type'],
  filePath: string,
  projectPath?: string | null
): EditorSelectionAction {
  const fileName = getBasename(filePath) || 'file';
  const displayPath =
    projectPath && filePath.startsWith(projectPath + '/')
      ? filePath.slice(projectPath.length + 1)
      : filePath;
  return {
    type,
    filePath,
    fromLine: null,
    toLine: null,
    selectedText: '',
    formattedContext: `**${fileName}** (\`${displayPath}\`)`,
    displayPath,
  };
}

/** Builds a selection action with a formatted markdown code fence context. */
export function buildSelectionAction(
  type: EditorSelectionAction['type'],
  info: EditorSelectionInfo
): EditorSelectionAction {
  const fileName = getBasename(info.filePath) || 'file';
  const lang = getCodeFenceLanguage(fileName);
  const lineRef =
    info.fromLine === info.toLine
      ? `line ${info.fromLine}`
      : `lines ${info.fromLine}-${info.toLine}`;
  const formattedContext = `**${fileName}** (${lineRef}):\n\`\`\`${lang}\n${info.text}\n\`\`\``;
  return {
    type,
    filePath: info.filePath,
    fromLine: info.fromLine,
    toLine: info.toLine,
    selectedText: info.text,
    formattedContext,
  };
}
