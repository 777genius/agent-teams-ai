import { describe, expect, it } from 'vitest';
import { release220Execution } from '../../scripts/ci/release/nativeReadinessAuthority.js';
import type { StagePlan } from '../../scripts/ci/release/contract.js';

const plan = {
  input: {
    repository: '777genius/agent-teams-ai',
    mode: 'full',
    toolingSha: 'a0a8c4d895cfcbe3c790507fe9938b02e4464706',
    target: { tag: 'v2.17.10', applicationSha: 'dc1ec2d927b8c27c20d18c976ee615b27a2bd6f3' },
    macProductMinimum: '13.0',
    macSource: null,
  },
} as StagePlan;
const p = 'b3422f64da6c44b1aeea6ba656a5db3f694c913b8a7a1289a37dc511530e4678';
const d = 'f73b096f3723cd73ceebf0887e0d8e6870ab7f97a3b42bd1d67f3aac8fabbeaa';
describe('closed full220 executor graph', () => {
  it('permits only package E11 while all other roles retain E10', () => {
    expect(release220Execution('package', plan, p, d)).toBe(
      '77073837a0d03120a06fee1a963a664b5cd7678a'
    );
    for (const kind of ['windows', 'appimage', 'mac-manual'])
      expect(release220Execution(kind, plan, p, d)).toBe(
        'a0a8c4d895cfcbe3c790507fe9938b02e4464706'
      );
  });
  it('rejects any other plan digest or prepared input', () => {
    expect(() => release220Execution('package', plan, '0'.repeat(64), d)).toThrow();
    expect(() => release220Execution('package', plan, p, '0'.repeat(64))).toThrow();
  });
  it('rejects foreign repository, source, app, target, floor, Mac origin and mode', () => {
    const inputs = [
      { repository: 'foreign/repo' },
      { toolingSha: '0'.repeat(40) },
      { target: { ...plan.input.target, applicationSha: '0'.repeat(40) } },
      { target: { ...plan.input.target, tag: 'v2.17.11' } },
      { macProductMinimum: '12.0' },
      { macSource: {} },
      { mode: 'carry-mac' },
    ];
    for (const input of inputs)
      expect(() =>
        release220Execution(
          'package',
          { ...plan, input: { ...plan.input, ...input } } as StagePlan,
          p,
          d
        )
      ).toThrow();
  });
});
