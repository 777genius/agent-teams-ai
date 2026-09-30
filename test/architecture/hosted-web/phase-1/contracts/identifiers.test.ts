import * as hosted from '@shared/contracts/hosted';

import invalid from './fixtures/invalid-contract-values.json';
import valid from './fixtures/valid-contract-values.json';
test('hosted identifiers parse each kind without deriving a production team identity', () => {
  const value = valid.contextIdentity;
  expect(hosted.parseActorId(value.actorId)).toBe(value.actorId);
  expect(hosted.parseSessionId(value.sessionId)).toBe(value.sessionId);
  expect(hosted.parseDeploymentId(value.deploymentId)).toBe(value.deploymentId);
  expect(hosted.parseBootId(value.bootId)).toBe(value.bootId);
  expect(hosted.parseRequestId(value.requestId)).toBe(value.requestId);
  expect(hosted.parseSyntheticTeamId(valid.teamId)).toBe(valid.teamId);
  for (const value of invalid.identifiers) expect(() => hosted.parseActorId(value)).toThrow();
  expect(() => hosted.parseActorId(invalid.rawCrossKindActorId)).toThrow();
  expect(() => hosted.parseSyntheticTeamId(value.actorId)).toThrow();
});

test('the Phase 1 synthetic team parser stays an explicit compatibility surface', () => {
  expect(hosted.parseSyntheticTeamId('team_fixture-name')).toBe('team_fixture-name');
  expect(() => hosted.parseTeamId('team_fixture-name')).toThrow(
    'hosted-contract-canonical-identifier-invalid'
  );
});
