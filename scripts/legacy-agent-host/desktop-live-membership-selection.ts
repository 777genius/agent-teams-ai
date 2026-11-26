import assert from 'node:assert/strict';
import { digest as teamDigest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { replaceRosterSchema } from '../../packages/legacy-agent-host/dist/team/rosterSchema.js';
import { parseRosterReplacement } from '../../src/features/agent-backend/main/adapters/rosterValues.ts';

/** Main's finite wire serialization is the probe input; the Host journal adds commandId and schema order. */
export function readDesktopLiveMembershipPayload(commandId: string, decision: {
  input: unknown; requestDigest: unknown; capture: Record<string, unknown>;
}) {
  const parsed = replaceRosterSchema.parse(decision.input);
  assert.equal(parsed.commandId, commandId, 'same original roster command');
  const { commandId: originalCommandId, ...saved } = parsed;
  const payload = parseRosterReplacement(saved);
  assert.deepEqual(replaceRosterSchema.parse({ ...payload, commandId }), parsed,
    'same complete original parsed replacement');
  assert.equal(teamDigest({ commandId: originalCommandId, payload }), decision.requestDigest,
    'same original Host request digest');
  assert.equal(decision.capture.commandId, commandId);
  assert.equal(decision.capture.requestDigest, decision.requestDigest);
  assert.equal(decision.capture.expectedRevision, payload.expectedRevision);
  return payload;
}
