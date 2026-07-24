export function buildPathSecretLeakFixture(): unknown {
  const disguisedHostLocation = ['', 'Users', 'fixture-person', 'private-project'].join('/');
  const disguisedCredentialKey = ['access', 'token'].join('_');
  return {
    kind: 'failure',
    diagnostic: `source detail: ${disguisedHostLocation}`,
    [disguisedCredentialKey]: 'synthetic-canary-value',
  };
}
