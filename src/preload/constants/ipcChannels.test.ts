import { describe, expect, it } from 'vitest';

import {
  SKILLS_LIST,
  TEAM_DISCARD_QUEUED_USER_MESSAGES,
  TEAM_FORCE_STOP,
  TEAM_GET_QUEUED_USER_MESSAGES,
} from './ipcChannels';

describe('IPC channel composition', () => {
  it('retains the merged team channels exactly once and re-exports split skill channels', () => {
    expect({
      SKILLS_LIST,
      TEAM_DISCARD_QUEUED_USER_MESSAGES,
      TEAM_FORCE_STOP,
      TEAM_GET_QUEUED_USER_MESSAGES,
    }).toEqual({
      SKILLS_LIST: 'skills:list',
      TEAM_DISCARD_QUEUED_USER_MESSAGES: 'team:discardQueuedUserMessages',
      TEAM_FORCE_STOP: 'team:forceStop',
      TEAM_GET_QUEUED_USER_MESSAGES: 'team:getQueuedUserMessages',
    });
  });
});
