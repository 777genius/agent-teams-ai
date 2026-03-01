/**
 * CodeMirror 6 language support — synchronous (bundled) + async fallback.
 *
 * Extracted from CodeMirrorDiffView.tsx for reuse by editor and diff views.
 */

import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { less } from '@codemirror/lang-less';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sass } from '@codemirror/lang-sass';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

import type { Extension } from '@codemirror/state';

/** Synchronous language extension for common file types (bundled by Vite) */
export function getSyncLanguageExtension(fileName: string): Extension | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({
        jsx: ext === 'tsx' || ext === 'jsx',
        typescript: ext === 'ts' || ext === 'tsx',
      });
    case 'py':
      return python();
    case 'json':
    case 'jsonl':
      return json();
    case 'css':
      return css();
    case 'scss':
      return sass({ indented: false });
    case 'sass':
      return sass({ indented: true });
    case 'less':
      return less();
    case 'html':
    case 'htm':
      return html();
    case 'xml':
    case 'svg':
      return xml();
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown();
    case 'yaml':
    case 'yml':
      return yaml();
    case 'rs':
      return rust();
    case 'go':
      return go();
    case 'java':
      return java();
    case 'c':
    case 'h':
    case 'cpp':
    case 'cxx':
    case 'cc':
    case 'hpp':
      return cpp();
    case 'php':
      return php();
    case 'sql':
      return sql();
    default:
      return null;
  }
}

/** Async fallback: match by filename via @codemirror/language-data for rare languages */
export function getAsyncLanguageDesc(fileName: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, fileName);
}

/** Human-readable language name from file extension (for status bar / tab labels) */
export function getLanguageFromFileName(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript (JSX)',
    js: 'JavaScript',
    jsx: 'JavaScript (JSX)',
    mjs: 'JavaScript',
    cjs: 'JavaScript',
    py: 'Python',
    json: 'JSON',
    jsonl: 'JSON Lines',
    css: 'CSS',
    scss: 'SCSS',
    sass: 'Sass',
    less: 'Less',
    html: 'HTML',
    htm: 'HTML',
    xml: 'XML',
    svg: 'SVG',
    md: 'Markdown',
    mdx: 'MDX',
    markdown: 'Markdown',
    yaml: 'YAML',
    yml: 'YAML',
    rs: 'Rust',
    go: 'Go',
    java: 'Java',
    c: 'C',
    h: 'C/C++ Header',
    cpp: 'C++',
    cxx: 'C++',
    cc: 'C++',
    hpp: 'C++ Header',
    php: 'PHP',
    sql: 'SQL',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    toml: 'TOML',
    ini: 'INI',
    conf: 'Config',
    txt: 'Plain Text',
  };
  return map[ext ?? ''] ?? 'Plain Text';
}
