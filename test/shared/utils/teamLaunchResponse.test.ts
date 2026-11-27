import { describe, expect, it } from 'vitest';

import {
  isFreshLaunch,
  isLaunchAlreadyRunning,
  isLaunchAlreadyUnderway,
} from '../../../src/shared/utils/teamLaunchResponse';

describe('team launch outcome', () => {
  it('treats a plain accepted launch as fresh', () => {
    expect(isFreshLaunch({})).toBe(true);
    expect(isFreshLaunch({ launchStatus: 'started' })).toBe(true);
  });

  it.each([
    [{ launchStatus: 'already_running' as const }, true, false],
    [{ alreadyRunning: true }, true, false],
    [{ launchStatus: 'already_launching' as const }, false, true],
    [{ alreadyLaunching: true }, false, true],
  ])('recognizes a launch that applied nothing: %j', (response, running, underway) => {
    expect(isLaunchAlreadyRunning(response)).toBe(running);
    expect(isLaunchAlreadyUnderway(response)).toBe(underway);
    expect(isFreshLaunch(response)).toBe(false);
  });
});
