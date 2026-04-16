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

import type { GraphNode } from '@claude-teams/agent-graph';

interface FillTextCall {
  text: string;
  x: number;
  y: number;
}

function createMockContext() {
  const fillTextCalls: FillTextCall[] = [];
  const roundRectCalls: Array<{ x: number; y: number; width: number; height: number }> = [];
  const gradient = { addColorStop: vi.fn() };

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
      fillTextCalls.push({ text, x, y });
    }),
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;

  return { ctx, fillTextCalls, roundRectCalls };
}

describe('drawAgents', () => {
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
});
