/**
 * File icon mapping — maps file extensions/names to icon info.
 *
 * For programming languages and dev tools, uses Devicon CDN SVGs (colorful logos).
 * For generic file types (images, fonts, configs), falls back to lucide-react icons.
 */

import {
  Braces,
  Code,
  Database,
  File,
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
  /** Devicon slug — when set, FileIcon component renders the real logo from CDN */
  deviconSlug?: string;
}

// =============================================================================
// Devicon CDN
// =============================================================================

const DEVICON_BASE = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons';

/**
 * Build Devicon CDN URL for a given slug.
 * Uses `-original` variant (colorful) with `-wordmark` fallback.
 */
export function getDeviconUrl(slug: string): string {
  return `${DEVICON_BASE}/${slug}/${slug}-original.svg`;
}

// =============================================================================
// Extension → Icon mapping
// =============================================================================

const EXTENSION_MAP: Record<string, FileIconInfo> = {
  // TypeScript / JavaScript
  ts: { icon: Code, color: '#3178c6', deviconSlug: 'typescript' },
  tsx: { icon: Code, color: '#3178c6', deviconSlug: 'react' },
  js: { icon: Code, color: '#f7df1e', deviconSlug: 'javascript' },
  jsx: { icon: Code, color: '#61dafb', deviconSlug: 'react' },
  mjs: { icon: Code, color: '#f7df1e', deviconSlug: 'javascript' },
  cjs: { icon: Code, color: '#f7df1e', deviconSlug: 'javascript' },

  // Web
  html: { icon: Code, color: '#e34c26', deviconSlug: 'html5' },
  htm: { icon: Code, color: '#e34c26', deviconSlug: 'html5' },
  css: { icon: Code, color: '#1572b6', deviconSlug: 'css3' },
  scss: { icon: Code, color: '#c6538c', deviconSlug: 'sass' },
  less: { icon: Code, color: '#1d365d', deviconSlug: 'less' },
  vue: { icon: Code, color: '#42b883', deviconSlug: 'vuejs' },
  svelte: { icon: Code, color: '#ff3e00', deviconSlug: 'svelte' },

  // Data / Config (no devicon — lucide fallbacks)
  json: { icon: FileJson, color: '#cbcb41', deviconSlug: 'json' },
  jsonl: { icon: FileJson, color: '#cbcb41' },
  yaml: { icon: Settings, color: '#cb171e', deviconSlug: 'yaml' },
  yml: { icon: Settings, color: '#cb171e', deviconSlug: 'yaml' },
  toml: { icon: Settings, color: '#9c4121' },
  xml: { icon: Code, color: '#e37933', deviconSlug: 'xml' },
  csv: { icon: Database, color: '#4caf50' },

  // Markdown / Text
  md: { icon: FileText, color: '#519aba', deviconSlug: 'markdown' },
  mdx: { icon: FileText, color: '#519aba', deviconSlug: 'markdown' },
  txt: { icon: FileText, color: '#89949f' },
  rst: { icon: FileText, color: '#89949f' },

  // Python
  py: { icon: Code, color: '#3572a5', deviconSlug: 'python' },
  pyx: { icon: Code, color: '#3572a5', deviconSlug: 'python' },
  pyi: { icon: Code, color: '#3572a5', deviconSlug: 'python' },

  // Rust
  rs: { icon: Code, color: '#dea584', deviconSlug: 'rust' },

  // Go
  go: { icon: Code, color: '#00add8', deviconSlug: 'go' },

  // Ruby
  rb: { icon: Code, color: '#cc342d', deviconSlug: 'ruby' },
  gemspec: { icon: Code, color: '#cc342d', deviconSlug: 'ruby' },

  // Java / Kotlin
  java: { icon: Code, color: '#b07219', deviconSlug: 'java' },
  kt: { icon: Code, color: '#a97bff', deviconSlug: 'kotlin' },
  kts: { icon: Code, color: '#a97bff', deviconSlug: 'kotlin' },

  // C / C++ / C#
  c: { icon: Code, color: '#555555', deviconSlug: 'c' },
  h: { icon: Code, color: '#555555', deviconSlug: 'c' },
  cpp: { icon: Code, color: '#f34b7d', deviconSlug: 'cplusplus' },
  hpp: { icon: Code, color: '#f34b7d', deviconSlug: 'cplusplus' },
  cc: { icon: Code, color: '#f34b7d', deviconSlug: 'cplusplus' },
  cs: { icon: Code, color: '#178600', deviconSlug: 'csharp' },

  // Shell
  sh: { icon: Terminal, color: '#89e051', deviconSlug: 'bash' },
  bash: { icon: Terminal, color: '#89e051', deviconSlug: 'bash' },
  zsh: { icon: Terminal, color: '#89e051', deviconSlug: 'bash' },
  fish: { icon: Terminal, color: '#89e051' },

  // SQL
  sql: { icon: Database, color: '#e38c00', deviconSlug: 'azuresqldatabase' },

  // Images (no devicon — lucide Image icon)
  png: { icon: Image, color: '#a074c4' },
  jpg: { icon: Image, color: '#a074c4' },
  jpeg: { icon: Image, color: '#a074c4' },
  gif: { icon: Image, color: '#a074c4' },
  svg: { icon: Image, color: '#ffb13b' },
  ico: { icon: Image, color: '#a074c4' },
  webp: { icon: Image, color: '#a074c4' },

  // Fonts (no devicon — lucide FileType icon)
  woff: { icon: FileType, color: '#89949f' },
  woff2: { icon: FileType, color: '#89949f' },
  ttf: { icon: FileType, color: '#89949f' },
  otf: { icon: FileType, color: '#89949f' },

  // Config files (no devicon — lucide icons)
  env: { icon: Lock, color: '#e5a00d' },
  ini: { icon: Settings, color: '#89949f' },
  conf: { icon: Settings, color: '#89949f' },
  cfg: { icon: Settings, color: '#89949f' },

  // Other languages
  graphql: { icon: Braces, color: '#e535ab', deviconSlug: 'graphql' },
  gql: { icon: Braces, color: '#e535ab', deviconSlug: 'graphql' },
  proto: { icon: Code, color: '#89949f', deviconSlug: 'protobuf' },
  dart: { icon: Code, color: '#00b4ab', deviconSlug: 'dart' },
  swift: { icon: Code, color: '#f05138', deviconSlug: 'swift' },
  php: { icon: Code, color: '#4f5d95', deviconSlug: 'php' },
  r: { icon: Code, color: '#276dc3', deviconSlug: 'r' },
  lua: { icon: Code, color: '#000080', deviconSlug: 'lua' },
  pl: { icon: Code, color: '#39457e', deviconSlug: 'perl' },
  scala: { icon: Code, color: '#dc322f', deviconSlug: 'scala' },
  groovy: { icon: Code, color: '#4298b8', deviconSlug: 'groovy' },
  ex: { icon: Code, color: '#6e4a7e', deviconSlug: 'elixir' },
  exs: { icon: Code, color: '#6e4a7e', deviconSlug: 'elixir' },
  erl: { icon: Code, color: '#b83998', deviconSlug: 'erlang' },
  hs: { icon: Code, color: '#5e5086', deviconSlug: 'haskell' },
  clj: { icon: Code, color: '#db5855', deviconSlug: 'clojure' },
  fs: { icon: Code, color: '#b845fc', deviconSlug: 'fsharp' },
  zig: { icon: Code, color: '#f7a41d', deviconSlug: 'zig' },
  nim: { icon: Code, color: '#ffc200', deviconSlug: 'nimble' },
  tf: { icon: Code, color: '#7b42bc', deviconSlug: 'terraform' },
  hcl: { icon: Code, color: '#7b42bc', deviconSlug: 'terraform' },
};

// Special full filename mapping
const FILENAME_MAP: Record<string, FileIconInfo> = {
  Dockerfile: { icon: Code, color: '#2496ed', deviconSlug: 'docker' },
  'docker-compose.yml': { icon: Code, color: '#2496ed', deviconSlug: 'docker' },
  'docker-compose.yaml': { icon: Code, color: '#2496ed', deviconSlug: 'docker' },
  Makefile: { icon: Terminal, color: '#427819' },
  Rakefile: { icon: Terminal, color: '#cc342d', deviconSlug: 'ruby' },
  Gemfile: { icon: Code, color: '#cc342d', deviconSlug: 'ruby' },
  '.gitignore': { icon: Settings, color: '#f05032', deviconSlug: 'git' },
  '.gitattributes': { icon: Settings, color: '#f05032', deviconSlug: 'git' },
  '.eslintrc': { icon: Settings, color: '#4b32c3', deviconSlug: 'eslint' },
  '.prettierrc': { icon: Settings, color: '#56b3b4' },
  'tsconfig.json': { icon: Settings, color: '#3178c6', deviconSlug: 'typescript' },
  'package.json': { icon: FileJson, color: '#cb3837', deviconSlug: 'nodejs' },
  'pnpm-lock.yaml': { icon: Lock, color: '#f69220' },
  'package-lock.json': { icon: Lock, color: '#cb3837', deviconSlug: 'npm' },
  'yarn.lock': { icon: Lock, color: '#2c8ebb', deviconSlug: 'yarn' },
  LICENSE: { icon: FileText, color: '#d9b611' },
  'CLAUDE.md': { icon: FileText, color: '#d97706' },
  'Cargo.toml': { icon: Settings, color: '#dea584', deviconSlug: 'rust' },
  'go.mod': { icon: Settings, color: '#00add8', deviconSlug: 'go' },
  'go.sum': { icon: Lock, color: '#00add8', deviconSlug: 'go' },
  '.dockerignore': { icon: Settings, color: '#2496ed', deviconSlug: 'docker' },
  'vite.config.ts': { icon: Settings, color: '#646cff', deviconSlug: 'vitejs' },
  'vite.config.js': { icon: Settings, color: '#646cff', deviconSlug: 'vitejs' },
  'webpack.config.js': { icon: Settings, color: '#8dd6f9', deviconSlug: 'webpack' },
  'webpack.config.ts': { icon: Settings, color: '#8dd6f9', deviconSlug: 'webpack' },
  '.babelrc': { icon: Settings, color: '#f5da55', deviconSlug: 'babel' },
  'babel.config.js': { icon: Settings, color: '#f5da55', deviconSlug: 'babel' },
  'tailwind.config.js': { icon: Settings, color: '#06b6d4', deviconSlug: 'tailwindcss' },
  'tailwind.config.ts': { icon: Settings, color: '#06b6d4', deviconSlug: 'tailwindcss' },
  'next.config.js': { icon: Settings, color: '#000000', deviconSlug: 'nextjs' },
  'next.config.mjs': { icon: Settings, color: '#000000', deviconSlug: 'nextjs' },
  'nuxt.config.ts': { icon: Settings, color: '#00dc82', deviconSlug: 'nuxtjs' },
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
