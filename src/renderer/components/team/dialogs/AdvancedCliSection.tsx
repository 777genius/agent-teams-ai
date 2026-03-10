import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '@renderer/components/ui/popover';
import { parseCliArgs, PROTECTED_CLI_FLAGS } from '@shared/utils/cliArgsParser';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Terminal,
  XCircle,
} from 'lucide-react';

interface AdvancedCliSectionProps {
  teamName: string;
  /** All CLI args from parent (model, effort, permissions, resume, etc.) */
  internalArgs: string[];
  worktreeEnabled: boolean;
  onWorktreeEnabledChange: (enabled: boolean) => void;
  worktreeName: string;
  onWorktreeNameChange: (name: string) => void;
  customArgs: string;
  onCustomArgsChange: (args: string) => void;
}

/** Infrastructure flags that are dimmed in command preview. */
const INFRA_FLAGS = new Set([
  '--input-format',
  '--output-format',
  '--setting-sources',
  '--mcp-config',
  '--disallowedTools',
  '--verbose',
]);

type ValidationState = 'idle' | 'loading' | 'success' | 'error';
type TokenType = 'command' | 'visible' | 'infra' | 'custom';

/** Map token type → Tailwind color class (pure function, no state dependency). */
const TOKEN_COLOR_CLASS: Record<TokenType, string> = {
  command: 'text-text',
  visible: 'text-text',
  infra: 'text-text-muted',
  custom: 'text-emerald-400',
};

/** Read worktree history from localStorage for a given team. */
function readWorktreeHistory(teamName: string): string[] {
  try {
    const raw = localStorage.getItem(`team:worktreeHistory:${teamName}`);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Collapsible "Advanced" section for CreateTeamDialog and LaunchTeamDialog.
 * Contains: worktree checkbox with history, command preview, custom args + validate.
 */
export const AdvancedCliSection: React.FC<AdvancedCliSectionProps> = ({
  teamName,
  internalArgs,
  worktreeEnabled,
  onWorktreeEnabledChange,
  worktreeName,
  onWorktreeNameChange,
  customArgs,
  onCustomArgsChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [validationState, setValidationState] = useState<ValidationState>('idle');
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Read worktree history from localStorage; re-read when teamName changes
  const [worktreeHistory, setWorktreeHistory] = useState<string[]>(() =>
    readWorktreeHistory(teamName)
  );
  useEffect(() => {
    setWorktreeHistory(readWorktreeHistory(teamName));
  }, [teamName]);

  // Commit worktree name to history on blur
  const commitWorktreeName = useCallback(() => {
    const name = worktreeName.trim();
    if (!name) return;
    setWorktreeHistory((prev) => {
      const next = [name, ...prev.filter((n) => n !== name)].slice(0, 10);
      localStorage.setItem(`team:worktreeHistory:${teamName}`, JSON.stringify(next));
      return next;
    });
  }, [worktreeName, teamName]);

  // Build command preview tokens
  const previewTokens = useMemo(() => {
    const tokens: { text: string; type: 'command' | 'visible' | 'infra' | 'custom' }[] = [];
    tokens.push({ text: 'claude', type: 'command' });

    // Process internalArgs: classify each as visible or infra
    let i = 0;
    while (i < internalArgs.length) {
      const arg = internalArgs[i];
      const isInfra = INFRA_FLAGS.has(arg);
      const type = isInfra ? 'infra' : 'visible';
      tokens.push({ text: arg, type });
      // Check if next token is the value for this flag (not starting with --)
      if (i + 1 < internalArgs.length && !internalArgs[i + 1].startsWith('--')) {
        tokens.push({ text: internalArgs[i + 1], type });
        i += 2;
      } else {
        i += 1;
      }
    }

    // Worktree
    if (worktreeEnabled && worktreeName.trim()) {
      tokens.push({ text: '--worktree', type: 'visible' });
      tokens.push({ text: worktreeName.trim(), type: 'visible' });
    }

    // Custom args
    const parsed = parseCliArgs(customArgs);
    for (const t of parsed) {
      tokens.push({ text: t, type: 'custom' });
    }

    return tokens;
  }, [internalArgs, worktreeEnabled, worktreeName, customArgs]);

  // Validate handler
  const handleValidate = useCallback(async () => {
    if (!customArgs.trim()) return;
    setValidationState('loading');
    setValidationMessage(null);
    try {
      const result = await window.electronAPI.teams.validateCliArgs(customArgs);
      if (result.valid) {
        setValidationState('success');
        setValidationMessage('All flags valid');
      } else {
        setValidationState('error');
        const flags = result.invalidFlags ?? [];
        const unknown = flags.filter((f) => !PROTECTED_CLI_FLAGS.has(f));
        const protectedOnes = flags.filter((f) => PROTECTED_CLI_FLAGS.has(f));
        const parts: string[] = [];
        if (unknown.length > 0) parts.push(`Unknown: ${unknown.join(', ')}`);
        if (protectedOnes.length > 0) parts.push(`Protected: ${protectedOnes.join(', ')}`);
        setValidationMessage(parts.join(' | '));
      }
    } catch (err) {
      setValidationState('error');
      setValidationMessage(err instanceof Error ? err.message : 'Validation failed');
    }
  }, [customArgs]);

  // Reset validation when custom args change
  const handleCustomArgsChange = useCallback(
    (value: string) => {
      onCustomArgsChange(value);
      if (validationState !== 'idle') {
        setValidationState('idle');
        setValidationMessage(null);
      }
    },
    [onCustomArgsChange, validationState]
  );

  const filteredHistory = useMemo(
    () =>
      worktreeHistory.filter(
        (name) => name !== worktreeName && (!worktreeName || name.includes(worktreeName))
      ),
    [worktreeHistory, worktreeName]
  );

  return (
    <div className="mt-3">
      {/* Collapsible header */}
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-text"
        onClick={() => setIsOpen(!isOpen)}
      >
        <ChevronRight
          className={`size-3.5 transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
        />
        <Terminal className="size-3" />
        <span>Advanced</span>
      </button>

      {isOpen && (
        <div className="mt-2 space-y-3 pl-5">
          {/* Worktree */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                id={`worktree-${teamName}`}
                checked={worktreeEnabled}
                onCheckedChange={(value) => onWorktreeEnabledChange(value === true)}
              />
              <Label
                htmlFor={`worktree-${teamName}`}
                className="cursor-pointer text-xs font-normal text-text-secondary"
              >
                Use worktree
              </Label>
            </div>

            {worktreeEnabled && (
              <Popover open={showHistory && filteredHistory.length > 0}>
                <PopoverAnchor asChild>
                  <Input
                    placeholder="worktree-name"
                    className="h-7 font-mono text-xs"
                    value={worktreeName}
                    onChange={(e) => onWorktreeNameChange(e.target.value)}
                    onFocus={() => setShowHistory(true)}
                    onBlur={() => {
                      // Delay to allow click on history items
                      setTimeout(() => {
                        setShowHistory(false);
                        commitWorktreeName();
                      }, 150);
                    }}
                  />
                </PopoverAnchor>
                <PopoverContent
                  className="w-[var(--radix-popover-trigger-width)] p-1"
                  align="start"
                  sideOffset={2}
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-text-muted">
                    <Clock className="size-3" />
                    <span>Recent</span>
                  </div>
                  {filteredHistory.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="w-full rounded px-2 py-1 text-left font-mono text-xs text-text-secondary hover:bg-surface-raised hover:text-text"
                      onMouseDown={(e) => {
                        e.preventDefault(); // Prevent input blur
                        onWorktreeNameChange(name);
                        setShowHistory(false);
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            )}
          </div>

          {/* Command preview */}
          <div className="space-y-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
              Command preview
            </span>
            <div className="overflow-x-auto rounded border border-border bg-surface-sidebar px-2.5 py-1.5">
              <code className="flex flex-wrap gap-x-1 gap-y-0.5 font-mono text-[11px] leading-relaxed">
                {previewTokens.map((token, i) => (
                  <span key={i} className={TOKEN_COLOR_CLASS[token.type]}>
                    {token.text}
                  </span>
                ))}
              </code>
            </div>
          </div>

          {/* Custom arguments */}
          <div className="space-y-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
              Custom arguments
            </span>
            <div className="flex items-center gap-2">
              <Input
                placeholder="--max-turns 5"
                className="h-7 flex-1 font-mono text-xs"
                value={customArgs}
                onChange={(e) => handleCustomArgsChange(e.target.value)}
              />
              {customArgs.trim() && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={validationState === 'loading'}
                  onClick={handleValidate}
                >
                  {validationState === 'loading' ? (
                    <Loader2 className="mr-1 size-3 animate-spin" />
                  ) : null}
                  Validate
                </Button>
              )}
            </div>

            {/* Validation result */}
            {validationState === 'success' && validationMessage && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 className="size-3" />
                <span>{validationMessage}</span>
              </div>
            )}
            {validationState === 'error' && validationMessage && (
              <div className="flex items-start gap-1.5 text-xs">
                {validationMessage.includes('Protected') ? (
                  <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-400" />
                ) : (
                  <XCircle className="mt-0.5 size-3 shrink-0 text-red-400" />
                )}
                <span className="text-text-secondary">{validationMessage}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
