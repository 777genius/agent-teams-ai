import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const TEAM_PROVISIONING_SERVICE_PATH = resolve(
  process.cwd(),
  'src/main/services/team/TeamProvisioningService.ts'
);
const TEAM_PROVISIONING_SERVICE_LINE_LIMIT = 777;
const SUBSCRIPTION_RUNTIME_REFERENCE_PATTERN = /subscription[-_\s]+runtime|subscriptionRuntime/i;

function countSourceLines(source: string): number {
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.length;
}

describe('TeamProvisioningService facade guard', () => {
  it('keeps the compatibility facade below the line cap', () => {
    const source = readFileSync(TEAM_PROVISIONING_SERVICE_PATH, 'utf8');

    expect(countSourceLines(source)).toBeLessThan(TEAM_PROVISIONING_SERVICE_LINE_LIMIT);
  });

  it('keeps subscription runtime references out of the compatibility facade', () => {
    const source = readFileSync(TEAM_PROVISIONING_SERVICE_PATH, 'utf8');

    expect(source).not.toMatch(SUBSCRIPTION_RUNTIME_REFERENCE_PATTERN);
  });
});
