/**
 * File icon mapping — maps file extensions to lucide-react icon names and colors.
 */

import {
  Braces,
  Code,
  Database,
  File,
  FileCode,
  FileJson,
  FileText,
  FileType,
  Image,
  Lock,
  Settings,
  Terminal,
} from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface FileIconInfo {
  icon: LucideIcon;
  color: string;
}

// =============================================================================
// Extension → Icon mapping
// =============================================================================

const EXTENSION_MAP: Record<string, FileIconInfo> = {
  // TypeScript / JavaScript
  ts: { icon: FileCode, color: '#3178c6' },
  tsx: { icon: FileCode, color: '#3178c6' },
  js: { icon: FileCode, color: '#f7df1e' },
  jsx: { icon: FileCode, color: '#61dafb' },
  mjs: { icon: FileCode, color: '#f7df1e' },
  cjs: { icon: FileCode, color: '#f7df1e' },

  // Web
  html: { icon: Code, color: '#e34c26' },
  htm: { icon: Code, color: '#e34c26' },
  css: { icon: FileCode, color: '#563d7c' },
  scss: { icon: FileCode, color: '#c6538c' },
  less: { icon: FileCode, color: '#1d365d' },
  vue: { icon: FileCode, color: '#42b883' },
  svelte: { icon: FileCode, color: '#ff3e00' },

  // Data / Config
  json: { icon: FileJson, color: '#cbcb41' },
  jsonl: { icon: FileJson, color: '#cbcb41' },
  yaml: { icon: Settings, color: '#cb171e' },
  yml: { icon: Settings, color: '#cb171e' },
  toml: { icon: Settings, color: '#9c4121' },
  xml: { icon: Code, color: '#e37933' },
  csv: { icon: Database, color: '#4caf50' },

  // Markdown / Text
  md: { icon: FileText, color: '#519aba' },
  mdx: { icon: FileText, color: '#519aba' },
  txt: { icon: FileText, color: '#89949f' },
  rst: { icon: FileText, color: '#89949f' },

  // Python
  py: { icon: FileCode, color: '#3572a5' },
  pyx: { icon: FileCode, color: '#3572a5' },
  pyi: { icon: FileCode, color: '#3572a5' },

  // Rust
  rs: { icon: FileCode, color: '#dea584' },

  // Go
  go: { icon: FileCode, color: '#00add8' },

  // Ruby
  rb: { icon: FileCode, color: '#cc342d' },
  gemspec: { icon: FileCode, color: '#cc342d' },

  // Java / Kotlin
  java: { icon: FileCode, color: '#b07219' },
  kt: { icon: FileCode, color: '#a97bff' },
  kts: { icon: FileCode, color: '#a97bff' },

  // C / C++
  c: { icon: FileCode, color: '#555555' },
  h: { icon: FileCode, color: '#555555' },
  cpp: { icon: FileCode, color: '#f34b7d' },
  hpp: { icon: FileCode, color: '#f34b7d' },
  cc: { icon: FileCode, color: '#f34b7d' },

  // Shell
  sh: { icon: Terminal, color: '#89e051' },
  bash: { icon: Terminal, color: '#89e051' },
  zsh: { icon: Terminal, color: '#89e051' },
  fish: { icon: Terminal, color: '#89e051' },

  // SQL
  sql: { icon: Database, color: '#e38c00' },

  // Images
  png: { icon: Image, color: '#a074c4' },
  jpg: { icon: Image, color: '#a074c4' },
  jpeg: { icon: Image, color: '#a074c4' },
  gif: { icon: Image, color: '#a074c4' },
  svg: { icon: Image, color: '#ffb13b' },
  ico: { icon: Image, color: '#a074c4' },
  webp: { icon: Image, color: '#a074c4' },

  // Fonts
  woff: { icon: FileType, color: '#89949f' },
  woff2: { icon: FileType, color: '#89949f' },
  ttf: { icon: FileType, color: '#89949f' },
  otf: { icon: FileType, color: '#89949f' },

  // Config files
  env: { icon: Lock, color: '#e5a00d' },
  ini: { icon: Settings, color: '#89949f' },
  conf: { icon: Settings, color: '#89949f' },
  cfg: { icon: Settings, color: '#89949f' },

  // Other
  graphql: { icon: Braces, color: '#e535ab' },
  gql: { icon: Braces, color: '#e535ab' },
  proto: { icon: Code, color: '#89949f' },
  dart: { icon: FileCode, color: '#00b4ab' },
  swift: { icon: FileCode, color: '#f05138' },
  php: { icon: FileCode, color: '#4f5d95' },
};

// Special full filename mapping
const FILENAME_MAP: Record<string, FileIconInfo> = {
  Dockerfile: { icon: FileCode, color: '#2496ed' },
  'docker-compose.yml': { icon: FileCode, color: '#2496ed' },
  'docker-compose.yaml': { icon: FileCode, color: '#2496ed' },
  Makefile: { icon: Terminal, color: '#427819' },
  Rakefile: { icon: Terminal, color: '#cc342d' },
  Gemfile: { icon: FileCode, color: '#cc342d' },
  '.gitignore': { icon: Settings, color: '#f05032' },
  '.gitattributes': { icon: Settings, color: '#f05032' },
  '.eslintrc': { icon: Settings, color: '#4b32c3' },
  '.prettierrc': { icon: Settings, color: '#56b3b4' },
  'tsconfig.json': { icon: Settings, color: '#3178c6' },
  'package.json': { icon: FileJson, color: '#cb3837' },
  'pnpm-lock.yaml': { icon: Lock, color: '#f69220' },
  'package-lock.json': { icon: Lock, color: '#cb3837' },
  'yarn.lock': { icon: Lock, color: '#2c8ebb' },
  LICENSE: { icon: FileText, color: '#d9b611' },
  'CLAUDE.md': { icon: FileText, color: '#d97706' },
};

const DEFAULT_ICON: FileIconInfo = { icon: File, color: '#89949f' };

// =============================================================================
// Public API
// =============================================================================

/**
 * Get icon info for a file by name.
 */
export function getFileIcon(fileName: string): FileIconInfo {
  // Check full filename first
  if (FILENAME_MAP[fileName]) return FILENAME_MAP[fileName];

  // Check extension
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;
  if (ext && EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];

  return DEFAULT_ICON;
}
