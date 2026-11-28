import { describe, expect, it } from 'vitest';

import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import { assembleTaskParts } from '../../../src/features/agent-backend/renderer/readHostPagedSnapshot';

import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';

type Marker = NonNullable<BackendTeamSnapshot['taskParts']>[number];

const common = { id: 'TEST-task', subject: 'Task', status: 'pending' };
const comment = {
  id: 'TEST-comment', author: 'alice', type: 'regular',
  createdAt: '2026-11-09T12:00:00Z',
};
const text = '漢'.repeat(120) + '🦊'.repeat(120);

function projectedTask(task: object, marker: Marker) {
  const page = projectTeamSnapshot({
    teamName: 'TEST-team', revision: 'a'.repeat(64),
    feed: {
      streamId: '33333333-3333-4333-8333-333333333333',
      sequence: 0,
      cursor: '11111111-1111-4111-8111-111111111111',
    },
    members: [], messages: [],
    kanbanState: { teamName: 'TEST-team', reviewers: [], tasks: {} },
    tasks: [task], taskTotal: 1, taskParts: [marker],
  });
  return { value: page.tasks[0]!, marker: page.taskParts![0]! };
}

function parts(changedAuthor?: string) {
  const first = projectedTask({ ...common, comments: [] }, { index: 0, part: 0, total: 3 });
  const middle = projectedTask({
    ...common, comments: [{
      ...comment, text: text.slice(0, 120), privatePath: '/TEST/private',
    }],
  }, {
    index: 0, part: 1, total: 3,
    commentPart: { index: 0, part: 0, total: 2 },
  });
  const last = projectedTask({
    ...common, comments: [{ ...comment, author: changedAuthor ?? 'alice', text: text.slice(120) }],
  }, {
    index: 0, part: 2, total: 3,
    commentPart: { index: 0, part: 1, total: 2 },
  });
  return [first, middle, last] as const;
}

function reassemble(values: ReturnType<typeof parts>) {
  return assembleTaskParts(new Map([[0, {
    total: 3,
    values: new Map(values.map(({ value, marker }) => [marker.part, value] as const)),
    commentParts: new Map(values.flatMap(({ marker }) =>
      marker.commentPart ? [[marker.part, marker.commentPart] as const] : [])),
  }]]), 1);
}

describe('Host comment fragments retain one canonical comment', () => {
  it('restores Unicode text after strict product projection, without exposing private fields', () => {
    const restored = reassemble(parts());
    expect(restored).toHaveLength(1);
    expect(restored[0]?.comments).toEqual([{ ...comment, text }]);
    expect(JSON.stringify(restored)).not.toContain('/TEST/private');
  });

  it('fails closed if a comment fragment is missing or changes identity', () => {
    expect(() => reassemble(parts('mallory'))).toThrow('Mismatched Host comment fragment');
    const missing = parts();
    const values = new Map(missing.slice(0, 2).map(({ value, marker }) => [
      marker.part, value,
    ] as const));
    expect(() => assembleTaskParts(new Map([[0, { total: 3, values }]]), 1))
      .toThrow('Incomplete Host task history');
  });

  it('rejects malformed fragment marker counts at the projection boundary', () => {
    expect(() => projectedTask({
      ...common, comments: [{ ...comment, text: 'part' }],
    }, {
      index: 0, part: 1, total: 2,
      commentPart: { index: 0, part: 0, total: 1 },
    })).toThrow('Invalid Host comment fragment');
  });

  it('reconstructs one comment larger than 512 KiB across projected Owner fragments', () => {
    const longText = '漢'.repeat(200_000);
    const chunkSize = 25_000;
    const chunks = Array.from({ length: Math.ceil(longText.length / chunkSize) }, (_, index) =>
      longText.slice(index * chunkSize, (index + 1) * chunkSize));
    const total = chunks.length + 1;
    const base = projectedTask({ ...common, comments: [] }, {
      index: 0, part: 0, total,
    });
    const fragments = chunks.map((chunk, index) => projectedTask({
      ...common, comments: [{ ...comment, text: chunk }],
    }, {
      index: 0, part: index + 1, total,
      commentPart: { index: 0, part: index, total: chunks.length },
    }));
    const projected = [base, ...fragments];
    const values = new Map(projected.map(({ value, marker }) =>
      [marker.part, value] as const));
    const commentParts = new Map(projected.flatMap(({ marker }) =>
      marker.commentPart ? [[marker.part, marker.commentPart] as const] : []));
    const reconstructed = assembleTaskParts(new Map([[0, {
      total, values, commentParts,
    }]]), 1);
    expect(new TextEncoder().encode(longText).length).toBeGreaterThan(512 * 1024);
    expect(reconstructed[0]?.comments).toEqual([{ ...comment, text: longText }]);
  });

});
