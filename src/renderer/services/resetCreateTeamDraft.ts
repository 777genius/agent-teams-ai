import { discardRetainedGatewayBindingDraft } from '@features/gateway-provider/renderer';

import { retireCreateTeamDraftGeneration } from './createTeamDraftGeneration';
import { createTeamDraftStorage } from './createTeamDraftStorage';
import { draftStorage } from './draftStorage';

/**
 * Retire one in-progress creation editor before replacing its inputs.
 * The generation changes synchronously, before old React hooks unmount.
 * Each storage then serializes earlier in-flight writes before deletion.
 */
export async function resetCreateTeamDraft(): Promise<void> {
  retireCreateTeamDraftGeneration();
  discardRetainedGatewayBindingDraft('createTeam');
  await Promise.all([
    createTeamDraftStorage.deleteSnapshot(),
    draftStorage.deleteDraft('createTeam:description'),
    draftStorage.deleteDraft('createTeam:prompt'),
    draftStorage.deleteDraft('createTeam:prompt:chips'),
  ]);
}
