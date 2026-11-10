import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { desktopTaskReviewCardReadinessExpression } from '../../scripts/legacy-agent-host/desktop-task-review-card-readiness.ts';

const expected = {
  contextId: 'local',
  teamName: 'host-team:TEST-owner',
  taskId: 'TEST-task',
  subject: 'TEST original Task',
  status: 'completed',
  reviewState: 'none',
  boardColumn: null,
};
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
function Card(props: {
  contextId: string;
  teamName: string;
  columnId: string;
  task: { id: string; subject: string; status: string; reviewState: string };
  kanbanTaskState?: { column: string };
}) {
  return React.createElement(
    'div',
    {
      className: 'kanban-task-card',
      'data-task-id': props.task.id,
      'data-state': 'open',
    },
    React.createElement('h5', null, props.task.subject)
  );
}
const read = () =>
  Function(
    `return ${desktopTaskReviewCardReadinessExpression(
      '.kanban-task-card[data-task-id="TEST-task"]',
      expected
    )}`
  )() as unknown;
const props = () => ({
  contextId: expected.contextId,
  teamName: expected.teamName,
  columnId: 'done',
  task: {
    id: expected.taskId,
    subject: expected.subject,
    status: expected.status,
    reviewState: expected.reviewState,
  },
  kanbanTaskState: undefined,
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
test('rejects old-column Task props despite the same open ID/title, then accepts only committed new props', async () => {
  const old = props();
  old.task.status = 'in_progress';
  old.columnId = 'in_progress';
  await act(async () => root.render(React.createElement(Card, old)));
  const node = host.querySelector('.kanban-task-card');
  expect(node?.getAttribute('data-state')).toBe('open');
  expect(node?.querySelector('h5')?.textContent).toBe(expected.subject);
  expect(read()).toBeNull();
  await act(async () => root.render(React.createElement(Card, props())));
  expect(host.querySelector('.kanban-task-card')).toBe(node); // React now has alternate fibers.
  expect(read()).toEqual({
    taskId: expected.taskId,
    status: 'completed',
    reviewState: 'none',
    columnId: 'done',
    boardColumn: null,
  });
  await act(async () =>
    root.render(React.createElement(Card, { ...props(), kanbanTaskState: { column: 'review' } }))
  );
  expect(read()).toBeNull();
});
test.each(['contextId', 'teamName'] as const)(
  'refuses another captured %s even with identical Task identity/state',
  async (field) => {
    await act(async () =>
      root.render(React.createElement(Card, { ...props(), [field]: 'TEST-other-owner' }))
    );
    expect(read()).toBeNull();
  }
);
