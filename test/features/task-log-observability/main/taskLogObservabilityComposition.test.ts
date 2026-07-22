import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const handlersSource = readFileSync(resolve(ROOT, 'src/main/ipc/handlers.ts'), 'utf8');
const legacyTeamsSource = readFileSync(resolve(ROOT, 'src/main/ipc/teams.ts'), 'utf8');

const OWNED_CHANNELS = [
  'TEAM_GET_TASK_ACTIVITY',
  'TEAM_GET_TASK_ACTIVITY_DETAIL',
  'TEAM_GET_TASK_LOG_STREAM_SUMMARY',
  'TEAM_GET_TASK_LOG_STREAM',
  'TEAM_GET_TASK_EXACT_LOG_SUMMARIES',
  'TEAM_GET_TASK_EXACT_LOG_DETAIL',
];

describe('task log observability production composition', () => {
  it('registers and removes the feature exactly once through its public entrypoint', () => {
    expect(handlersSource).toContain("from '@features/task-log-observability/main'");
    expect(handlersSource.match(/\n {2}registerTaskLogObservabilityIpc\(/g)).toHaveLength(1);
    expect(handlersSource.match(/\n {2}removeTaskLogObservabilityIpc\(/g)).toHaveLength(1);
  });

  it('maps the five existing shared service instances to narrow reader ports', () => {
    expect(handlersSource).toMatch(
      /readers:\s*{\s*activity: boardTaskActivityService,\s*activityDetail: boardTaskActivityDetailService,\s*stream: boardTaskLogStreamService,\s*exactLogSummaries: boardTaskExactLogsService,\s*exactLogDetail: boardTaskExactLogDetailService,/s
    );
    expect(handlersSource).not.toMatch(/new BoardTask(?:Activity|LogStream|ExactLog)/);
  });

  it('removes all six channel owners from the legacy teams adapter', () => {
    for (const channel of OWNED_CHANNELS) {
      expect(legacyTeamsSource).not.toContain(channel);
    }
  });
});
