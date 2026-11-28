import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopScheduleHistoryObservation } from './desktop-schedule-history-observation.ts';

type Row = Record<string, unknown>;
const schedule = Object.freeze({ id: 'TEST-schedule', status: 'active', cronExpression: '10 9 * * * *',
  timezone: 'UTC', nextRunAt: '2026-11-20T09:00:10.000Z', launchConfig: { prompt: 'TEST private prompt' } });

test('keeps automatic failed/skipped history after manual success without replacing the original read', () => {
  const proof: Row = {}, observer = createDesktopScheduleHistoryObservation(proof, schedule, 'TEST-manual');
  const manual = Object.freeze({ id: 'TEST-manual', scheduleId: schedule.id, status: 'dispatched',
    linkedTaskId: 'TEST-task', unknown: { secret: 'TEST omitted' } });
  const before = Object.freeze([manual]);
  assert.equal(observer.observe(before), before);
  const automatic = { id: 'TEST-automatic', scheduleId: schedule.id, status: 'skipped',
    summary: 'Previous task is still active', linkedTaskId: 'TEST-task' };
  const after = Object.freeze([automatic, manual]);
  assert.equal(observer.observe(after), after);
  const evidence = proof.automaticScheduleObservation as Row;
  assert.equal(evidence.armedAt, observer.armedAt);
  assert.ok(Number.isFinite(Date.parse(observer.armedAt)));
  assert.equal(evidence.reads, 2);
  assert.equal(evidence.totalRuns, 2);
  assert.equal(evidence.captureFailed, false);
  assert.deepEqual(evidence.schedule, { id: schedule.id, status: 'active', cronExpression: schedule.cronExpression,
    timezone: 'UTC', nextRunAt: schedule.nextRunAt });
  assert.deepEqual(evidence.original, { id: 'TEST-manual' });
  assert.deepEqual(evidence.runs, [automatic, { id: manual.id, scheduleId: schedule.id,
    status: 'dispatched', linkedTaskId: 'TEST-task' }]);
  automatic.summary = 'TEST later mutation';
  assert.equal((evidence.runs as Row[])[0]!.summary, 'Previous task is still active');
  assert.equal(JSON.stringify(evidence).includes('TEST private prompt'), false);
  assert.equal(JSON.stringify(evidence).includes('TEST omitted'), false);
});

test('bounds the last history snapshot and marks truncation without altering the returned rows', () => {
  const proof: Row = {}, observer = createDesktopScheduleHistoryObservation(proof, schedule, 'TEST-manual');
  const runs = Array.from({ length: 50 }, (_, index) => Object.freeze({ id: `TEST-run-${index}`,
    status: 'failed', error: 'x'.repeat(4096), summary: 'TEST summary', unselected: 'y'.repeat(100_000) }));
  assert.equal(observer.observe(Object.freeze(runs)), runs);
  const evidence = proof.automaticScheduleObservation as Row, captured = evidence.runs as Row[];
  assert.equal(evidence.totalRuns, 50);
  assert.equal(evidence.overflow, true);
  assert.equal(captured.length, evidence.limit);
  assert.equal(captured.length, 8);
  assert.equal(String(captured[0]!.error).length, 512);
  assert.deepEqual(captured[0]!.truncatedFields, ['error']);
  assert.equal(runs[0]!.error.length, 4096);
  assert.equal(JSON.stringify(evidence).includes('yyy'), false);
  observer.observe([]);
  assert.equal(evidence.reads, 2);
  assert.equal(evidence.totalRuns, 0);
  assert.equal(evidence.overflow, false);
  assert.deepEqual(evidence.runs, []);
});

test('preserves the original result if diagnostic projection itself fails', () => {
  const proof: Row = {}, observer = createDesktopScheduleHistoryObservation(proof, schedule, 'TEST-manual');
  const runs = [Object.defineProperty({}, 'id', { get() { throw new Error('TEST unreadable diagnostic'); } })];
  assert.equal(observer.observe(runs), runs);
  const evidence = proof.automaticScheduleObservation as Row;
  assert.equal(evidence.captureFailed, true);
  assert.equal(evidence.totalRuns, null);
  assert.equal(evidence.lastReadAt, null);
});
