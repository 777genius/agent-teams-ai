import { useCallback, useMemo, useRef, useState } from 'react';

import type { MentionSuggestion } from '@renderer/types/mention';

interface UseMentionDetectionOptions {
  suggestions: MentionSuggestion[];
  value: string;
  onValueChange: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** When true, detect @-trigger even if suggestions list is empty (e.g. for file-only search) */
  enableTriggerAlways?: boolean;
}

export interface DropdownPosition {
  top: number;
  left: number;
}

interface UseMentionDetectionResult {
  isOpen: boolean;
  query: string;
  filteredSuggestions: MentionSuggestion[];
  selectedIndex: number;
  dropdownPosition: DropdownPosition | null;
  selectSuggestion: (s: MentionSuggestion) => void;
  dismiss: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  /** Current @-trigger character position in text (-1 if no active trigger) */
  triggerIndex: number;
}

interface MentionTrigger {
  triggerIndex: number;
  query: string;
}

/**
 * CSS properties to copy from textarea to mirror div for accurate caret measurement.
 */
const MIRROR_PROPS = [
  'boxSizing',
  'width',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
] as const;

const MENTION_DROPDOWN_OFFSET_PX = 10;

/**
 * Calculates caret coordinates relative to the textarea element
 * using a mirror div technique.
 *
 * @param textarea - The textarea DOM element
 * @param position - Caret position in text
 * @param text - Text content (override textarea.value for pre-render accuracy)
 */
export function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
  text?: string
): { top: number; left: number; height: number } {
  const content = text ?? textarea.value;
  const computed = window.getComputedStyle(textarea);

  const mirror = document.createElement('div');
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.overflow = 'hidden';

  for (const prop of MIRROR_PROPS) {
    mirror.style.setProperty(prop, computed.getPropertyValue(prop));
  }

  mirror.textContent = content.substring(0, position);

  const span = document.createElement('span');
  span.textContent = content.substring(position) || '.';
  mirror.appendChild(span);

  document.body.appendChild(mirror);

  const lineHeight = parseInt(computed.lineHeight) || parseInt(computed.fontSize) * 1.2;
  const borderTop = parseInt(computed.borderTopWidth) || 0;

  const coords = {
    top: span.offsetTop + borderTop - textarea.scrollTop,
    left: span.offsetLeft + (parseInt(computed.borderLeftWidth) || 0) - textarea.scrollLeft,
    height: lineHeight,
  };

  document.body.removeChild(mirror);
  return coords;
}

/**
 * Scans backwards from cursor position to find an @ trigger.
 * Returns null if no valid trigger found.
 *
 * Rules:
 * - @ must be at start of text or preceded by whitespace
 * - Text between @ and cursor must not contain spaces
 */
export function findMentionTrigger(text: string, cursorPos: number): MentionTrigger | null {
  if (cursorPos <= 0) return null;

  const beforeCursor = text.slice(0, cursorPos);

  // Scan backwards to find @
  for (let i = beforeCursor.length - 1; i >= 0; i--) {
    const char = beforeCursor[i];

    // If we hit whitespace or newline before finding @, no valid trigger
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') return null;

    if (char === '@') {
      // @ must be at start or after whitespace/newline
      if (i > 0) {
        const preceding = beforeCursor[i - 1];
        if (preceding !== ' ' && preceding !== '\t' && preceding !== '\n' && preceding !== '\r') {
          return null;
        }
      }

      const query = beforeCursor.slice(i + 1);
      return { triggerIndex: i, query };
    }
  }

  return null;
}

export function useMentionDetection({
  suggestions,
  value,
  onValueChange,
  textareaRef,
  enableTriggerAlways,
}: UseMentionDetectionOptions): UseMentionDetectionResult {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const triggerIndexRef = useRef<number>(-1);
  // Track current query in a ref so detectTrigger can avoid resetting selectedIndex
  // on redundant selectionchange events (e.g. after ArrowDown/Up keyboard navigation)
  const queryRef = useRef('');

  const filteredSuggestions = useMemo(() => {
    if (!isOpen) return [];
    if (!query) return suggestions;
    const lower = query.toLowerCase();
    return suggestions.filter((s) => s.name.toLowerCase().includes(lower));
  }, [isOpen, query, suggestions]);

  const dismiss = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setSelectedIndex(0);
    setDropdownPosition(null);
    triggerIndexRef.current = -1;
    queryRef.current = '';
  }, []);

  const computeDropdownPosition = useCallback(
    (triggerIdx: number, text: string): void => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const coords = getCaretCoordinates(textarea, triggerIdx, text);
      setDropdownPosition({
        top: coords.top + coords.height + MENTION_DROPDOWN_OFFSET_PX,
        left: 0,
      });
    },
    [textareaRef]
  );

  const selectSuggestion = useCallback(
    (s: MentionSuggestion) => {
      const textarea = textareaRef.current;
      if (!textarea || triggerIndexRef.current < 0) return;

      const before = value.slice(0, triggerIndexRef.current);
      const after = value.slice(triggerIndexRef.current + 1 + query.length);
      const insertion = `@${s.name} `;
      const newValue = before + insertion + after;
      const newCursorPos = before.length + insertion.length;

      onValueChange(newValue);
      dismiss();

      // Set cursor position after React re-render
      requestAnimationFrame(() => {
        textarea.selectionStart = newCursorPos;
        textarea.selectionEnd = newCursorPos;
      });
    },
    [value, query, onValueChange, textareaRef, dismiss]
  );

  /**
   * Detects whether cursor is inside an @-trigger region and opens/dismisses the dropdown.
   *
   * Called from handleSelect (selectionchange) — must NOT reset selectedIndex when
   * the trigger is already active with the same query, otherwise ArrowDown/Up navigation
   * gets immediately undone by the selectionchange event that follows keydown.
   */
  const detectTrigger = useCallback(
    (cursorPos: number) => {
      const trigger = findMentionTrigger(value, cursorPos);
      if (trigger && (suggestions.length > 0 || enableTriggerAlways)) {
        const sameQuery =
          triggerIndexRef.current === trigger.triggerIndex && queryRef.current === trigger.query;
        triggerIndexRef.current = trigger.triggerIndex;
        queryRef.current = trigger.query;
        setQuery(trigger.query);
        setIsOpen(true);
        // Only reset selection when trigger/query actually changed —
        // preserves keyboard navigation index across redundant selectionchange events
        if (!sameQuery) {
          setSelectedIndex(0);
        }
        computeDropdownPosition(trigger.triggerIndex, value);
      } else {
        dismiss();
      }
    },
    [value, suggestions.length, enableTriggerAlways, dismiss, computeDropdownPosition]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onValueChange(newValue);

      // Detect trigger based on cursor position after the change
      const cursorPos = e.target.selectionStart;
      const trigger = findMentionTrigger(newValue, cursorPos);
      if (trigger && (suggestions.length > 0 || enableTriggerAlways)) {
        triggerIndexRef.current = trigger.triggerIndex;
        queryRef.current = trigger.query;
        setQuery(trigger.query);
        setIsOpen(true);
        // Text changed — always reset selection to first item
        setSelectedIndex(0);
        computeDropdownPosition(trigger.triggerIndex, newValue);
      } else {
        dismiss();
      }
    },
    [onValueChange, suggestions.length, enableTriggerAlways, dismiss, computeDropdownPosition]
  );

  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const target = e.target as HTMLTextAreaElement;
      detectTrigger(target.selectionStart);
    },
    [detectTrigger]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isOpen || filteredSuggestions.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % filteredSuggestions.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(
            (prev) => (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length
          );
          break;
        case 'Enter':
          e.preventDefault();
          selectSuggestion(filteredSuggestions[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          dismiss();
          break;
      }
    },
    [isOpen, filteredSuggestions, selectedIndex, selectSuggestion, dismiss]
  );

  return {
    isOpen,
    query,
    filteredSuggestions,
    selectedIndex,
    dropdownPosition,
    selectSuggestion,
    dismiss,
    handleKeyDown,
    handleChange,
    handleSelect,
    // eslint-disable-next-line react-hooks/refs -- expose current trigger position to caller
    triggerIndex: triggerIndexRef.current,
  };
}
