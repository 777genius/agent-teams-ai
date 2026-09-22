import type { ToolApprovalSettings } from '@shared/types/team';

// ---------------------------------------------------------------------------
// Safe bash command prefixes — commands that never need manual approval
// ---------------------------------------------------------------------------

const SAFE_PREFIXES: readonly string[] = [
  // Version control
  'git ',
  'git\t',
  // Package managers
  'pnpm ',
  'npm ',
  'npx ',
  'yarn ',
  // File inspection (read-only)
  'ls',
  'cat ',
  'head ',
  'tail ',
  'wc ',
  'less ',
  'more ',
  // Output
  'echo ',
  'printf ',
  // System info
  'pwd',
  'whoami',
  'hostname',
  'date',
  'uname',
  // Search & find (read-only)
  'find ',
  'grep ',
  'rg ',
  'fd ',
  'ag ',
  // Directory & file info
  'tree ',
  'which ',
  'type ',
  'file ',
  // Text processing (read-only)
  'diff ',
  'sort ',
  'uniq ',
  'tr ',
  'cut ',
  // Path utilities
  'basename ',
  'dirname ',
  'realpath ',
  'readlink ',
  // Environment
  'env',
  'printenv',
  // Scripting one-liners (read-only)
  'node -e',
  'node --eval',
  'python -c',
  'python3 -c',
];

// ---------------------------------------------------------------------------
// Dangerous patterns — these OVERRIDE safe prefixes and always need approval
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\s/, // rm (with space to avoid false positives like "rmdir" intent)
  /\brm$/, // bare "rm" at end
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bcurl\b.*\|\s*(ba)?sh/,
  /\bwget\b.*\|\s*(ba)?sh/,
  /\bmkfs\b/,
  /\bdd\b/,
  /\bkill\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  />\s*\//, // redirect to absolute path root
  /\beval\b/,
  /\bexec\b/,
  /\bformat\b/,
  /\bshutdown\b/,
  /\breboot\b/,
];

// ---------------------------------------------------------------------------
// File edit tools that can be auto-allowed
// ---------------------------------------------------------------------------

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AutoAllowResult {
  autoAllow: boolean;
  reason?: string;
}

/**
 * Determines whether a tool call should be auto-allowed based on user settings.
 *
 * Logic:
 * 1. File edit tools — auto-allow if `autoAllowFileEdits` is enabled
 * 2. Bash commands — check dangerous patterns FIRST (always block),
 *    then check safe prefixes (auto-allow if `autoAllowSafeBash` is enabled)
 * 3. Everything else — requires manual approval
 */
export function shouldAutoAllow(
  settings: ToolApprovalSettings,
  toolName: string,
  toolInput: Record<string, unknown>
): AutoAllowResult {
  // Auto-allow ALL tools (overrides everything)
  if (settings.autoAllowAll) {
    return { autoAllow: true, reason: 'auto_allow_all' };
  }

  // File edit auto-allow
  if (settings.autoAllowFileEdits && FILE_EDIT_TOOLS.has(toolName)) {
    return { autoAllow: true, reason: 'auto_allow_category' };
  }

  // Safe bash auto-allow
  if (settings.autoAllowSafeBash && toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
    if (!command) return { autoAllow: false };

    // Dangerous patterns override safe prefixes — check FIRST
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { autoAllow: false };
      }
    }

    // Check safe prefixes
    for (const prefix of SAFE_PREFIXES) {
      const trimmedPrefix = prefix.trimEnd();
      if (command === trimmedPrefix || command.startsWith(prefix)) {
        return { autoAllow: true, reason: 'auto_allow_category' };
      }
    }
  }

  return { autoAllow: false };
}
