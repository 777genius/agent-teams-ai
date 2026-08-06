import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const readinessPath = resolve(
  'src/main/composition/hosted/hostedLifecycleOrchestratorReadiness.ts'
);
const compositionPath = resolve('src/main/composition/hosted/teamLifecycleCommandComposition.ts');
const standalonePath = resolve('src/main/standalone.ts');

describe('hosted lifecycle command external-owner boundary', () => {
  it('keeps the boundary client-only and provider-neutral', async () => {
    const [readiness, composition] = await Promise.all([
      readFile(readinessPath, 'utf8'),
      readFile(compositionPath, 'utf8'),
    ]);
    const ownedSource = `${readiness}\n${composition}`;

    expect(readiness).toContain("import { createConnection } from 'node:net'");
    expect(readiness).not.toMatch(/\bcreateServer\b|\bspawn\b|\bfork\b|child_process/);
    expect(ownedSource).not.toMatch(/OpenCode|ClaudeCode|Gemini/);
    expect(composition).toContain('new OrchestratorLifecycleCommandClient({ socketPath })');
    expect(composition).toContain('if (closed || !readiness.isReady())');
  });

  it('admits the external owner before exposing HTTP and closes the client first', async () => {
    const [composition, standalone] = await Promise.all([
      readFile(compositionPath, 'utf8'),
      readFile(standalonePath, 'utf8'),
    ]);
    const readinessConnect = composition.indexOf('HostedLifecycleOrchestratorReadiness.connect');
    const clientCreation = composition.indexOf('new OrchestratorLifecycleCommandClient');
    expect(readinessConnect).toBeGreaterThan(-1);
    expect(readinessConnect).toBeLessThan(clientCreation);

    const startup = standalone.slice(standalone.indexOf('async function start'));
    expect(startup.indexOf('await createOptionalTeamLifecycleCommandComposition')).toBeLessThan(
      startup.indexOf('await httpServer.start')
    );
    const shutdown = standalone.slice(standalone.indexOf('async function shutdown'));
    expect(shutdown.indexOf('hostedLifecycleCommands?.close()')).toBeLessThan(
      shutdown.indexOf('httpServer.stop()')
    );
  });
});
