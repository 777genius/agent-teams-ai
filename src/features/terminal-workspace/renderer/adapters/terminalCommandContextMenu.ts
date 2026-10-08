export interface TerminalCommandContextMenuState {
  blockText: string;
  commandText: string;
  outputText: string;
  x: number;
  y: number;
}

export function resolveTerminalCommandContextMenuState(
  event: MouseEvent
): TerminalCommandContextMenuState | null {
  const entry = findTerminalHistoryEntryElement(event);
  if (!entry) {
    return null;
  }

  const commandText = getTerminalHistoryEntryText(entry, [
    '[part~="history-entry-command-text"]',
    '.history-entry-command .history-entry-text',
    '[part~="history-entry-command"]',
    '.history-entry-command',
  ]);
  if (!commandText) {
    return null;
  }

  const outputText = getTerminalHistoryEntryText(entry, [
    '[part~="history-entry-output-text"]',
    '.history-entry-output .history-entry-text',
    '[part~="history-entry-output"]',
    '.history-entry-output',
  ]);
  const blockText = [commandText, outputText].filter(Boolean).join('\n');

  return {
    blockText,
    commandText,
    outputText,
    x: clampTerminalContextMenuCoordinate(event.clientX, window.innerWidth, 240),
    y: clampTerminalContextMenuCoordinate(event.clientY, window.innerHeight, 132),
  };
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
  return value
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .trim();
}

function clampTerminalContextMenuCoordinate(value: number, max: number, size: number): number {
  return Math.max(8, Math.min(value, Math.max(8, max - size - 8)));
}

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the textarea fallback below.
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand('copy');
  } finally {
    textArea.remove();
  }
}
