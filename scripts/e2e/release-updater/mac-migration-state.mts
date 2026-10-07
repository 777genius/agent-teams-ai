import assert from 'node:assert/strict';

import type { Cdp } from './cdp.mts';

export interface MacMigrationState {
  theme: string;
  projectPaths: string[];
  team?: { teamName: string; projectPath: string; memberCount: number };
}

// Only config writes and a passive team-list read; no provisioning or runtime API.
export async function macMigrationState(
  client: Pick<Cdp, 'send'>,
  teamName: string,
  seed?: { theme: string; projectPath: string }
): Promise<MacMigrationState> {
  const api = await client.send<{
    result: { objectId?: string };
    exceptionDetails?: unknown;
  }>('Runtime.evaluate', { expression: 'window.electronAPI', returnByValue: false });
  assert.equal(api.exceptionDetails, undefined);
  const objectId = api.result.objectId;
  assert(objectId, 'Public app API object required');
  try {
    const result = await client.send<{
      result: { value: MacMigrationState };
      exceptionDetails?: unknown;
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `async function(teamName,seed) {
        if(seed) {
          await this.config.update('general',{theme:seed.theme});
          await this.config.addCustomProjectPath(seed.projectPath);
        }
        const config=await this.config.get(),teams=await this.teams.list();
        const team=teams.find(item=>item.teamName===teamName);
        return {theme:config.general.theme,projectPaths:config.general.customProjectPaths,
          ...(team?{team:{teamName:team.teamName,projectPath:team.projectPath,memberCount:team.memberCount}}:{})};
      }`,
      arguments: [{ value: teamName }, { value: seed ?? null }],
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  } finally {
    await client.send('Runtime.releaseObject', { objectId });
  }
}
