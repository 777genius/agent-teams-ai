import { describe, expect, it } from 'vitest';

import { isLeadThought } from '../../../../../src/renderer/components/team/activity/LeadThoughtsGroup';

describe('LeadThoughtsGroup', () => {
  it('does not classify outbound runtime messages with recipients as lead thoughts', () => {
    expect(
      isLeadThought({
        from: 'team-lead',
        to: 'alice',
        text: 'Please check task #abcd1234',
        timestamp: '2026-03-08T00:00:00.000Z',
        read: true,
        source: 'lead_process',
      })
    ).toBe(false);
  });

  it('filters out idle_notification JSON noise from lead thoughts', () => {
    expect(
      isLeadThought({
        from: 'team-lead',
        text: '{"type":"idle_notification","message":"alice is idle"}',
        timestamp: '2026-03-08T00:00:00.000Z',
        read: true,
        source: 'lead_session',
      })
    ).toBe(false);
  });

  it('filters out shutdown_request JSON noise from lead thoughts', () => {
    expect(
      isLeadThought({
        from: 'team-lead',
        text: '{"type":"shutdown_request","reason":"Task complete"}',
        timestamp: '2026-03-08T00:00:00.000Z',
        read: true,
        source: 'lead_process',
      })
    ).toBe(false);
  });

  it('filters out pure <teammate-message> XML blocks from lead thoughts', () => {
    expect(
      isLeadThought({
        from: 'team-lead',
        text: '<teammate-message teammate_id="researcher" color="#4CAF50" summary="Done">Task completed</teammate-message>',
        timestamp: '2026-03-08T00:00:00.000Z',
        read: true,
        source: 'lead_session',
      })
    ).toBe(false);
  });

  it('filters out multiple <teammate-message> blocks with whitespace', () => {
    const text = [
      '<teammate-message teammate_id="alice" color="#f00" summary="hi">Hello</teammate-message>',
      '',
      '<teammate-message teammate_id="bob" color="#0f0" summary="ok">OK</teammate-message>',
    ].join('\n');
    expect(
      isLeadThought({
        from: 'team-lead',
        text,
        timestamp: '2026-03-08T00:00:00.000Z',
        read: true,
        source: 'lead_process',
      })
    ).toBe(false);
  });

  it('keeps normal lead thoughts with real content', () => {
    expect(
      isLeadThought({
        from: 'team-lead',
        text: 'Reviewing the implementation plan for the new feature.',
        timestamp: '2026-03-08T00:00:00.000Z',
        read: true,
        source: 'lead_session',
      })
    ).toBe(true);
  });
});
