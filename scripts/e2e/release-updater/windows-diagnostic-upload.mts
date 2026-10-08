import assert from 'node:assert/strict';
import { validateWindowsProducerUpload } from './windows-plan-producer.mts';
import type { WindowsProducerJob } from './windows-plan-producer.mts';

// Fixed W11 diagnostic custody only. Qualifying producer clock policy is unchanged.
export function validateW11DiagnosticUpload(
  job: WindowsProducerJob,
  createdAt: string,
  log: string
) {
  assert.equal(job.id, 113076297087);
  assert.equal(job.run_id, 37704738528);
  assert.equal(job.name, 'verified-windows-inputs');
  const lines = log.trim().split(/\r?\n/u);
  function exact(message: string) {
    const matches = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.endsWith(` ${message}`));
    assert.equal(matches.length, 1, `Missing or ambiguous W11 upload evidence: ${message}`);
    const match = matches[0];
    assert(match);
    const at = match.line.slice(0, match.line.indexOf(' '));
    validateWindowsProducerUpload(job, 37704738528, 'Run actions/upload-artifact@v7', at);
    return { at, index: match.index };
  }
  const start = exact('##[group]Run actions/upload-artifact@v7');
  const name = exact('  name: TEST-windows-ota-inputs-37704738528-1');
  const digest = exact(
    'SHA256 digest of uploaded artifact is f527dc188ebd821b243b84c4531d719bc700474df977111f0a6958dc25ff20f1'
  );
  const finalized = exact(
    'Artifact TEST-windows-ota-inputs-37704738528-1 successfully finalized. Artifact ID 11519836033'
  );
  const uploaded = exact(
    'Artifact TEST-windows-ota-inputs-37704738528-1 has been successfully uploaded! Final size is 874799445 bytes. Artifact ID is 11519836033'
  );
  const url = exact(
    'Artifact download URL: https://github.com/777genius/agent-teams-ai/actions/runs/37704738528/artifacts/11519836033'
  );
  const proof = [start, name, digest, finalized, uploaded, url];
  for (const [index, row] of proof.entries()) {
    const previous = proof[index - 1];
    if (previous)
      assert(row.index > previous.index && Date.parse(row.at) >= Date.parse(previous.at));
  }
  const created = Date.parse(createdAt);
  assert(
    Number.isFinite(created) &&
      created >= Date.parse(finalized.at) &&
      created <= Date.parse(job.completed_at),
    'W11 artifact API creation must follow exact upload finalization within the successful job'
  );
  return {
    qualifying: false,
    jobId: job.id,
    createdAt,
    uploadLogFinalizedAt: finalized.at,
    artifactId: 11519836033,
  };
}
