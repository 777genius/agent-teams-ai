import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ state: { activeContextId: 'local' }, page: vi.fn() }));
vi.mock('@renderer/store', () => ({ useStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }));
vi.mock('@renderer/api', () => ({ api: { teams: { getHostTeamSessionPage: mocks.page } } }));
vi.mock('@features/localization/renderer', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => <div data-retained-text>{content}</div>,
}));

import { HostTeamSessionsSection } from '@renderer/components/team/HostTeamSessionsSection';

import type { BackendTeamSessionPage, HostTeamSessionSummary, HostTeamSessionStream } from '@features/agent-backend/contracts';

const row = (letter: string): HostTeamSessionSummary => ({
  kind: 'host_session', id: 'host-session-' + letter.repeat(64), startedAt: 1000,
  window: { start: 1000, end: null }, clock: 'qualified', members: 1, generations: 1,
  isOngoing: false, gaps: [],
});
function page(id: string, stream: HostTeamSessionStream, text: string, nextCursor: string | null = null): BackendTeamSessionPage {
  return { kind: 'team-session-page', sessionId: id, stream, revision: 'a'.repeat(64), log: null,
    messages: [{ messageId: stream === 'inputs' ? 'host-input-' + 'b'.repeat(64) : 'response-original',
      memberName: 'lead', observedAt: stream === 'inputs' ? null : '2026-01-01T00:00:00Z',
      ...(stream === 'inputs' ? { phase: 'terminal' as const } : {}), text, part: 0, parts: 1 }],
    gaps: [], nextCursor };
}
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); mocks.state.activeContextId = 'local'; mocks.page.mockReset();
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
function button(text: string): HTMLButtonElement {
  const value = [...node.querySelectorAll('button')].find(item => item.textContent === text);
  expect(value).toBeDefined(); return value!;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function tab(text: string) {
  await act(async () => button(text).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
}
async function render(teamName: string, session: HostTeamSessionSummary) {
  await act(async () => root.render(<HostTeamSessionsSection teamName={teamName} sessions={[session]}
    sessionsLoading={false} sessionsError={null} selectedSessionId={null} onSelectSession={() => undefined} />));
}
it('history remains usable without qualified task clocks and opens all original streams and continuations', async () => {
  const session = { ...row('a'), clock: 'unqualified' as const, window: null, startedAt: null };
  mocks.page.mockImplementation(async (_team: string, id: string, stream: HostTeamSessionStream, cursor?: string) => {
    if (stream === 'activity') return { ...page(id, stream, ''), messages: [], log: {
      kind: 'host_activity', sessionId: 'host-activity-' + 'c'.repeat(64), memberId: 'lead-id',
      memberName: 'lead', generation: 'original', description: 'Original usage', startTime: null,
      durationMs: null, messageCount: 0, isOngoing: false, gaps: [], events: [
        { eventId: 'original-usage', sequence: 3, data: { kind: 'usage', inputTokens: 37, outputTokens: 11 } },
      ],
    } };
    return stream === 'inputs' ? page(id, stream, 'Original admitted prompt')
      : page(id, stream, cursor ? 'Older retained response' : 'First retained response', cursor ? null : 'signed-next');
  });
  await render('host-team:original', session);
  expect(button('Filter tasks').disabled).toBe(true);
  await click('View history');
  expect(node.textContent).toContain('First retained response');
  await click('Next page');
  expect(node.textContent).toContain('Older retained response');
  expect(node.textContent).not.toContain('First retained response');
  expect(mocks.page).toHaveBeenCalledWith('host-team:original', session.id, 'conversation', 'signed-next');
  await click('Previous page');
  expect(node.textContent).toContain('First retained response');
  await tab('Inputs');
  expect(node.textContent).toContain('Original admitted prompt');
  expect(node.textContent).toContain('Input to lead');
  expect(node.textContent).toContain('Time not recorded');
  expect(node.textContent).toContain('delivery terminal');
  await tab('Activity and usage');
  const usage = node.querySelector('[data-host-log-event-id="original-usage"]');
  expect(usage?.getAttribute('data-host-log-kind')).toBe('usage');
  expect(usage?.textContent).toContain('"inputTokens":37');
  await act(async () => usage!.querySelector<HTMLElement>('[role="button"]')!.click());
  expect(usage?.querySelector('[data-host-log-content]')?.textContent).toContain('"outputTokens":11');
});
it('an in-flight Next page cannot paint into a different Team or connection', async () => {
  const a = row('a'), b = row('b');
  let finishA!: (value: BackendTeamSessionPage) => void, finishB!: (value: BackendTeamSessionPage) => void;
  mocks.page.mockImplementation((team: string, id: string, stream: HostTeamSessionStream, cursor?: string) => {
    if (cursor) return new Promise<BackendTeamSessionPage>(resolve => {
      if (team === 'host-team:a') finishA = resolve; else finishB = resolve;
    });
    return Promise.resolve(page(id, stream, team + '/' + mocks.state.activeContextId, 'next'));
  });
  await render('host-team:a', a); await click('View history'); await click('Next page');
  await render('host-team:b', b); await click('View history');
  await act(async () => finishA(page(a.id, 'conversation', 'STALE Team A page')));
  expect(node.textContent).toContain('host-team:b/local'); expect(node.textContent).not.toContain('STALE');
  await click('Next page');
  mocks.state.activeContextId = 'remote';
  await render('host-team:b', b); await click('View history');
  await act(async () => finishB(page(b.id, 'conversation', 'STALE local connection page')));
  expect(node.textContent).toContain('host-team:b/remote'); expect(node.textContent).not.toContain('STALE');
});
it('a changed page revision requires refresh and cannot mix old and new responses', async () => {
  const session = row('a');
  mocks.page.mockResolvedValueOnce(page(session.id, 'conversation', 'Original response', 'next'))
    .mockResolvedValueOnce({ ...page(session.id, 'conversation', 'CHANGED response'), revision: 'b'.repeat(64) })
    .mockResolvedValueOnce({ ...page(session.id, 'conversation', 'Fresh response'), revision: 'b'.repeat(64) });
  await render('host-team:a', session); await click('View history'); await click('Next page');
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('Session history changed');
  expect(node.textContent).not.toContain('CHANGED response');
  await click('Refresh history');
  expect(node.textContent).toContain('Fresh response');
  expect(button('Previous page').disabled).toBe(true);
});
