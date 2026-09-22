/**
 * Standalone syntax highlighter using highlight.js.
 *
 * Highlights code without a full CodeMirror EditorView.
 * Outputs HTML strings with `hljs-*` CSS classes (already styled in index.css).
 */

import hljs from 'highlight.js';

// =============================================================================
// File extension → highlight.js language mapping
// =============================================================================

const EXT_TO_LANG: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.html': 'xml',
  '.htm': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.sql': 'sql',
  '.md': 'markdown',
  '.toml': 'ini',
  '.ini': 'ini',
  '.lua': 'lua',
  '.r': 'r',
  '.scala': 'scala',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.pl': 'perl',
  '.pm': 'perl',
  '.m': 'objectivec',
  '.mm': 'objectivec',
  '.makefile': 'makefile',
  '.cmake': 'cmake',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.vue': 'xml',
  '.svelte': 'xml',
};

function getLanguage(fileName: string): string | undefined {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) return undefined;
  const ext = fileName.slice(dotIndex).toLowerCase();

  // Explicit map first, then try extension as hljs alias (e.g. 'rb', 'py')
  const mapped = EXT_TO_LANG[ext];
  if (mapped) return mapped;

  const bare = ext.slice(1); // '.ts' → 'ts'
  if (bare && hljs.getLanguage(bare)) return bare;

  return undefined;
}

// =============================================================================
// HTML line splitting
// =============================================================================

/** Escape HTML and split into plain-text lines (fallback for unknown languages). */
function escapeAndSplit(code: string): string[] {
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.split('\n');
}

/**
 * Split highlight.js HTML output into per-line strings with balanced tags.
 * Multi-line spans (comments, strings) are properly closed/reopened at line breaks.
 */
function splitHtmlByLines(html: string): string[] {
  const rawLines = html.split('\n');
  const result: string[] = [];
  const openTags: string[] = [];

  for (const rawLine of rawLines) {
    // Prefix with any spans still open from previous lines
    const prefix = openTags.join('');
    const fullLine = prefix + rawLine;

    // Update open tags stack by scanning this line's tags
    const tagRegex = /<span[^>]*>|<\/span>/g;
    let match;
    while ((match = tagRegex.exec(rawLine)) !== null) {
      if (match[0] === '</span>') {
        if (openTags.length > 0) openTags.pop();
      } else {
        openTags.push(match[0]);
      }
    }

    // Close any unclosed spans for this line
    const suffix = '</span>'.repeat(openTags.length);
    result.push(fullLine + suffix);
  }

  return result;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Highlight code and return per-line HTML strings with `hljs-*` CSS classes.
 * Uses highlight.js (same library as rehype-highlight in markdown rendering).
 */
export function highlightLines(code: string, fileName: string): string[] {
  if (!code) return [''];

  const lang = getLanguage(fileName);

  let highlighted: string;
  if (!lang) {
    // Unknown extension — plain text is safer than unreliable auto-detection
    return escapeAndSplit(code);
  }

  try {
    highlighted = hljs.highlight(code, { language: lang }).value;
  } catch {
    return escapeAndSplit(code);
  }

  return splitHtmlByLines(highlighted);
}
