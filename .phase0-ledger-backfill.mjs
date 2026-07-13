import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = "/var/data/agent-teams-hosted-web-refactor";
const registry = join(root, "worker-jobs/registry-v2");
const controllerRoot = join(root, "worker-jobs/jobs/agent-teams-hosted-web-refactor-controller-v2");
const attemptsRoot = join(controllerRoot, "project-integration/integration-attempts");
const ledgerRoot = join(root, "control/consumed-output-ledger-v2/items");
const integration = join(root, "worktrees/integration-hosted-web-feature-boundaries");

const integrated = [
  ["agent-teams-hosted-web-refactor-phase-00-review-w1-w2-v1", "phase-00-review-w1-w2-evidence-v1", "fee646f88a43968fe933260e3b94bac98afdfaf0"],
  ["agent-teams-hosted-web-refactor-phase-00-review-w3-w5-v1", "phase-00-review-w3-w5-evidence-v1", "8e6920523a8eea02b283637c895f4aa9a13b574c"],
  ["agent-teams-hosted-web-refactor-phase-00-review-w4-w6-v1", "phase-00-review-w4-w6-evidence-v1", "32f2a89d96161989716989fb507b5a807437dfde"],
  ["agent-teams-hosted-web-refactor-phase-00-audit-cross-lane-v1", "phase-00-audit-cross-lane-evidence-v1", "808f84f081bf7c4742318231f410967cde07c420"],
  ["agent-teams-hosted-web-refactor-phase-00-audit-requirements-v1", "phase-00-audit-requirements-evidence-v1", "8e6398f009a21c6851c2e4a5afb19469fd0b9ae3"],
  ["agent-teams-hosted-web-refactor-phase-00-prep-evidence-phase1-v1", "phase-00-prep-evidence-phase1-v1", "0e8431b1935c71a2e77bea1384b134ee25c8aa12"],
];

const rejected = [1, 2, 3, 4, 5, 6].map((lane) => [
  `agent-teams-hosted-web-refactor-phase-00-w${lane}-v1`,
  `phase-00-rejected-w${lane}-v1`,
]);

const attemptById = new Map();
for (const entry of execFileSync("find", [attemptsRoot, "-name", "attempt.json"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)) {
  const attempt = JSON.parse(readFileSync(entry, "utf8"));
  attemptById.set(attempt.attemptId, attempt);
}

const remoteHead = execFileSync("git", ["ls-remote", "origin", "refs/heads/refactor/hosted-web-feature-boundaries"], {
  cwd: integration,
  encoding: "utf8",
}).trim().split(/\s+/)[0];
if (!/^[0-9a-f]{40}$/.test(remoteHead)) throw new Error("remote head missing");

mkdirSync(ledgerRoot, { recursive: true, mode: 0o700 });

function workspaceFor(jobId) {
  return JSON.parse(readFileSync(join(registry, jobId, "job.json"), "utf8")).workspacePath;
}

function patchFor(jobId, workspace) {
  const path = join(workspace, ".codex-handoff", `${jobId}.patch`);
  if (statSync(path).size === 0) throw new Error(`empty patch: ${jobId}`);
  return path;
}

function backupFor(jobId, workspace) {
  const statusPath = join(workspace, ".codex-handoff", `${jobId}.status.txt`);
  writeFileSync(statusPath, execFileSync("git", ["status", "--short"], { cwd: workspace, encoding: "utf8" }), { mode: 0o600 });
  return { workspace, statusPath, patchPath: patchFor(jobId, workspace) };
}

function writeRecord(jobId, record) {
  const path = join(ledgerRoot, `${jobId}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

for (const [jobId, attemptId, commitSha] of integrated) {
  const attempt = attemptById.get(attemptId);
  if (!attempt || attempt.workerOutput?.workerJobId !== jobId) throw new Error(`attempt mismatch: ${attemptId}`);
  if (attempt.commitCandidate?.commitSha !== commitSha) throw new Error(`commit mismatch: ${attemptId}`);
  execFileSync("git", ["merge-base", "--is-ancestor", commitSha, remoteHead], { cwd: integration });
  const workspace = workspaceFor(jobId);
  const closedAt = new Date().toISOString();
  writeRecord(jobId, {
    schemaVersion: 1,
    jobId,
    status: "integrated",
    closedAt,
    consumedAt: closedAt,
    integratedCommitSha: commitSha,
    commitSha,
    commit: commitSha,
    note: `Audited host-operator ledger recovery for lifecycle attempt ${attemptId}; commit is an ancestor of remote ${remoteHead}.`,
    backup: backupFor(jobId, workspace),
    notes: [{ status: "integrated", text: "Lifecycle output recovered after batched ancestor push omitted ledger write.", commit: commitSha }],
  });
}

for (const [jobId, attemptId] of rejected) {
  const attempt = attemptById.get(attemptId);
  if (!attempt || attempt.status !== "rejected" || attempt.workerOutput?.workerJobId !== jobId) {
    throw new Error(`rejected attempt mismatch: ${attemptId}`);
  }
  const workspace = workspaceFor(jobId);
  const closedAt = new Date().toISOString();
  writeRecord(jobId, {
    schemaVersion: 1,
    jobId,
    status: "rejected",
    closedAt,
    consumedAt: closedAt,
    note: `Audited host-operator ledger recovery for rejected lifecycle attempt ${attemptId}.`,
    backup: backupFor(jobId, workspace),
    notes: [{ status: "rejected", text: "Reciprocal acceptance review rejected this authored output." }],
  });
}

console.log(JSON.stringify({ ok: true, integrated: integrated.length, rejected: rejected.length, remoteHead }));
