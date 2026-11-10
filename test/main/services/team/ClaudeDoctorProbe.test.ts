// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { extractDoctorInvokedCandidates } from '@main/services/team/ClaudeDoctorProbe';

describe('ClaudeDoctorProbe', () => {
  it('extracts a single invoked path from doctor output', () => {
    const output = `
────────────────────────────────────
  Diagnostics
  └ Currently running: native (2.1.101)
  └ Path: /Users/belief/.local/share/claude/versions/2.1.101
  └ Invoked: /Users/belief/.local/share/claude/versions/2.1.101
  └ Config install method: native
  Press Enter to continue…
`;

    expect(extractDoctorInvokedCandidates(output)).toEqual([
      '/Users/belief/.local/share/claude/versions/2.1.101',
    ]);
  });

  it('reconstructs wrapped invoked paths without corrupting spaces', () => {
    const output = `
\u001B[2J────────────────────────────────────
  Diagnostics
  └ Invoked: /Applications/Agent Teams${' '}
  AI.app/Contents/Resources/runtime/clau
  de-multimodel
  └ Config install method: native
  Press Enter to continue…
`;

    expect(extractDoctorInvokedCandidates(output)).toEqual([
      '/Applications/Agent Teams AI.app/Contents/Resources/runtime/claude-multimodel',
    ]);
  });

  it('keeps all invoked candidates across repeated redraw frames', () => {
    const output = `
────────────────────────────────────
  Diagnostics
  └ Invoked: /Users/belief/.local/sh
  are/claude/versions/2.1.100
  └ Config install method: native
  Press Enter to continue…

────────────────────────────────────
  Diagnostics
  └ Invoked: /Users/belief/.local/sh
  are/claude/versions/2.1.101
  └ Config install method: native
  Press Enter to continue…
`;

    expect(extractDoctorInvokedCandidates(output)).toEqual([
      '/Users/belief/.local/share/claude/versions/2.1.100',
      '/Users/belief/.local/share/claude/versions/2.1.101',
    ]);
  });

  it('accepts ASCII bullet variants from degraded terminal captures', () => {
    const output = `
  Diagnostics
  L Path: /Users/vladislavkonovalov/.nvm/versions/node/v22.22.1/bin/node
  L Invoked: /Users/vladislavkonovalov/.claude/local/node_modules/.bin/claude
  L Config install method: local
`;

    expect(extractDoctorInvokedCandidates(output)).toEqual([
      '/Users/vladislavkonovalov/.claude/local/node_modules/.bin/claude',
    ]);
  });
});
