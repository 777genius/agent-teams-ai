import type { PtyKeyAction } from './ports';

export type StartupReadinessState =
  | {
      phase: 'dialog';
      ruleId: string;
      actions: PtyKeyAction[];
      retryPolicy: 'once' | 'typed_retry';
      evidence: string[];
    }
  | { phase: 'ready'; evidence: string[] }
  | { phase: 'setup_required'; code: string; evidence: string[] }
  | { phase: 'loading'; evidence?: string[] };

export const PTY_KEY_ACTIONS = {
  enter: { id: 'enter', label: 'Enter', sequence: '\r' },
  down: { id: 'down', label: 'Down', sequence: '\u001b[B' },
  up: { id: 'up', label: 'Up', sequence: '\u001b[A' },
} satisfies Record<string, PtyKeyAction>;

export function stripAnsiSequences(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, '');
}

export function normalizeTerminalText(value: string): string {
  return stripAnsiSequences(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function containsAll(value: string, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(value));
}

function compactForTuiMatch(value: string): string {
  return value.replace(/[\s'",.:;!?()[\]{}<>|·•\-_]+/g, '');
}

function hasClaudeWorkspaceTrustPrompt(lower: string, compact: string): boolean {
  const knownPrompt =
    containsAll(lower, [
      /quick safety check|project you created|workspace trust/,
      /trust this folder/,
    ]) ||
    (/(quicksafetycheck|projectyoucreated|workspacetrust)/.test(compact) &&
      compact.includes('trustthisfolder'));
  if (knownPrompt) {
    return true;
  }

  const hasClaudeSpecificContext =
    /claude code|quick safety|accessing workspace|project you created|workspace trust|read,\s*edit,\s*and\s*execute files/.test(
      lower
    ) ||
    /claudecode|quicksafety|accessingworkspace|projectyoucreated|workspacetrust|readeditandexecutefiles/.test(
      compact
    );
  if (!hasClaudeSpecificContext) {
    return false;
  }

  const hasTrustQuestion =
    /(do you trust|trust.*(?:folder|workspace|project|directory)|(?:folder|workspace|project|directory).*trust|created.*trust)/.test(
      lower
    ) ||
    /(doyoutrust|trust(?:this)?(?:folder|workspace|project|directory)|(?:folder|workspace|project|directory).*trust|created.*trust)/.test(
      compact
    );
  const hasTrustAction =
    /(yes.*trust|i trust|trust this (?:folder|workspace|project|directory)|continue)/.test(lower) ||
    /(yes.*trust|itrust|trustthis(?:folder|workspace|project|directory)|yescontinue)/.test(compact);

  return hasTrustQuestion && hasTrustAction;
}

export function detectClaudeStartupState(snapshotText: string): StartupReadinessState {
  const normalized = normalizeTerminalText(snapshotText);
  const lower = normalized.toLowerCase();
  const compact = compactForTuiMatch(lower);

  if (hasClaudeWorkspaceTrustPrompt(lower, compact)) {
    return {
      phase: 'dialog',
      ruleId: 'claude.workspace_trust',
      actions: [PTY_KEY_ACTIONS.enter],
      retryPolicy: 'once',
      evidence: ['claude workspace trust prompt'],
    };
  }

  if (/do you trust the contents of this directory\?/i.test(normalized)) {
    return {
      phase: 'dialog',
      ruleId: 'codex.workspace_trust',
      actions: [PTY_KEY_ACTIONS.enter],
      retryPolicy: 'once',
      evidence: ['codex workspace trust prompt'],
    };
  }

  if (/update available/i.test(normalized) && /\bskip\b/i.test(normalized)) {
    return {
      phase: 'dialog',
      ruleId: 'codex.update_available',
      actions: [PTY_KEY_ACTIONS.down, PTY_KEY_ACTIONS.enter],
      retryPolicy: 'once',
      evidence: ['codex update prompt'],
    };
  }

  if (/bypass permissions|dangerously skip permissions/i.test(normalized)) {
    return {
      phase: 'dialog',
      ruleId: 'claude.bypass_permissions',
      actions: [PTY_KEY_ACTIONS.down, PTY_KEY_ACTIONS.enter],
      retryPolicy: 'typed_retry',
      evidence: ['claude bypass permissions prompt'],
    };
  }

  if (/custom api key|use.*api key|api key.*confirmation/i.test(normalized)) {
    return {
      phase: 'dialog',
      ruleId: 'claude.custom_api_key_confirmation',
      actions: [PTY_KEY_ACTIONS.up, PTY_KEY_ACTIONS.enter],
      retryPolicy: 'typed_retry',
      evidence: ['claude custom api key confirmation'],
    };
  }

  if (/log in to claude|not logged in|api key required|choose.*login|sign in/i.test(normalized)) {
    return {
      phase: 'setup_required',
      code: 'provider_auth_required',
      evidence: ['provider auth required prompt'],
    };
  }

  if (/>\s*$/.test(normalized) && /claude/i.test(normalized)) {
    return { phase: 'ready', evidence: ['claude prompt marker'] };
  }

  return { phase: 'loading' };
}
