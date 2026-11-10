import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../packages/agent-graph/src/canvas/render-cache', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../packages/agent-graph/src/canvas/render-cache')
  >('../../../../packages/agent-graph/src/canvas/render-cache');

  return {
    ...actual,
    getAgentGlowSprite: vi.fn(() => ({ width: 1, height: 1 })),
  };
});

import { drawAgents } from '../../../../packages/agent-graph/src/canvas/draw-agents';
import { getGraphNodeCardSize } from '../../../../packages/agent-graph/src/canvas/node-geometry';

import type { GraphNode } from '@claude-teams/agent-graph';

interface FillTextCall {
  text: string;
  x: number;
  y: number;
  fillStyle: string;
  globalAlpha: number;
}

interface GradientStopCall {
  offset: number;
  color: string;
}

function createMockContext() {
  const fillTextCalls: FillTextCall[] = [];
  const strokeTextCalls: FillTextCall[] = [];
  const roundRectCalls: { x: number; y: number; width: number; height: number }[] = [];
  const gradientStops: GradientStopCall[] = [];
  const gradient = {
    addColorStop: vi.fn((offset: number, color: string) => {
      gradientStops.push({ offset, color });
    }),
  };
  let fillStyle = '';
  let globalAlpha = 1;

  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    setLineDash: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    roundRect: vi.fn((x: number, y: number, width: number, height: number) => {
      roundRectCalls.push({ x, y, width, height });
    }),
    createRadialGradient: vi.fn(() => gradient),
    createLinearGradient: vi.fn(() => gradient),
    measureText: vi.fn((text: string) => ({ width: text.length * 4.5 })),
    fillText: vi.fn((text: string, x: number, y: number) => {
      fillTextCalls.push({ text, x, y, fillStyle, globalAlpha });
    }),
    strokeText: vi.fn((text: string, x: number, y: number) => {
      strokeTextCalls.push({ text, x, y, fillStyle, globalAlpha });
    }),
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
    },
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(value: number) {
      globalAlpha = value;
    },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, fillTextCalls, strokeTextCalls, roundRectCalls, gradientStops };
}

describe('drawAgents', () => {
  it('sizes team cards to their content within parent-safe bounds', () => {
    const baseNode: GraphNode = {
      id: 'team:adaptive',
      kind: 'member',
      visualVariant: 'team',
      label: 'API',
      state: 'active',
      domainRef: { kind: 'member', teamName: 'adaptive', memberName: 'team:adaptive' },
    };
    const shortCard = getGraphNodeCardSize(baseNode);
    const longCard = getGraphNodeCardSize({
      ...baseNode,
      label: 'Agent Runtime Platform Integrations',
      semanticSummary: '12 agents - 4 active - 28 tasks',
    });

    expect(shortCard).toEqual({ width: 260, height: 84 });
    expect(longCard?.width).toBeGreaterThan(shortCard!.width);
    expect(longCard?.width).toBeLessThanOrEqual(340);
  });
  it('renders hierarchy cards with semantic text detail across zoom levels', () => {
    const node: GraphNode = {
      id: 'team:alpha',
      kind: 'member',
      visualVariant: 'team',
      label: 'Platform Engineering',
      role: '5 agents - 2 active',
      semanticSummary: 'online · 2 active · 8 tasks',
      state: 'active',
      color: '#38bdf8',
      domainRef: { kind: 'member', teamName: 'alpha', memberName: 'team:alpha' },
      x: 320,
      y: 240,
    };
    const far = createMockContext();
    const medium = createMockContext();
    const close = createMockContext();

    drawAgents(far.ctx, [node], 0, null, null, null, 0.15);
    drawAgents(medium.ctx, [node], 0, null, null, null, 0.4);
    drawAgents(close.ctx, [node], 0, null, null, null, 1);

    expect(far.roundRectCalls).toHaveLength(1);
    expect(far.fillTextCalls.some((call) => call.text === 'Platform Engineering')).toBe(true);
    expect(far.fillTextCalls.some((call) => call.text.includes('online · 2 active'))).toBe(true);
    expect(medium.fillTextCalls.some((call) => call.text === 'Platform Engineering')).toBe(true);
    expect(medium.fillTextCalls.some((call) => call.text.includes('online · 2 active'))).toBe(true);
    expect(close.fillTextCalls.some((call) => call.text === 'Platform Engineering')).toBe(true);
    expect(close.fillTextCalls.some((call) => call.text === '5 agents - 2 active')).toBe(true);
  });

  it('renders organization aggregates as a compact overview badge', () => {
    const { ctx, fillTextCalls, roundRectCalls } = createMockContext();
    const node: GraphNode = {
      id: 'org:platform',
      kind: 'lead',
      visualVariant: 'organization',
      hierarchyDepth: 0,
      label: 'Platform',
      semanticSummary: '12 teams · 4 active · 18 tasks',
      state: 'active',
      color: '#38bdf8',
      domainRef: { kind: 'lead', teamName: 'platform', memberName: 'org:platform' },
      x: 320,
      y: 240,
    };

    drawAgents(ctx, [node], 0, null, null, null, 0.08);

    expect(roundRectCalls).toHaveLength(1);
    expect(fillTextCalls.some((call) => call.text === 'Platform')).toBe(true);
    expect(fillTextCalls.some((call) => call.text.includes('12 teams · 4 active'))).toBe(true);
  });

  it('renders the active tool card above the node while keeping labels below it', () => {
    const { ctx, fillTextCalls, roundRectCalls } = createMockContext();
    const node: GraphNode = {
      id: 'member:demo:alice',
      kind: 'member',
      label: '2beacon-desk-22345',
      state: 'tool_calling',
      color: '#f5b74d',
      runtimeLabel: 'Anthropic · Haiku 4.5 | Medium',
      domainRef: { kind: 'member', teamName: 'demo', memberName: 'alice' },
      activeTool: {
        name: 'Bash',
        preview: 'list_my_sessions',
        state: 'running',
        startedAt: '2026-04-15T10:00:00.000Z',
        source: 'runtime',
      },
      x: 320,
      y: 240,
    };

    drawAgents(ctx, [node], 0, null, null, null, 1);

    const toolCard = roundRectCalls.find((call) => call.height === 18);
    expect(toolCard).toBeDefined();
    expect(toolCard!.y + toolCard!.height).toBeLessThan(node.y! - 1);

    const labelCall = fillTextCalls.find((call) => call.text.includes('2beacon-desk-22345'));
    const runtimeCall = fillTextCalls.find((call) => call.text.includes('Anthropic'));
    const toolCall = fillTextCalls.find((call) => call.text.includes('Bash: list_my_sessions'));

    expect(labelCall).toBeDefined();
    expect(runtimeCall).toBeDefined();
    expect(toolCall).toBeDefined();
    expect(labelCall!.y).toBeGreaterThan(node.y!);
    expect(runtimeCall!.y).toBeGreaterThan(labelCall!.y);
    expect(toolCall!.y).toBeLessThan(node.y!);
  });

  it('renders launch text as a third label line and removes old ad-hoc waiting text', () => {
    const { ctx, fillTextCalls } = createMockContext();
    const node: GraphNode = {
      id: 'member:demo:alice',
      kind: 'member',
      label: 'alice',
      state: 'idle',
      color: '#60a5fa',
      runtimeLabel: 'Codex · GPT-5.4 Mini · Medium',
      launchVisualState: 'runtime_pending',
      launchStatusLabel: 'connecting',
      spawnStatus: 'online',
      domainRef: { kind: 'member', teamName: 'demo', memberName: 'alice' },
      x: 320,
      y: 240,
    };

    drawAgents(ctx, [node], 0, null, null, null, 1);

    const labelCall = fillTextCalls.find((call) => call.text === 'alice');
    const runtimeCall = fillTextCalls.find((call) => call.text.includes('Codex'));
    const launchCall = fillTextCalls.find((call) => call.text === 'connecting');

    expect(labelCall).toBeDefined();
    expect(runtimeCall).toBeDefined();
    expect(launchCall).toBeDefined();
    expect(runtimeCall!.y).toBeGreaterThan(labelCall!.y);
    expect(launchCall!.y).toBeGreaterThan(runtimeCall!.y);
    expect(fillTextCalls.some((call) => call.text === 'waiting...')).toBe(false);
    expect(fillTextCalls.some((call) => call.text === 'connecting...')).toBe(false);
  });

  it('draws member labels with fixed high-contrast text and backdrops', () => {
    const { ctx, fillTextCalls, strokeTextCalls, roundRectCalls } = createMockContext();
    const node: GraphNode = {
      id: 'member:demo:alice',
      kind: 'member',
      label: 'alice',
      role: 'reviewer',
      state: 'idle',
      color: '#0000ff',
      runtimeLabel: 'Anthropic · Opus 4.6',
      domainRef: { kind: 'member', teamName: 'demo', memberName: 'alice' },
      x: 320,
      y: 240,
    };

    drawAgents(ctx, [node], 0, null, null, null, 1);

    const labelCall = fillTextCalls.find((call) => call.text === 'alice · reviewer');
    const runtimeCall = fillTextCalls.find((call) => call.text.includes('Anthropic'));

    expect(labelCall).toBeDefined();
    expect(runtimeCall).toBeDefined();
    expect(labelCall?.fillStyle).toBe('#e8f8ff');
    expect(runtimeCall?.fillStyle).toBe('#b9d7f2');
    expect(roundRectCalls.filter((call) => call.height === 12 || call.height === 10)).toHaveLength(
      2
    );
    expect(strokeTextCalls.some((call) => call.text === 'alice · reviewer')).toBe(true);
    expect(strokeTextCalls.some((call) => call.text.includes('Anthropic'))).toBe(true);
  });

  it('keeps lead labels readable when the lead node is visually dimmed', () => {
    const { ctx, fillTextCalls, roundRectCalls } = createMockContext();
    const node: GraphNode = {
      id: 'lead:demo',
      kind: 'lead',
      label: 'signal-ops-12',
      state: 'terminated',
      color: '#0000ff',
      runtimeLabel: 'GPT-5.4',
      domainRef: { kind: 'lead', teamName: 'demo', memberName: 'signal-ops-12' },
      x: 320,
      y: 240,
    };

    drawAgents(ctx, [node], 0, null, null, null, 1);

    const labelCall = fillTextCalls.find((call) => call.text === 'signal-ops-12');
    const runtimeCall = fillTextCalls.find((call) => call.text === 'GPT-5.4');

    expect(labelCall).toMatchObject({ fillStyle: '#e8f8ff', globalAlpha: 0.88 });
    expect(runtimeCall).toMatchObject({ fillStyle: '#b9d7f2', globalAlpha: 0.88 });
    expect(roundRectCalls.filter((call) => call.height === 12 || call.height === 10)).toHaveLength(
      2
    );
  });

  it('adds a red glow around members with error exceptions', () => {
    const { ctx, gradientStops } = createMockContext();
    const node: GraphNode = {
      id: 'member:demo:bob',
      kind: 'member',
      label: 'bob',
      state: 'active',
      color: '#7c3aed',
      exceptionTone: 'error',
      exceptionLabel: 'OpenCode API error',
      domainRef: { kind: 'member', teamName: 'demo', memberName: 'bob' },
      x: 320,
      y: 240,
    };

    drawAgents(ctx, [node], 0, null, null, null, 1);

    expect(ctx.createRadialGradient).toHaveBeenCalledWith(320, 240, 18, 320, 240, 50);
    expect(gradientStops.some((stop) => stop.color.startsWith('#ef4444'))).toBe(true);
  });
});
