import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildTransientHandoffMessage } from './buildTransientHandoffMessage';

import type { TransientHandoffCard } from '@claude-teams/agent-graph';

describe('buildTransientHandoffMessage', () => {
  afterEach(() => vi.useRealTimers());

  it('uses wall time rather than the animation clock for message timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T10:30:00.000Z'));
    const card = {
      key: 'handoff-1',
      sourceLabel: 'liam',
      destinationLabel: 'maya',
      kind: 'inbox_message',
      color: '#66ccff',
      preview: 'The checks passed.',
      updatedAt: 7.5,
    } as TransientHandoffCard;
    expect(buildTransientHandoffMessage('runtime', card).timestamp).toBe(
      '2026-11-12T10:30:00.000Z'
    );
  });
});
