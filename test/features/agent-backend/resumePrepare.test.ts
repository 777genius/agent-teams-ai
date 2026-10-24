// @vitest-environment node
import { expect, it } from 'vitest';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

import type { BackendOperationRequest } from '../../../src/features/agent-backend/contracts/operations';

const members = ['a', 'b'].map((memberId) => ({
  memberId,
  sourceGeneration: 'TEST-source',
  reference: `cp1-${memberId.repeat(64)}`,
  commandId: `TEST-restore-${memberId}`,
}));
const request: BackendOperationRequest = {
  handle: { handleId: 'TEST-handle' },
  commandId: 'TEST-prepare',
  operation: 'team.launch.resume.prepare',
  payload: {
    launchId: 'TEST-launch',
    rosterRevision: 'TEST-roster',
    resumeId: 'TEST-resume',
    members,
  },
};
const prepared = {
  resumeId: 'TEST-resume',
  rosterRevision: 'TEST-roster',
  members: members.map((member) => ({ ...member, requested: false })),
};

it('strict immutable prepare and optional technical restore identity accept no private selectors', () => {
  expect(parseBackendOperation(request)).toEqual(request);
  for (const members of [
    [],
    Array(65).fill(request.payload.members[0]),
    [request.payload.members[0], request.payload.members[0]],
    [{ ...request.payload.members[0], nativeSessionId: 'TEST-private' }],
  ])
    expect(() =>
      parseBackendOperation({ ...request, payload: { ...request.payload, members } })
    ).toThrow();
  const restore = {
    ...request,
    operation: 'runtime.restore',
    payload: {
      memberId: 'a',
      expectedGeneration: 'TEST-source',
      reference: members[0]!.reference,
      resumeId: 'TEST-resume',
    },
  };
  expect(parseBackendOperation(restore)).toEqual(restore);
  expect(() =>
    parseBackendOperation({ ...restore, payload: { ...restore.payload, resumeId: '' } })
  ).toThrow();
});
it('prepare result rechecks exact whole map and preserves requested/refused outcomes on replay', () => {
  expect(projectBackendResult(request, { ok: true, value: prepared })).toEqual({
    ok: true,
    value: prepared,
  });
  const refused = {
    ...prepared,
    members: [{ ...prepared.members[0], requested: true, refused: 'hold' }, prepared.members[1]],
  };
  expect(projectBackendResult(request, { ok: true, value: refused })).toEqual({
    ok: true,
    value: refused,
  });
  for (const value of [
    { ...prepared, resumeId: 'TEST-wrong' },
    { ...prepared, members: prepared.members.slice(0, 1) },
    {
      ...prepared,
      members: [{ ...prepared.members[0], commandId: 'TEST-wrong' }, prepared.members[1]],
    },
    { ...prepared, members: [{ ...prepared.members[0], refused: 'hold' }, prepared.members[1]] },
  ])
    expect(() => projectBackendResult(request, { ok: true, value })).toThrow();
});
it('cold read includes untouched member commands and refuses false selection/refusal or oversized history', () => {
  const read: BackendOperationRequest = {
    ...request,
    operation: 'team.launch.restorations.read',
    payload: { launchId: 'TEST-launch' },
  };
  const value = {
    launchId: 'TEST-launch',
    rosterRevision: 'TEST-roster',
    restorations: [],
    preparations: [prepared],
  };
  expect(projectBackendResult(read, { ok: true, value })).toEqual({ ok: true, value });
  const selected = {
    commandId: members[0]!.commandId,
    memberId: 'a',
    reference: members[0]!.reference,
    sourceGeneration: 'TEST-source',
    selectedGeneration: 'TEST-next',
    current: true,
    phase: 'opening',
    custody: 'unknown',
    attached: false,
  };
  expect(() =>
    projectBackendResult(read, { ok: true, value: { ...value, restorations: [selected] } })
  ).toThrow();
  expect(() =>
    projectBackendResult(read, {
      ok: true,
      value: { ...value, preparations: Array(65).fill(prepared) },
    })
  ).toThrow();
});
