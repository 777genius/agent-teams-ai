import { expect, it } from 'vitest';

import {
  buildBugReportText,
  buildGitHubBugReportUrl,
} from '../../../src/renderer/utils/bugReportUtils';

it('never copies a browser capability fragment into reports, even before API initialization', () => {
  const prior = window.location.href;
  const secret = 'a'.repeat(64);
  window.history.replaceState(null, '', `/#management-access=${secret}`);
  try {
    const options = { error: new Error('Isolated renderer failure') };
    const text = buildBugReportText(options);
    expect(text).toContain(`Current URL: ${window.location.href.split('#')[0]}`);
    expect(text).not.toContain(secret);
    expect(decodeURIComponent(buildGitHubBugReportUrl(options))).not.toContain(secret);
  } finally {
    window.history.replaceState(null, '', prior);
  }
});
