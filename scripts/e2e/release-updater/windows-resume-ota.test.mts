import assert from 'node:assert/strict';
import { test } from 'node:test';

import { windowsOriginalToolingSha } from './windows-execution-provenance.mts';
import {
  checkWindowsResumeAuthority,
  checkWindowsResumeFresh,
  checkWindowsResumeArchiveMembers,
  windowsResumeP10,
} from './windows-resume-ota.mts';
import type {
  ResumeAuthority,
  ResumeFreshSummary,
  ResumeFreshReference,
  ResumeInputBinding,
} from './windows-resume-ota.mts';

const references = JSON.parse(
  String.raw`{"x64":{"passed":true,"arch":"x64","inputDigest":"f73b096f3723cd73ceebf0887e0d8e6870ab7f97a3b42bd1d67f3aac8fabbeaa","installerSha256":"761e01427edfdaf2abd18d0f4eedfa0250594bdbebfd3067b63ffc1ed0c6afce","installed":{"executable":{"size":246114304,"sha256":"8e6c194b4446f630e189b6ee3ee2c3b8d3e8f2ab2142a1aa18bf9469f2889bc0","sha512":"c1/3jKwB2d3ZviTZho2X4jOcUq0r7GfDYw893VbnPzZLKwDQa2ql9gDHyMiiYqsjZigTaD4oA6ZCXsf9YZPnjA=="},"asar":{"size":494662324,"sha256":"0cc61a9c5e5c02eca048c43d417946c881faf71f2c854850039325baea3fbee7","sha512":"2OubLBkztE+f9m8Axmokfdof1e3/b9COzDr/Zm/gUk2MD5eOB6XLoyUoJ1gMteEJPDaEhIC+B7pQ3+hDMWsZYg=="},"packageVersion":"2.17.10","architecture":"x64","signature":{"status":"NotSigned","productVersion":"2.17.10.0"}}},"arm64":{"passed":true,"arch":"arm64","inputDigest":"f73b096f3723cd73ceebf0887e0d8e6870ab7f97a3b42bd1d67f3aac8fabbeaa","installerSha256":"a921aab7777b55a2438c721757d2ed52d62fc4d1a605690bd7a398c8aac9c0dc","installed":{"executable":{"size":226653696,"sha256":"003294daf04a8c4cb64125371f43030c1b26e012eb69c029eeed4a4578283efc","sha512":"gcgeVFKiVGp1bBGJNHzynuPWT6edR3mCBlbVtWlbxaZrLynpsQ7fWc0NCY8ODxYvGdE9Ni0T8RNrHCqSMlUKfw=="},"asar":{"size":494662332,"sha256":"733948dc6ecfa9c5f7508fe4967c4ec4721f63ca35a977e6b7984b2cbb66a74c","sha512":"LQB6/Dxe7iaRNgoFcaLxvMozi7CpcNTiqV1cl4++VCOllEgwULDyGJpQdFNs1C0+HI03TCjCSkDnXobW9vAoeA=="},"packageVersion":"2.17.10","architecture":"arm64","signature":{"status":"NotSigned","productVersion":"2.17.10.0"}}}}`
) as Record<'x64' | 'arm64', ResumeFreshReference>;
function qualified(key: 'x64' | 'arm64') {
  const reference = references[key];
  const pid = key === 'x64' ? 1184 : 4608;
  const summary: ResumeFreshSummary = {
    passed: true,
    mode: 'fresh',
    arch: key,
    inputDigest: reference.inputDigest,
    freshInstallProved: true,
    finalReleaseProved: true,
    cleanup: { passed: true },
    targetBinding: {
      targetVersion: '2.17.10',
      legacyFixture: false,
      plan: {
        sha256: 'b3422f64da6c44b1aeea6ba656a5db3f694c913b8a7a1289a37dc511530e4678',
        input: { toolingSha: 'a0a8c4d895cfcbe3c790507fe9938b02e4464706' },
      },
    },
    installedBefore: structuredClone(reference.installed),
    nativeWindow: { ready: true, pid },
    initialLaunch: { owner: { pid } },
  };
  return { reference, summary };
}
function selectedJob(value: ResumeAuthority) {
  const job = value.jobs[0];
  assert(job);
  return job;
}
function selectedStep(value: ResumeAuthority, index: number) {
  const step = selectedJob(value).steps[index];
  assert(step);
  return step;
}
function authority(): ResumeAuthority {
  return {
    run: {
      id: 37909332806,
      run_attempt: 1,
      head_sha: '261f0ad57ffdc7a3176f7053c140521808bb37e1',
      path: '.github/workflows/updater-windows-ota.yml',
      event: 'workflow_dispatch',
      status: 'completed',
      head_repository: { full_name: '777genius/agent-teams-ai' },
    },
    jobs: [
      {
        id: 113750414719,
        run_id: 37909332806,
        name: 'verified-windows-inputs',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-09T09:05:00Z',
        completed_at: '2026-10-09T09:25:50Z',
        steps: [
          {
            name: 'Verify immutable native producer and extract exact plan-bound inputs',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-10-09T09:09:19Z',
            completed_at: '2026-10-09T09:25:27Z',
          },
          {
            name: 'Run actions/upload-artifact@v7',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-10-09T09:25:27Z',
            completed_at: '2026-10-09T09:25:49Z',
          },
        ],
      },
    ],
    artifact: {
      id: 11606421802,
      name: 'TEST-windows-ota-inputs-37909332806-1',
      digest: 'sha256:a34186947c35349aaca7c4598311efd18ca75de0bea5bcfa7705aab5416ca615',
      expired: false,
      created_at: '2026-10-09T09:25:40Z',
      size_in_bytes: 100,
      workflow_run: { id: 37909332806, head_sha: '261f0ad57ffdc7a3176f7053c140521808bb37e1' },
    },
  };
}
void test('closed resume authenticates original verified producer rather than relabeling it as current', () => {
  const accepted = checkWindowsResumeAuthority(
    'inputs',
    authority(),
    'a34186947c35349aaca7c4598311efd18ca75de0bea5bcfa7705aab5416ca615'
  );
  assert.equal(accepted.runId, 37909332806);
  assert.equal(accepted.jobId, 113750414719);
  assert.equal(accepted.head, '261f0ad57ffdc7a3176f7053c140521808bb37e1');
});
void test('foreign source job, attempt, artifact, failed upload and changed ZIP reject', () => {
  const mutations: ((value: ResumeAuthority) => void)[] = [
    (value) => {
      value.run.run_attempt = 2;
    },
    (value) => {
      value.run.head_sha = 'f'.repeat(40);
    },
    (value) => {
      value.run.path = '.github/workflows/other.yml';
    },
    (value) => {
      value.run.head_repository.full_name = '777genius/other';
    },
    (value) => {
      selectedJob(value).id++;
    },
    (value) => {
      selectedJob(value).conclusion = 'failure';
    },
    (value) => {
      selectedStep(value, 0).conclusion = 'failure';
    },
    (value) => {
      selectedStep(value, 1).conclusion = 'failure';
    },
    (value) => {
      selectedJob(value).steps.push({ ...selectedStep(value, 1) });
    },
    (value) => {
      value.artifact.id++;
    },
    (value) => {
      value.artifact.workflow_run.head_sha = 'f'.repeat(40);
    },
    (value) => {
      value.artifact.expired = true;
    },
    (value) => {
      value.artifact.created_at = '2026-10-09T09:25:51Z';
    },
  ];
  for (const mutate of mutations) {
    const value = authority();
    mutate(value);
    assert.throws(() => checkWindowsResumeAuthority('inputs', value));
  }
  assert.throws(() => checkWindowsResumeAuthority('inputs', authority(), 'f'.repeat(64)));
});
for (const key of ['x64', 'arm64'] as const) {
  const original = qualified(key);
  const binding: ResumeInputBinding = {
    inputDigest: 'f73b096f3723cd73ceebf0887e0d8e6870ab7f97a3b42bd1d67f3aac8fabbeaa',
    plan: {
      sha256: 'b3422f64da6c44b1aeea6ba656a5db3f694c913b8a7a1289a37dc511530e4678',
      input: { toolingSha: 'a0a8c4d895cfcbe3c790507fe9938b02e4464706' },
    },
    verified: [
      {
        arch: key,
        tag: 'v2.17.10',
        name:
          key === 'x64'
            ? 'Agent.Teams.AI.Setup.2.17.10.exe'
            : 'Agent.Teams.AI.Setup.2.17.10-arm64.exe',
        sha256: original.reference.installerSha256,
      },
    ],
  };
  void test(`qualified ${key} fresh binding retains P10 and installed payload identity`, () => {
    assert.equal(binding.plan?.input.toolingSha, windowsOriginalToolingSha);
    assert.equal(binding.plan?.sha256, windowsResumeP10.planSha256);
    assert.doesNotThrow(() =>
      checkWindowsResumeFresh(key, original.summary, original.reference, binding)
    );
  });
  void test(`${key} failed cleanup, missing native proof, another P10 or substituted installed bytes reject`, () => {
    for (const mutate of [
      (s: ResumeFreshSummary) => {
        s.cleanup.passed = false;
      },
      (s: ResumeFreshSummary) => {
        s.passed = false;
      },
      (s: ResumeFreshSummary) => {
        s.finalReleaseProved = false;
      },
      (s: ResumeFreshSummary) => {
        s.nativeWindow.ready = false;
      },
      (s: ResumeFreshSummary) => {
        s.nativeWindow.pid++;
      },
      (s: ResumeFreshSummary) => {
        s.targetBinding.plan.sha256 = 'f'.repeat(64);
      },
    ]) {
      const summary = structuredClone(original.summary);
      mutate(summary);
      assert.throws(() => checkWindowsResumeFresh(key, summary, original.reference, binding));
    }
    const reference = structuredClone(original.reference);
    reference.installed.asar.sha256 = 'f'.repeat(64);
    assert.throws(() => checkWindowsResumeFresh(key, original.summary, reference, binding));
    assert.throws(() =>
      checkWindowsResumeFresh(key, original.summary, original.reference, {
        ...binding,
        inputDigest: 'f'.repeat(64),
      })
    );
    assert.throws(() =>
      checkWindowsResumeFresh(
        key,
        original.summary,
        { ...original.reference, installerSha256: 'f'.repeat(64) },
        binding
      )
    );
  });
}
void test('archive inventory rejects traversal absolute drive UNC controls case collisions and link metadata before extraction', () => {
  const valid = [
    { name: 'summary.json', attributes: 0 },
    { name: 'native-diagnostics/trace.json', attributes: 0 },
  ];
  assert.doesNotThrow(() => checkWindowsResumeArchiveMembers(valid));
  for (const name of [
    '../summary.json',
    'x/../summary.json',
    '/summary.json',
    'C:/summary.json',
    '\\\\host\\share',
    'x\\summary.json',
    'x/./summary.json',
    'x//summary.json',
    'summary.json:stream',
    'summary\u0000.json',
  ])
    assert.throws(() => checkWindowsResumeArchiveMembers([{ name, attributes: 0 }]));
  assert.throws(() =>
    checkWindowsResumeArchiveMembers([...valid, { name: 'SUMMARY.json', attributes: 0 }])
  );
  assert.throws(() =>
    checkWindowsResumeArchiveMembers([{ name: 'summary.json', attributes: 0xa000 << 16 }])
  );
  assert.throws(() =>
    checkWindowsResumeArchiveMembers([{ name: 'summary.json', attributes: 0x400 }])
  );
});
