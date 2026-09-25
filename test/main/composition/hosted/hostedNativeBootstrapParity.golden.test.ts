import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildDeterministicCreateBootstrapSpec,
  getDeterministicBootstrapTimeoutMs,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningBootstrapSpec';
import { APP_TEAM_RUNTIME_DISALLOWED_TOOLS } from '../../../../src/main/services/team/provisioning/TeamProvisioningRunModel';

import type { TeamCreateRequest } from '@shared/types';

// Pinned so the vector does not depend on the host locale or saved app settings.
vi.mock('../../../../src/main/services/team/provisioning/TeamProvisioningAgentLanguage', () => ({
  getConfiguredAgentLanguageName: () => 'English',
}));

// The same bytes live in agent_teams_orchestrator docs/; both repositories pin this digest.
const GOLDEN_SHA256 = 'f48d98ffbdbc85248a01fd1ebbb00cf37d2f3c1f49d7b641cb25bc0825018f54';
const GOLDEN_PATH = resolve('docs/hosted-native-bootstrap-parity-golden.json');
const FORMAT = 'agent-teams.hosted-native-bootstrap-parity-golden/v1';
/** Every teammate count a native lane admits, plus the clamps on both sides. */
const TEAMMATE_COUNTS = [0, 1, 2, 5, 8, 9, 20];

function desktopCreateSpec() {
  const request: TeamCreateRequest = {
    teamName: 'golden-native',
    cwd: '/workspace/golden-native',
    members: [
      { name: 'alice', workflow: 'Build the feature.', providerId: 'anthropic' },
      {
        name: 'bob',
        workflow: 'Review the change.',
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        effort: 'high',
      },
    ],
  };
  return buildDeterministicCreateBootstrapSpec('run_golden-native', request, request.members);
}

function generate() {
  const previous = process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS;
  delete process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS;
  try {
    return {
      format: FORMAT,
      source:
        'agent-teams-ai test/main/composition/hosted/hostedNativeBootstrapParity.golden.test.ts',
      disallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
      bootstrapTimeoutMs: TEAMMATE_COUNTS.map((teammates) => ({
        teammates,
        timeoutMs: getDeterministicBootstrapTimeoutMs(teammates),
      })),
      desktopCreateSpec: desktopCreateSpec(),
    };
  } finally {
    if (previous !== undefined) {
      process.env.CLAUDE_TEAM_DETERMINISTIC_BOOTSTRAP_TIMEOUT_MS = previous;
    }
  }
}

describe('hosted native bootstrap parity cross-repository golden', () => {
  it('is exactly what the desktop launch uses for the lead bootstrap', () => {
    const serialized = `${JSON.stringify(generate(), null, 2)}\n`;
    if (process.env.HOSTED_NATIVE_BOOTSTRAP_GOLDEN_WRITE === '1') {
      writeFileSync(GOLDEN_PATH, serialized);
    }
    const raw = readFileSync(GOLDEN_PATH);
    expect(raw.toString('utf8')).toBe(serialized);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256);
  });
});
