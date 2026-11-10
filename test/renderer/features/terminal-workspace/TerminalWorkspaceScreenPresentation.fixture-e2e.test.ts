// @vitest-environment happy-dom

import {
  createInitialWorkspaceSnapshot,
  type WorkspaceKernel,
  type WorkspaceSnapshot,
} from '@terminal-platform/workspace-core';
import {
  defineTerminalPlatformElements,
  type TerminalCommandPresentationMetadata,
  type TerminalScreenElement,
} from '@terminal-platform/workspace-elements';
import { afterEach, describe, expect, it } from 'vitest';

describe('terminal workspace screen presentation fixture-e2e', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('renders raw command output after its command card and leaves the active cursor last', async () => {
    defineTerminalPlatformElements();
    const element = document.createElement('tp-terminal-screen') as TerminalScreenElement;
    const metadata: TerminalCommandPresentationMetadata = {
      command: "print 'fdfd'",
      durationMs: 35,
      startedAtMs: 1_000,
      status: 'succeeded',
    };
    element.placement = 'terminal';
    element.commandPresentationMetadata = [metadata];
    element.kernel = createScreenKernel(createRawCommandSnapshot());

    document.body.appendChild(element);
    await element.updateComplete;

    const viewport = element.shadowRoot?.querySelector('[data-testid="tp-screen-viewport"]');
    const historyEntry = viewport?.querySelector<HTMLElement>('.history-entry');
    const cursorLine = viewport?.querySelector<HTMLElement>('.line');

    expect(
      historyEntry?.querySelector('[part~="history-entry-command-text"]')?.textContent?.trim()
    ).toBe("print 'fdfd'");
    expect(
      historyEntry?.querySelector('[part~="history-entry-output-text"]')?.textContent?.trim()
    ).toBe('fdfd');
    expect(historyEntry?.querySelector('[part~="history-entry-meta"]')?.textContent).not.toContain(
      'running'
    );
    expect(viewport ? Array.from(viewport.children) : []).toEqual([historyEntry, cursorLine]);
  });

  it('keeps rapid plain commands and their outputs in chronological blocks', async () => {
    defineTerminalPlatformElements();
    const element = document.createElement('tp-terminal-screen') as TerminalScreenElement;
    element.placement = 'terminal';
    element.commandPresentationMetadata = [
      {
        command: 'echo first',
        durationMs: 20,
        startedAtMs: 1_000,
        status: 'succeeded',
      },
      {
        command: 'echo second',
        durationMs: 25,
        startedAtMs: 1_100,
        status: 'succeeded',
      },
    ];
    element.kernel = createScreenKernel(
      createRawCommandSnapshot({
        cursorRow: 4,
        lines: ['echo first', 'first', 'echo second', 'second', 'custom prompt'],
      })
    );

    document.body.appendChild(element);
    await element.updateComplete;

    const viewport = element.shadowRoot?.querySelector('[data-testid="tp-screen-viewport"]');
    const historyEntries = Array.from(
      viewport?.querySelectorAll<HTMLElement>('.history-entry') ?? []
    );
    const commandTexts = historyEntries.map((entry) =>
      entry.querySelector('[part~="history-entry-command-text"]')?.textContent?.trim()
    );
    const outputTexts = historyEntries.map((entry) =>
      entry.querySelector('[part~="history-entry-output-text"]')?.textContent?.trim()
    );

    expect(commandTexts).toEqual(['echo first', 'echo second']);
    expect(outputTexts).toEqual(['first', 'second']);
    expect(viewport ? Array.from(viewport.children) : []).toEqual([
      historyEntries[0],
      historyEntries[1],
      viewport?.querySelector('.line'),
    ]);
  });

  it('keeps soft-wrapped command continuation inside the command card', async () => {
    defineTerminalPlatformElements();
    const element = document.createElement('tp-terminal-screen') as TerminalScreenElement;
    const command =
      "printf 'WRAP_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\n'";
    element.placement = 'terminal';
    element.commandPresentationMetadata = [
      {
        command,
        durationMs: 18,
        startedAtMs: 1_000,
        status: 'succeeded',
      },
    ];
    const snapshot = createRawCommandSnapshot({
      cursorRow: 3,
      lines: [
        {
          text: "shell % printf 'WRAP_ABCDEFGHIJKLMNOPQRSTUVWXYZ01234",
          wrapped: true,
        },
        "56789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\n'",
        'WRAP_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        'shell %',
      ],
    });
    snapshot.historicalPanes = {
      'pane-1': {
        capturedAtMs: 1_200n,
        fromEventSeq: 1n,
        hasGaps: false,
        hasMoreSegments: false,
        lines: [
          "shell % pprintf 'WRAP_ABCDEFGHIJKLMNOPQRSTUVWXYZ01234",
          '5',
          "56789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\n'",
          '',
          'WRAP_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          'shell %',
        ],
        loadedPayloadBytes: 160n,
        nextEventSeq: null,
        paneId: 'pane-1',
        replayStrategy: 'mixed',
        restoreGuaranteeLevel: 'basic_history',
        segmentCount: 1,
        sessionId: 'session-1',
        source: 'v2_pane_history',
        sourcePaneId: 'pane-1',
        sourceSessionId: 'session-1',
      },
    };
    element.kernel = createScreenKernel(snapshot);

    document.body.appendChild(element);
    await element.updateComplete;

    const historyEntry = element.shadowRoot?.querySelector<HTMLElement>('.history-entry');
    const outputTexts = Array.from(
      historyEntry?.querySelectorAll('[part~="history-entry-output-text"]') ?? []
    ).map((item) => item.textContent?.trim());

    expect(
      historyEntry?.querySelector('[part~="history-entry-command-text"]')?.textContent?.trim()
    ).toBe(command);
    expect(outputTexts).toEqual([
      'WRAP_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    ]);
    expect(element.shadowRoot?.textContent).not.toContain("pprintf 'WRAP_");
  });

  it('renders a completed no-output command before a nonstandard active prompt', async () => {
    defineTerminalPlatformElements();
    const element = document.createElement('tp-terminal-screen') as TerminalScreenElement;
    element.placement = 'terminal';
    element.commandPresentationMetadata = [
      {
        command: 'true',
        durationMs: 12,
        startedAtMs: 1_000,
        status: 'unknown',
      },
    ];
    element.kernel = createScreenKernel(
      createRawCommandSnapshot({ cursorRow: 1, lines: ['true', 'custom prompt'] })
    );

    document.body.appendChild(element);
    await element.updateComplete;

    const viewport = element.shadowRoot?.querySelector('[data-testid="tp-screen-viewport"]');
    const historyEntry = viewport?.querySelector<HTMLElement>('.history-entry');

    expect(
      historyEntry?.querySelector('[part~="history-entry-command-text"]')?.textContent?.trim()
    ).toBe('true');
    expect(historyEntry?.querySelector('[part~="history-entry-output-text"]')).toBeNull();
    expect(viewport ? Array.from(viewport.children) : []).toEqual([
      historyEntry,
      viewport?.querySelector('.line'),
    ]);
  });

  it('deduplicates a corrupted restored echo against the authoritative live command block', async () => {
    defineTerminalPlatformElements();
    const element = document.createElement('tp-terminal-screen') as TerminalScreenElement;
    const snapshot = createRawCommandSnapshot({
      cursorRow: 2,
      lines: ["shell % print 'fdfd'", 'fdfd', 'shell %'],
    });
    snapshot.historicalPanes = {
      'pane-1': {
        capturedAtMs: 1_000n,
        fromEventSeq: 1n,
        hasGaps: false,
        hasMoreSegments: false,
        lines: ["shell % pprint 'fdfd'", 'fdfd', 'shell %'],
        loadedPayloadBytes: 64n,
        nextEventSeq: null,
        paneId: 'pane-1',
        replayStrategy: 'mixed',
        restoreGuaranteeLevel: 'basic_history',
        segmentCount: 1,
        sessionId: 'session-1',
        source: 'v2_pane_history',
        sourcePaneId: 'pane-1',
        sourceSessionId: 'session-1',
      },
    };
    element.placement = 'terminal';
    element.commandPresentationMetadata = [
      {
        command: "print 'fdfd'",
        durationMs: 35,
        startedAtMs: 1_000,
        status: 'succeeded',
      },
    ];
    element.kernel = createScreenKernel(snapshot);

    document.body.appendChild(element);
    await element.updateComplete;

    const viewport = element.shadowRoot?.querySelector('[data-testid="tp-screen-viewport"]');
    const historyEntries = Array.from(
      viewport?.querySelectorAll<HTMLElement>('.history-entry') ?? []
    );

    expect(historyEntries).toHaveLength(1);
    expect(
      historyEntries[0]
        ?.querySelector('[part~="history-entry-command-text"]')
        ?.textContent?.trim()
    ).toBe("print 'fdfd'");
    expect(
      historyEntries[0]
        ?.querySelector('[part~="history-entry-output-text"]')
        ?.textContent?.trim()
    ).toBe('fdfd');
    expect(viewport?.textContent).not.toContain("pprint 'fdfd'");
  });

  it('moves restored failure output onto a stale authoritative live command', async () => {
    defineTerminalPlatformElements();
    const element = document.createElement('tp-terminal-screen') as TerminalScreenElement;
    const snapshot = createRawCommandSnapshot({
      cursorRow: 0,
      lines: ['shell % not_a_real_command'],
    });
    snapshot.historicalPanes = {
      'pane-1': {
        capturedAtMs: 1_200n,
        fromEventSeq: 1n,
        hasGaps: false,
        hasMoreSegments: false,
        lines: [
          'shell % nnot_a_real_command',
          'zsh: command not found: not_a_real_command',
          'shell %',
        ],
        loadedPayloadBytes: 96n,
        nextEventSeq: null,
        paneId: 'pane-1',
        replayStrategy: 'mixed',
        restoreGuaranteeLevel: 'basic_history',
        segmentCount: 1,
        sessionId: 'session-1',
        source: 'v2_pane_history',
        sourcePaneId: 'pane-1',
        sourceSessionId: 'session-1',
      },
    };
    element.placement = 'terminal';
    element.commandPresentationMetadata = [
      {
        command: 'not_a_real_command',
        durationMs: 220,
        startedAtMs: 1_000,
        status: 'failed',
      },
    ];
    element.kernel = createScreenKernel(snapshot);

    document.body.appendChild(element);
    await element.updateComplete;

    const viewport = element.shadowRoot?.querySelector('[data-testid="tp-screen-viewport"]');
    const historyEntries = Array.from(
      viewport?.querySelectorAll<HTMLElement>('.history-entry') ?? []
    );

    expect(historyEntries).toHaveLength(1);
    expect(historyEntries[0]?.dataset.commandStatus).toBe('failed');
    expect(
      historyEntries[0]
        ?.querySelector('[part~="history-entry-command-text"]')
        ?.textContent?.trim()
    ).toBe('not_a_real_command');
    expect(
      historyEntries[0]
        ?.querySelector('[part~="history-entry-output-text"]')
        ?.textContent?.trim()
    ).toBe('zsh: command not found: not_a_real_command');
    expect(viewport?.textContent).not.toContain('nnot_a_real_command');
  });
});

function createScreenKernel(snapshot: WorkspaceSnapshot): WorkspaceKernel {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  } as unknown as WorkspaceKernel;
}

function createRawCommandSnapshot({
  cursorRow = 2,
  lines = ["print 'fdfd'", 'fdfd', ''],
}: {
  cursorRow?: number;
  lines?: Array<string | { text: string; wrapped?: boolean }>;
} = {}): WorkspaceSnapshot {
  const snapshot = createInitialWorkspaceSnapshot();
  snapshot.connection.state = 'ready';
  snapshot.selection = {
    activePaneId: 'pane-1',
    activeSessionId: 'session-1',
  };
  snapshot.attachedSession = {
    session: {
      session_id: 'session-1',
      route: { authority: 'local_daemon', backend: 'native', external: null },
      title: 'Fixture shell',
    },
    health: {
      can_attach: true,
      detail: null,
      invalidated: false,
      phase: 'ready',
      reason: null,
      session_id: 'session-1',
    },
    topology: {
      backend_kind: 'native',
      focused_tab: null,
      session_id: 'session-1',
      tabs: [],
    },
    focused_screen: {
      cols: 80,
      pane_id: 'pane-1',
      rows: 24,
      sequence: 1n,
      source: 'native_emulator',
      surface: {
        cursor: {
          col:
            (typeof lines[cursorRow] === 'string'
              ? lines[cursorRow]
              : lines[cursorRow]?.text
            )?.length ?? 0,
          row: cursorRow,
          shape: 'block',
        },
        lines: lines.map((line) => ({
          spans: [],
          ...(typeof line === 'string' ? { text: line } : line),
        })),
        title: null,
      },
    },
  };
  return snapshot;
}
