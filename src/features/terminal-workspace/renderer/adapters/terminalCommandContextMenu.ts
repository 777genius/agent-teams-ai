export interface TerminalCommandContextMenuSnapshot {
  readonly blockText: string;
  readonly commandText: string;
  readonly outputText: string;
  readonly x: number;
  readonly y: number;
}

const COMMAND_TEXT_SELECTORS = [
  '[part~="history-entry-command-text"]',
  '.history-entry-command .history-entry-text',
  '[part~="history-entry-command"]',
  '.history-entry-command',
] as const;

const OUTPUT_TEXT_SELECTORS = [
  '[part~="history-entry-output-text"]',
  '.history-entry-output .history-entry-text',
  '[part~="history-entry-output"]',
  '.history-entry-output',
] as const;

export function resolveTerminalCommandContextMenuSnapshot(
  event: MouseEvent
): TerminalCommandContextMenuSnapshot | null {
  const entry = findTerminalHistoryEntryElement(event);
  if (!entry) {
    return null;
  }

  const commandText = getTerminalHistoryEntryText(entry, COMMAND_TEXT_SELECTORS);
  if (!commandText) {
    return null;
  }

  const outputText = getTerminalHistoryEntryText(entry, OUTPUT_TEXT_SELECTORS);
  return Object.freeze({
    blockText: [commandText, outputText].filter(Boolean).join('\n'),
    commandText,
    outputText,
    x: event.clientX,
    y: event.clientY,
  });
}

export async function copyTerminalCommandContextText(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (typeof clipboard?.writeText === 'function') {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        // Continue with the legacy browser fallback.
      }
    }
  } catch {
    // Access to the Clipboard API can itself be denied by the browser.
  }

  let textArea: HTMLTextAreaElement | null = null;
  try {
    textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    document.body.appendChild(textArea);
    textArea.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    try {
      textArea?.remove();
    } catch {
      // Cleanup is best-effort and must not reject the clipboard contract.
    }
  }
}

function findTerminalHistoryEntryElement(event: MouseEvent): HTMLElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const pathItem of path) {
    if (pathItem instanceof HTMLElement && isTerminalHistoryEntryElement(pathItem)) {
      return pathItem;
    }
  }

  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  return target.closest<HTMLElement>('.history-entry,[part~="history-entry"]');
}

function isTerminalHistoryEntryElement(element: HTMLElement): boolean {
  return (
    element.classList.contains('history-entry') || hasTerminalElementPart(element, 'history-entry')
  );
}

function hasTerminalElementPart(element: HTMLElement, part: string): boolean {
  return (
    element
      .getAttribute('part')
      ?.split(/\s+/u)
      .some((value) => value === part) === true
  );
}

function getTerminalHistoryEntryText(entry: HTMLElement, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const text = normalizeTerminalContextMenuText(
      Array.from(entry.querySelectorAll<HTMLElement>(selector))
        .map((element) => element.textContent ?? '')
        .join('\n')
    );
    if (text) {
      return text;
    }
  }

  return '';
}

function normalizeTerminalContextMenuText(value: string): string {
  return value.replace(/\r\n/gu, '\n').split('\n').map(trimTerminalLineEnd).join('\n').trim();
}

function trimTerminalLineEnd(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === ' ' || value[end - 1] === '\t')) {
    end -= 1;
  }
  return value.slice(0, end);
}
