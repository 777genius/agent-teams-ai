/**
 * Hook for AddTriggerForm state management.
 * Extracts all useState calls and resetForm logic from AddTriggerForm.
 */

import { useCallback, useState } from 'react';

import type { TriggerContentType, TriggerMode, TriggerTokenType } from '@renderer/types/data';
import type { TriggerColor } from '@shared/constants/triggerColors';

interface AddTriggerFormState {
  // Section 1: General Info
  name: string;
  toolName: string;

  // Section 2: Trigger Condition
  mode: TriggerMode;

  // Section 3: Dynamic Configuration
  // Content match settings
  contentType: TriggerContentType;
  matchField: string;
  matchPattern: string;

  // Token threshold settings
  tokenThreshold: number;
  tokenType: TriggerTokenType;

  // Section 4: Advanced
  ignorePatterns: string[];

  // Section 5: Repository Scope
  repositoryIds: string[];

  // Display
  color: TriggerColor;

  // UI state
  isExpanded: boolean;
}

export interface AddTriggerFormStateReturn extends AddTriggerFormState {
  setName: (name: string) => void;
  setToolName: (toolName: string) => void;
  setMode: (mode: TriggerMode) => void;
  setContentType: (contentType: TriggerContentType) => void;
  setMatchField: (matchField: string) => void;
  setMatchPattern: (matchPattern: string) => void;
  setTokenThreshold: (threshold: number) => void;
  setTokenType: (tokenType: TriggerTokenType) => void;
  setIgnorePatterns: (patterns: string[]) => void;
  setRepositoryIds: (ids: string[]) => void;
  setColor: (color: TriggerColor) => void;
  setIsExpanded: (expanded: boolean) => void;
  resetForm: () => void;
}

/**
 * Hook for managing AddTriggerForm state.
 */
export function useAddTriggerFormState(): AddTriggerFormStateReturn {
  // Section 1: General Info
  const [name, setName] = useState('');
  const [toolName, setToolName] = useState<string>('');

  // Section 2: Trigger Condition
  const [mode, setMode] = useState<TriggerMode>('error_status');

  // Section 3: Dynamic Configuration
  // Content match settings
  const [contentType, setContentType] = useState<TriggerContentType>('tool_result');
  const [matchField, setMatchField] = useState<string>('content');
  const [matchPattern, setMatchPattern] = useState('');

  // Token threshold settings
  const [tokenThreshold, setTokenThreshold] = useState<number>(1000);
  const [tokenType, setTokenType] = useState<TriggerTokenType>('total');

  // Section 4: Advanced
  const [ignorePatterns, setIgnorePatterns] = useState<string[]>([]);

  // Section 5: Repository Scope
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);

  // Display
  const [color, setColor] = useState<TriggerColor>('red');

  // UI state
  const [isExpanded, setIsExpanded] = useState(false);

  const resetForm = useCallback(() => {
    setName('');
    setToolName('');
    setMode('error_status');
    setContentType('tool_result');
    setMatchField('content');
    setMatchPattern('');
    setTokenThreshold(1000);
    setTokenType('total');
    setIgnorePatterns([]);
    setRepositoryIds([]);
    // Intentionally do NOT reset color — preserve last-used color across triggers
  }, []);

  return {
    // State values
    name,
    toolName,
    mode,
    contentType,
    matchField,
    matchPattern,
    tokenThreshold,
    tokenType,
    ignorePatterns,
    repositoryIds,
    color,
    isExpanded,

    // Setters
    setName,
    setToolName,
    setMode,
    setContentType,
    setMatchField,
    setMatchPattern,
    setTokenThreshold,
    setTokenType,
    setIgnorePatterns,
    setRepositoryIds,
    setColor,
    setIsExpanded,
    resetForm,
  };
}
