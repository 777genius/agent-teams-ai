import { describe, expect, it, vi } from 'vitest';

import { drawTasks } from '../../../../packages/agent-graph/src/canvas/draw-tasks';

import type { GraphNode } from '@claude-teams/agent-graph';

function createMockContext() {
  const arcCalls: Array<{ x: number; y: number; radius: number }> = [];
  const fillTextCalls: Array<{ text: string; x: number; y: number }> = [];
  const gradient = { addColorStop: vi.fn() };
  let fillStyle: string | CanvasGradient | CanvasPattern = '';
  let globalAlpha = 1;

  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn((x: number, y: number, radius: number) => {
      arcCalls.push({ x, y, radius });
    }),
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
    roundRect: vi.fn(),
    createRadialGradient: vi.fn(() => gradient),
    createLinearGradient: vi.fn(() => gradient),
    measureText: vi.fn((text: string) => ({ width: text.length * 4.5 })),
    fillText: vi.fn((text: string, x: number, y: number) => {
      fillTextCalls.push({ text: String(text), x, y });
    }),
    strokeText: vi.fn(),
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = value;
    },
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(value: number) {
      globalAlpha = value;
    },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, arcCalls, fillTextCalls };
}

function createTaskNode(hasLiveTaskLogs: boolean): GraphNode {
  return {
    id: 'task:demo:task-live',
    kind: 'task',
    label: '#1',
    state: 'active',
    displayId: '#1',
    sublabel: 'Live log task',
    taskStatus: 'in_progress',
    reviewState: 'none',
    hasLiveTaskLogs: hasLiveTaskLogs ? true : undefined,
    domainRef: { kind: 'task', teamName: 'demo', taskId: 'task-live' },
    x: 120,
    y: 80,
  };
}

describe('drawTasks', () => {
  it('shows task content only at detail zoom unless the task is selected', () => {
    const overview = createMockContext();
    const summary = createMockContext();
    const detail = createMockContext();
    const selected = createMockContext();
    const hierarchySummary = createMockContext();
    const node = createTaskNode(false);

    drawTasks(overview.ctx, [node], 1, null, null, null, 0.1);
    drawTasks(summary.ctx, [node], 1, null, null, null, 0.4);
    drawTasks(detail.ctx, [node], 1, null, null, null, 0.8);
    drawTasks(selected.ctx, [node], 1, node.id, null, null, 0.4);
    drawTasks(
      hierarchySummary.ctx,
      [{ ...node, taskZoomVisibility: 'summary' }],
      1,
      null,
      null,
      null,
      0.4
    );

    expect(overview.fillTextCalls).toHaveLength(0);
    expect(summary.fillTextCalls).toHaveLength(0);
    expect(detail.fillTextCalls.some((call) => call.text === 'Live log task')).toBe(true);
    expect(selected.fillTextCalls.some((call) => call.text === 'Live log task')).toBe(true);
    expect(hierarchySummary.fillTextCalls.some((call) => call.text === 'Live log task')).toBe(true);
  });

  it('draws the live log indicator only for task nodes with live log activity', () => {
    const active = createMockContext();
    drawTasks(active.ctx, [createTaskNode(true)], 1, null, null, null, 1);

    const inactive = createMockContext();
    drawTasks(inactive.ctx, [createTaskNode(false)], 1, null, null, null, 1);

    expect(active.arcCalls.length).toBeGreaterThanOrEqual(3);
    expect(inactive.arcCalls).toHaveLength(0);
  });

  it('wraps long task subjects into two canvas lines', () => {
    const { ctx, fillTextCalls } = createMockContext();
    const node = {
      ...createTaskNode(false),
      displayId: '0f505654',
      sublabel:
        'Review VitePress docs: Get missing developer page ready for publishing search analytics routing navigation validation checklist and docs',
    };

    drawTasks(ctx, [node], 1, null, null, null, 1);

    const firstTitleLine = fillTextCalls.find((call) => call.y === -16);
    const secondTitleLine = fillTextCalls.find((call) => call.y === 2);
    const displayId = fillTextCalls.find((call) => call.text === '0f505654');

    expect(firstTitleLine?.text).toContain('Review VitePress docs');
    expect(secondTitleLine?.text).toContain('...');
    expect(displayId?.y).toBe(23);
  });

  it('keeps the compact single-line subject layout for short titles', () => {
    const { ctx, fillTextCalls } = createMockContext();
    drawTasks(ctx, [createTaskNode(false)], 1, null, null, null, 1);

    const titleLine = fillTextCalls.find((call) => call.text === 'Live log task');
    const secondTitleLine = fillTextCalls.find((call) => call.y === 2);
    const displayId = fillTextCalls.find((call) => call.text === '#1');

    expect(titleLine?.y).toBe(-12);
    expect(secondTitleLine).toBeUndefined();
    expect(displayId?.y).toBe(12);
  });
});
