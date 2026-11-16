import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';

import { isImeComposing } from '@renderer/utils/imeComposition';
import {
  getSuggestionInsertionText,
  getSuggestionTriggerChar,
} from '@renderer/utils/mentionSuggestions';

import type { MentionSuggestion } from '@renderer/types/mention';

interface UseMentionDetectionOptions {
  value: string;
  onValueChange: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Supported trigger characters, e.g. ['@', '#'] */
  triggerChars?: string[];
  /** Enable or disable individual triggers dynamically. */
  isTriggerEnabled?: (triggerChar: string) => boolean;
  /** Additional validation for trigger matches before opening the dropdown. */
  isTriggerMatchValid?: (trigger: MentionTrigger, text: string) => boolean;
}

export interface DropdownPosition {
  top: number;
  left: number;
}

interface UseMentionDetectionResult {
  isOpen: boolean;
  activeTriggerChar: string | null;
  query: string;
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  dropdownPosition: DropdownPosition | null;
  selectSuggestion: (s: MentionSuggestion) => void;
  dismiss: () => void;
  handleKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    suggestionCount: number,
    onSelectSuggestion: (index: number) => void
  ) => void;
  handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  /** Getter for trigger index — use at call time to avoid stale closure (returns -1 if no active trigger) */
  getTriggerIndex: () => number;
}

interface MentionTrigger {
  triggerIndex: number;
  triggerChar: string;
  query: string;
}

interface PendingInputObservation {
  element: HTMLTextAreaElement;
  text: string;
  selectionStart: number;
  selectionEnd: number;
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
 * Scans backwards from cursor position to find an active trigger.
 * Returns null if no valid trigger found.
 *
 * Rules:
 * - trigger must be at start of text or preceded by whitespace
 * - Text between trigger and cursor must not contain spaces
 */
export function findMentionTrigger(
  text: string,
  cursorPos: number,
  triggerChars: string[] = ['@']
): MentionTrigger | null {
  if (cursorPos <= 0) return null;

  const beforeCursor = text.slice(0, cursorPos);
  const allowedTriggerChars = new Set(triggerChars);

  // Scan backwards to find @
  for (let i = beforeCursor.length - 1; i >= 0; i--) {
    const char = beforeCursor[i];

    // If we hit whitespace or newline before finding a trigger, no valid trigger
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') return null;

    if (allowedTriggerChars.has(char)) {
      // trigger must be at start or after whitespace/newline
      if (i > 0) {
        const preceding = beforeCursor[i - 1];
        if (preceding !== ' ' && preceding !== '\t' && preceding !== '\n' && preceding !== '\r') {
          return null;
        }
      }

      const query = beforeCursor.slice(i + 1);
      return { triggerIndex: i, triggerChar: char, query };
    }
  }

  return null;
}

export function useMentionDetection({
  value,
  onValueChange,
  textareaRef,
  triggerChars = ['@'],
  isTriggerEnabled,
  isTriggerMatchValid,
}: UseMentionDetectionOptions): UseMentionDetectionResult {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTriggerChar, setActiveTriggerChar] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const triggerIndexRef = useRef<number>(-1);
  const activeTriggerCharRef = useRef<string | null>(null);
  // Track current query in a ref so detectTrigger can avoid resetting selectedIndex
  // on redundant selectionchange events (e.g. after ArrowDown/Up keyboard navigation)
  const queryRef = useRef('');
  const pendingInputRef = useRef<PendingInputObservation | null>(null);
  const enabledTriggerSignature = JSON.stringify(
    [...new Set(triggerChars)].filter((char) => isTriggerEnabled?.(char) ?? true).sort()
  );
  const previousEnabledTriggerSignatureRef = useRef(enabledTriggerSignature);

  const dismiss = useCallback(() => {
    pendingInputRef.current = null;
    setIsOpen(false);
    setActiveTriggerChar(null);
    setQuery('');
    setSelectedIndex(0);
    setDropdownPosition(null);
    triggerIndexRef.current = -1;
    activeTriggerCharRef.current = null;
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
      const triggerChar = activeTriggerCharRef.current;
      if (!textarea || triggerIndexRef.current < 0 || !triggerChar) return;

      const before = value.slice(0, triggerIndexRef.current);
      const after = value.slice(triggerIndexRef.current + 1 + queryRef.current.length);
      const suggestionText = getSuggestionInsertionText(s);
      const expectedTriggerChar = getSuggestionTriggerChar(s);
      const insertionBody =
        triggerChar === expectedTriggerChar && suggestionText.startsWith(triggerChar)
          ? suggestionText
          : `${triggerChar}${suggestionText}`;
      const insertion = `${insertionBody} `;
      const newValue = before + insertion + after;
      const newCursorPos = before.length + insertion.length;

      onValueChange(newValue);
      dismiss();

      // Set cursor position after React re-render
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      });
    },
    [value, onValueChange, textareaRef, dismiss]
  );

  const activateTrigger = useCallback(
    (trigger: MentionTrigger, text: string, resetSelection: boolean) => {
      const sameQuery =
        triggerIndexRef.current === trigger.triggerIndex &&
        activeTriggerCharRef.current === trigger.triggerChar &&
        queryRef.current === trigger.query;
      pendingInputRef.current = null;
      triggerIndexRef.current = trigger.triggerIndex;
      activeTriggerCharRef.current = trigger.triggerChar;
      queryRef.current = trigger.query;
      setActiveTriggerChar(trigger.triggerChar);
      setQuery(trigger.query);
      setIsOpen(true);
      // A repeated select must not undo ArrowDown/Up; text changes reset the index.
      if (resetSelection || !sameQuery) setSelectedIndex(0);
      computeDropdownPosition(trigger.triggerIndex, text);
    },
    [computeDropdownPosition]
  );

  const detectTrigger = useCallback(
    (textarea: HTMLTextAreaElement, text: string, resetSelection: boolean) => {
      const trigger = findMentionTrigger(text, textarea.selectionStart, triggerChars);
      const isEnabled = trigger ? (isTriggerEnabled?.(trigger.triggerChar) ?? true) : false;
      const isValid = trigger ? (isTriggerMatchValid?.(trigger, text) ?? true) : false;
      if (trigger && isEnabled && isValid) {
        activateTrigger(trigger, text, resetSelection);
      } else {
        dismiss();
        if (
          textarea === textareaRef.current &&
          textarea.isConnected &&
          document.activeElement === textarea &&
          !textarea.disabled &&
          !textarea.readOnly &&
          textarea.selectionStart === textarea.selectionEnd
        ) {
          // This is only an observed input; current rules must admit a trigger later.
          pendingInputRef.current = {
            element: textarea,
            text,
            selectionStart: textarea.selectionStart,
            selectionEnd: textarea.selectionEnd,
          };
        }
      }
    },
    [triggerChars, isTriggerEnabled, isTriggerMatchValid, dismiss, activateTrigger, textareaRef]
  );

  useEffect(() => {
    if (previousEnabledTriggerSignatureRef.current === enabledTriggerSignature) return;
    previousEnabledTriggerSignatureRef.current = enabledTriggerSignature;
    const pending = pendingInputRef.current;
    if (!pending) return;
    const textarea = textareaRef.current;
    if (
      !textarea ||
      textarea !== pending.element ||
      !textarea.isConnected ||
      document.activeElement !== textarea ||
      textarea.disabled ||
      textarea.readOnly ||
      textarea.value !== pending.text ||
      textarea.selectionStart !== pending.selectionStart ||
      textarea.selectionEnd !== pending.selectionEnd ||
      textarea.selectionStart !== textarea.selectionEnd
    ) {
      pendingInputRef.current = null;
      return;
    }
    const trigger = findMentionTrigger(pending.text, textarea.selectionStart, triggerChars);
    if (
      trigger &&
      (isTriggerEnabled?.(trigger.triggerChar) ?? true) &&
      (isTriggerMatchValid?.(trigger, pending.text) ?? true)
    ) {
      activateTrigger(trigger, pending.text, false);
    }
  }, [
    enabledTriggerSignature,
    triggerChars,
    isTriggerEnabled,
    isTriggerMatchValid,
    activateTrigger,
    textareaRef,
  ]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const newValue = textarea.value;
      onValueChange(newValue);
      detectTrigger(textarea, newValue, true);
    },
    [onValueChange, detectTrigger]
  );

  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      detectTrigger(textarea, textarea.value, false);
    },
    [detectTrigger]
  );

  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLTextAreaElement>,
      suggestionCount: number,
      onSelectSuggestion: (index: number) => void
    ) => {
      // Don't navigate/select while an IME composition is active — Enter/Arrow
      // keys belong to the input method's candidate selection at that point.
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') pendingInputRef.current = null;
      if (!isOpen || suggestionCount === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % suggestionCount);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + suggestionCount) % suggestionCount);
          break;
        case 'Enter':
          if (!e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            onSelectSuggestion(selectedIndex);
          }
          break;
        case 'Escape':
          e.preventDefault();
          dismiss();
          break;
      }
    },
    [isOpen, selectedIndex, dismiss]
  );

  const getTriggerIndex = useCallback(() => triggerIndexRef.current, []);

  return {
    isOpen,
    activeTriggerChar,
    query,
    selectedIndex,
    setSelectedIndex,
    dropdownPosition,
    selectSuggestion,
    dismiss,
    handleKeyDown,
    handleChange,
    handleSelect,
    getTriggerIndex,
  };
}
