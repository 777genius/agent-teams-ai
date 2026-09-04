const { isTaskOpen } = require('../src/internal/taskLifecycle.js');

// taskStore.js accepts exactly four statuses and reviewState.js exactly four
// review states, so these two tables are the whole product a board row can
// hold. Some pairs are unreachable through the store (a deleted or in_progress
// task has its reviewState reset to 'none'), but the predicate is handed rows
// straight off disk and must still answer for them.
describe('isTaskOpen', () => {
  it.each([
    ['pending', 'none'],
    ['pending', 'review'],
    ['pending', 'needsFix'],
    ['pending', 'approved'],
    ['in_progress', 'none'],
    ['in_progress', 'review'],
    ['in_progress', 'needsFix'],
    ['in_progress', 'approved'],
    // Completed but not finished: the reviewer can still send the work back.
    ['completed', 'review'],
    ['completed', 'needsFix'],
  ])('counts %s / %s as open board work', (status, reviewState) => {
    expect(isTaskOpen({ status, reviewState })).toBe(true);
  });

  it.each([
    ['completed', 'none'],
    ['completed', 'approved'],
    // A deleted task is not live work, whatever review state it carries.
    ['deleted', 'none'],
    ['deleted', 'review'],
    ['deleted', 'needsFix'],
    ['deleted', 'approved'],
  ])('counts %s / %s as finished board work', (status, reviewState) => {
    expect(isTaskOpen({ status, reviewState })).toBe(false);
  });

  it('answers without a reviewState field', () => {
    expect(isTaskOpen({ status: 'pending' })).toBe(true);
    expect(isTaskOpen({ status: 'in_progress' })).toBe(true);
    expect(isTaskOpen({ status: 'completed' })).toBe(false);
    expect(isTaskOpen({ status: 'deleted' })).toBe(false);
  });

  it('treats an unknown status as open rather than silently finishing the board', () => {
    expect(isTaskOpen({ status: 'blocked', reviewState: 'none' })).toBe(true);
    expect(isTaskOpen({})).toBe(true);
  });
});
