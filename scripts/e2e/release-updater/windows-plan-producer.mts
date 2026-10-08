import assert from 'node:assert/strict';

export interface WindowsProducerJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string;
  started_at: string;
  completed_at: string;
  steps: {
    name: string;
    status: string;
    conclusion: string;
    started_at: string;
    completed_at: string;
  }[];
}

export function validateWindowsProducerUpload(
  job: WindowsProducerJob,
  runId: number,
  stepName: string,
  artifactCreatedAt: string
): void {
  assert.equal(job.run_id, runId, 'Producer job must belong to the selected run');
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  assert(Array.isArray(job.steps), 'Producer upload steps missing');
  const uploads = job.steps.filter((step) => step.name === stepName);
  const upload = uploads[0];
  assert(
    uploads.length === 1 && upload?.status === 'completed' && upload.conclusion === 'success',
    'Producer upload step missing, ambiguous, or unsuccessful'
  );
  const jobStart = Date.parse(job.started_at);
  const jobEnd = Date.parse(job.completed_at);
  const uploadStart = Date.parse(upload.started_at);
  const uploadEnd = Date.parse(upload.completed_at);
  const created = Date.parse(artifactCreatedAt);
  // GitHub step clocks have second precision. Admit the inclusive one-second
  // boundary used by full native readiness; later creation remains rejected.
  assert(
    [jobStart, jobEnd, uploadStart, uploadEnd, created].every(Number.isFinite) &&
      jobStart <= uploadStart &&
      uploadStart <= uploadEnd &&
      uploadEnd <= jobEnd &&
      created >= uploadStart &&
      created <= uploadEnd + 1000,
    'Artifact must be created by the selected successful producer upload step'
  );
}
