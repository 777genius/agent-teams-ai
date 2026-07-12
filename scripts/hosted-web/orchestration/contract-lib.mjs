import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const CANONICAL_SHA = '42ec333848e29e97c41699b9fed73ed199740e3f';
export const FORBIDDEN_REAL_PROJECT = '~/dev/projects/ai/claude-runtime';
export const PHASE_AUTHORITY_CATALOG = Object.freeze({
  'phase-00': Object.freeze({
    controllerPacket: 'docs/hosted-web-phase-0-execution-packet.md',
    packetRevisions: Object.freeze(['phase-00-r2', 'phase-00-r3']),
    lanes: Object.freeze({
      w1: 'docs/hosted-web-phases/phase-00/lanes/w1-parity-renderer.md',
      w2: 'docs/hosted-web-phases/phase-00/lanes/w2-provider-runtime.md',
      w3: 'docs/hosted-web-phases/phase-00/lanes/w3-state-writers-backup.md',
      w4: 'docs/hosted-web-phases/phase-00/lanes/w4-lease-guard-process.md',
      w5: 'docs/hosted-web-phases/phase-00/lanes/w5-events-commands-recovery.md',
      w6: 'docs/hosted-web-phases/phase-00/lanes/w6-auth-proxy-artifacts.md',
    }),
  }),
  'phase-01': Object.freeze({
    controllerPacket: 'docs/hosted-web-phases/phase-01/controller-packet.md',
    packetRevisions: Object.freeze(['phase-01-s0-bootstrap-r1']),
    lanes: Object.freeze({
      'p1-s0': 'docs/hosted-web-phases/phase-01/lanes/p1-s0-serial-bootstrap.md',
    }),
  }),
});
export const REQUIRED_WORKER_DOCS = Object.freeze([
  'AGENTS.md',
  'docs/hosted-web-phases/START_HERE.md',
  'docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md',
  'docs/hosted-web-phases/README.md',
  'docs/hosted-web-phases/EXECUTION_INDEX.json',
]);

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PHASE_ID = /^phase-[0-9]{2}$/;
const LANE_ID = /^[a-z][a-z0-9-]*$/;
const SIMPLE_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

export function parseCliArgs(argv, allowed) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`expected --name value pairs; received ${flag ?? '<end>'}`);
    }
    const key = flag.slice(2);
    if (!allowed.includes(key)) throw new Error(`unknown argument: ${flag}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${flag}`);
    parsed[key] = value;
  }
  return parsed;
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function formatIssues(label, issues) {
  return `${label} failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`;
}

export function isNormalizedRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) return false;
  if (value.includes('\\') || /[*?[\]{}]/.test(value)) return false;
  if (value === '.' || value.startsWith('./') || value.endsWith('/')) return false;
  return path.posix.normalize(value) === value && !value.split('/').includes('..');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed, prefix, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${prefix}:unexpected_field:${key}`);
  }
}

function validateString(value, pattern, label, issues) {
  if (typeof value !== 'string' || !pattern.test(value)) issues.push(label);
}

function validatePathList(value, label, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${label}:non_empty_array_required`);
    return;
  }
  const seen = new Set();
  for (const item of value) {
    if (!isNormalizedRelativePath(item)) issues.push(`${label}:invalid_exact_path:${String(item)}`);
    if (seen.has(item)) issues.push(`${label}:duplicate:${String(item)}`);
    seen.add(item);
  }
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function existingRealPath(candidate, label, issues, expectedType = undefined) {
  if (!existsSync(candidate)) {
    issues.push(`${label}:missing:${candidate}`);
    return null;
  }
  let resolved;
  let resolvedStats;
  try {
    resolved = realpathSync(candidate);
    resolvedStats = statSync(resolved);
  } catch (error) {
    issues.push(`${label}:unreadable:${error.message}`);
    return null;
  }
  if (expectedType === 'file' && !resolvedStats.isFile()) {
    issues.push(`${label}:not_file:${candidate}`);
  }
  if (expectedType === 'directory' && !resolvedStats.isDirectory()) {
    issues.push(`${label}:not_directory:${candidate}`);
  }
  return resolved;
}

export function workKeyInput(work) {
  return {
    phaseId: work.phaseId,
    laneId: work.laneId,
    baseSha: work.baseSha,
    phaseStartSha: work.phaseStartSha,
    packetRevision: work.packetRevision,
    inputPatchHash: work.inputPatchHash,
    reviewKind: work.reviewKind,
    revision: work.revision,
  };
}

export function computeWorkKey(work) {
  return sha256Bytes(JSON.stringify(workKeyInput(work)));
}

export function validateWorkerStartContract(contract, options = {}) {
  const issues = [];
  if (!isPlainObject(contract)) return { ok: false, issues: ['contract:object_required'] };

  const allowed = [
    'schemaVersion',
    'jobId',
    'workerId',
    'canonicalSha',
    'baseSha',
    'phaseStartSha',
    'packetRevision',
    'controllerPacket',
    'lanePacket',
    'phaseId',
    'laneId',
    'inputPatchHash',
    'reviewKind',
    'revision',
    'retryCount',
    'workKey',
    'supersedes',
    'registryStatus',
    'jobRoot',
    'workspaceRoot',
    'promptPath',
    'ownedPaths',
    'mandatoryDocs',
    'mandatoryScripts',
    'mandatoryFixtures',
    'requiredChecks',
    'executionPolicy',
  ];
  hasOnlyKeys(contract, allowed, 'contract', issues);

  if (contract.schemaVersion !== 1) issues.push('schemaVersion:expected_1');
  validateString(contract.jobId, SIMPLE_ID, 'jobId:invalid', issues);
  validateString(contract.workerId, SIMPLE_ID, 'workerId:invalid', issues);
  if (contract.canonicalSha !== CANONICAL_SHA)
    issues.push(`canonicalSha:expected:${CANONICAL_SHA}`);
  if (contract.baseSha !== CANONICAL_SHA) issues.push(`baseSha:expected:${CANONICAL_SHA}`);
  validateString(contract.phaseStartSha, SHA1, 'phaseStartSha:invalid', issues);
  const phaseAuthority = Object.hasOwn(PHASE_AUTHORITY_CATALOG, contract.phaseId)
    ? PHASE_AUTHORITY_CATALOG[contract.phaseId]
    : null;
  if (!phaseAuthority) {
    issues.push(`phaseId:not_authorized:${String(contract.phaseId)}`);
  } else {
    if (!phaseAuthority.packetRevisions.includes(contract.packetRevision)) {
      issues.push(
        `packetRevision:not_authorized_for_phase:${String(contract.phaseId)}:${String(contract.packetRevision)}`
      );
    }
    if (contract.controllerPacket !== phaseAuthority.controllerPacket) {
      issues.push(
        `controllerPacket:not_authoritative_for_phase:${String(contract.phaseId)}:${String(contract.controllerPacket)}`
      );
    }
    if (!Object.hasOwn(phaseAuthority.lanes, contract.laneId)) {
      issues.push(
        `laneId:not_authorized_for_phase:${String(contract.phaseId)}:${String(contract.laneId)}`
      );
    } else if (contract.lanePacket !== phaseAuthority.lanes[contract.laneId]) {
      issues.push(
        `lanePacket:not_authoritative_for_phase_lane:${String(contract.phaseId)}:${String(contract.laneId)}:${String(contract.lanePacket)}`
      );
    }
  }
  validateString(contract.inputPatchHash, SHA256, 'inputPatchHash:invalid', issues);
  if (!['implementation', 'review', 'remediation'].includes(contract.reviewKind)) {
    issues.push('reviewKind:invalid');
  }
  if (!Number.isInteger(contract.revision) || contract.revision < 0)
    issues.push('revision:invalid');
  if (!Number.isInteger(contract.retryCount) || contract.retryCount < 0)
    issues.push('retryCount:invalid');
  validateString(contract.workKey, SHA256, 'workKey:invalid', issues);
  if (
    contract.supersedes !== null &&
    (typeof contract.supersedes !== 'string' || !SHA256.test(contract.supersedes))
  ) {
    issues.push('supersedes:invalid');
  }
  if (typeof contract.workKey === 'string' && contract.workKey !== computeWorkKey(contract)) {
    issues.push('workKey:mismatch');
  }
  if (contract.revision === 0 && (contract.retryCount !== 0 || contract.supersedes !== null)) {
    issues.push('initial_work:retry_or_supersession_forbidden');
  }
  if (contract.revision > 0 && (contract.retryCount < 1 || contract.supersedes === null)) {
    issues.push('refill_work:retry_and_supersession_required');
  }
  if (contract.registryStatus !== 'queued') issues.push('registryStatus:launch_requires_queued');

  validatePathList(contract.ownedPaths, 'ownedPaths', issues);
  validatePathList(contract.mandatoryDocs, 'mandatoryDocs', issues);
  validatePathList(contract.mandatoryScripts, 'mandatoryScripts', issues);
  validatePathList(contract.mandatoryFixtures, 'mandatoryFixtures', issues);
  if (Array.isArray(contract.mandatoryDocs)) {
    for (const requiredDoc of REQUIRED_WORKER_DOCS) {
      if (!contract.mandatoryDocs.includes(requiredDoc)) {
        issues.push(`mandatoryDocs:missing_required:${requiredDoc}`);
      }
    }
    for (const packetPath of [contract.controllerPacket, contract.lanePacket]) {
      if (typeof packetPath === 'string' && !contract.mandatoryDocs.includes(packetPath)) {
        issues.push(`mandatoryDocs:missing_packet_reference:${packetPath}`);
      }
    }
  }

  if (!Array.isArray(contract.requiredChecks) || contract.requiredChecks.length === 0) {
    issues.push('requiredChecks:non_empty_array_required');
  } else {
    const checkIds = new Set();
    for (const [index, check] of contract.requiredChecks.entries()) {
      const label = `requiredChecks[${index}]`;
      if (!isPlainObject(check)) {
        issues.push(`${label}:object_required`);
        continue;
      }
      hasOnlyKeys(check, ['id', 'cwd', 'command'], label, issues);
      validateString(check.id, SIMPLE_ID, `${label}:id_invalid`, issues);
      if (checkIds.has(check.id)) issues.push(`${label}:duplicate_id:${check.id}`);
      checkIds.add(check.id);
      if (!isNormalizedRelativePath(check.cwd)) issues.push(`${label}:cwd_invalid_exact_path`);
      if (
        typeof check.command !== 'string' ||
        check.command.trim() !== check.command ||
        check.command.length === 0
      ) {
        issues.push(`${label}:command_invalid`);
      }
    }
  }

  if (!isPlainObject(contract.executionPolicy)) {
    issues.push('executionPolicy:object_required');
  } else {
    hasOnlyKeys(
      contract.executionPolicy,
      ['mode', 'sandboxRoot', 'forbiddenRealProjects'],
      'executionPolicy',
      issues
    );
    if (contract.executionPolicy.mode !== 'sandbox-only')
      issues.push('executionPolicy:mode_must_be_sandbox-only');
    if (!Array.isArray(contract.executionPolicy.forbiddenRealProjects)) {
      issues.push('executionPolicy:forbiddenRealProjects_array_required');
    } else {
      if (!contract.executionPolicy.forbiddenRealProjects.includes(FORBIDDEN_REAL_PROJECT)) {
        issues.push(`executionPolicy:missing_forbidden_project:${FORBIDDEN_REAL_PROJECT}`);
      }
      if (
        new Set(contract.executionPolicy.forbiddenRealProjects).size !==
        contract.executionPolicy.forbiddenRealProjects.length
      ) {
        issues.push('executionPolicy:duplicate_forbidden_project');
      }
    }
  }

  const checkFilesystem = options.checkFilesystem !== false;
  if (!path.isAbsolute(contract.jobRoot ?? '')) issues.push('jobRoot:absolute_path_required');
  if (!path.isAbsolute(contract.workspaceRoot ?? '')) {
    issues.push('workspaceRoot:absolute_path_required');
  }
  if (!path.isAbsolute(contract.promptPath ?? '')) issues.push('promptPath:absolute_path_required');
  if (!path.isAbsolute(contract.executionPolicy?.sandboxRoot ?? '')) {
    issues.push('executionPolicy:sandboxRoot_absolute_path_required');
  }

  const absoluteJobRoot = path.isAbsolute(contract.jobRoot ?? '')
    ? path.resolve(contract.jobRoot)
    : null;
  const absoluteWorkspaceRoot = path.isAbsolute(contract.workspaceRoot ?? '')
    ? path.resolve(contract.workspaceRoot)
    : null;
  const absolutePromptPath = path.isAbsolute(contract.promptPath ?? '')
    ? path.resolve(contract.promptPath)
    : null;
  const absoluteSandboxRoot = path.isAbsolute(contract.executionPolicy?.sandboxRoot ?? '')
    ? path.resolve(contract.executionPolicy.sandboxRoot)
    : null;

  if (
    absoluteJobRoot &&
    absoluteWorkspaceRoot &&
    (containedBy(absoluteJobRoot, absoluteWorkspaceRoot) ||
      containedBy(absoluteWorkspaceRoot, absoluteJobRoot))
  ) {
    issues.push('roots:jobRoot_workspaceRoot_must_not_overlap');
  }
  if (
    absolutePromptPath &&
    absoluteWorkspaceRoot &&
    containedBy(absoluteWorkspaceRoot, absolutePromptPath)
  ) {
    issues.push('promptPath:inside_workspaceRoot');
  }
  if (
    absoluteJobRoot &&
    absoluteSandboxRoot &&
    (containedBy(absoluteJobRoot, absoluteSandboxRoot) ||
      containedBy(absoluteSandboxRoot, absoluteJobRoot))
  ) {
    issues.push('executionPolicy:sandboxRoot_overlaps_jobRoot');
  }
  if (
    absoluteWorkspaceRoot &&
    absoluteSandboxRoot &&
    !containedBy(absoluteWorkspaceRoot, absoluteSandboxRoot)
  ) {
    issues.push('executionPolicy:sandboxRoot_outside_workspaceRoot');
  }

  if (checkFilesystem) {
    const jobRoot = absoluteJobRoot
      ? existingRealPath(absoluteJobRoot, 'jobRoot', issues, 'directory')
      : null;
    const workspaceRoot = absoluteWorkspaceRoot
      ? existingRealPath(absoluteWorkspaceRoot, 'workspaceRoot', issues, 'directory')
      : null;
    const prompt = absolutePromptPath
      ? existingRealPath(absolutePromptPath, 'promptPath', issues, 'file')
      : null;
    const sandbox = absoluteSandboxRoot
      ? existingRealPath(absoluteSandboxRoot, 'executionPolicy:sandboxRoot', issues, 'directory')
      : null;

    if (jobRoot && prompt && !containedBy(jobRoot, prompt)) {
      issues.push('promptPath:outside_jobRoot');
    }
    if (workspaceRoot && prompt && containedBy(workspaceRoot, prompt)) {
      issues.push('promptPath:inside_workspaceRoot');
    }
    if (
      jobRoot &&
      workspaceRoot &&
      (containedBy(jobRoot, workspaceRoot) || containedBy(workspaceRoot, jobRoot))
    ) {
      issues.push('roots:jobRoot_workspaceRoot_must_not_overlap');
    }
    if (jobRoot && sandbox && (containedBy(jobRoot, sandbox) || containedBy(sandbox, jobRoot))) {
      issues.push('executionPolicy:sandboxRoot_overlaps_jobRoot');
    }
    if (workspaceRoot && sandbox && !containedBy(workspaceRoot, sandbox)) {
      issues.push('executionPolicy:sandboxRoot_outside_workspaceRoot');
    }
    if (workspaceRoot && options.checkGitHead !== false) {
      try {
        const actualHead =
          options.gitHead ??
          execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
        if (actualHead !== contract.phaseStartSha) {
          issues.push(
            `workspaceRoot:git_head_expected:${contract.phaseStartSha}:actual:${actualHead}`
          );
        }
      } catch (error) {
        const recoveredHead =
          typeof error.stdout === 'string' && SHA1.test(error.stdout.trim())
            ? error.stdout.trim()
            : null;
        if (recoveredHead && recoveredHead !== contract.phaseStartSha) {
          issues.push(
            `workspaceRoot:git_head_expected:${contract.phaseStartSha}:actual:${recoveredHead}`
          );
        } else if (!recoveredHead) {
          issues.push(
            `workspaceRoot:git_head_unavailable:${error.status ?? error.code ?? error.message}`
          );
        }
      }
    }

    for (const [label, values] of [
      ['mandatoryDocs', contract.mandatoryDocs],
      ['mandatoryScripts', contract.mandatoryScripts],
      ['mandatoryFixtures', contract.mandatoryFixtures],
    ]) {
      if (!Array.isArray(values)) continue;
      for (const relative of values) {
        if (!workspaceRoot || !isNormalizedRelativePath(relative)) continue;
        const resolved = existingRealPath(
          path.resolve(contract.workspaceRoot, relative),
          label,
          issues,
          'file'
        );
        if (workspaceRoot && resolved && !containedBy(workspaceRoot, resolved))
          issues.push(`${label}:symlink_escape:${relative}`);
      }
    }
    if (Array.isArray(contract.requiredChecks)) {
      for (const check of contract.requiredChecks) {
        if (!workspaceRoot || !isPlainObject(check) || !isNormalizedRelativePath(check.cwd)) {
          continue;
        }
        const resolved = existingRealPath(
          path.resolve(contract.workspaceRoot, check.cwd),
          'requiredChecks:cwd',
          issues,
          'directory'
        );
        if (workspaceRoot && resolved && !containedBy(workspaceRoot, resolved))
          issues.push(`requiredChecks:cwd_symlink_escape:${check.cwd}`);
      }
    }

    const home = options.homeDirectory ?? homedir();
    const forbidden = Array.isArray(contract.executionPolicy?.forbiddenRealProjects)
      ? contract.executionPolicy.forbiddenRealProjects
      : [];
    for (const denied of forbidden) {
      if (typeof denied !== 'string' || denied.length === 0) continue;
      const deniedPath = path.resolve(expandHome(denied, home));
      for (const [label, candidate] of [
        ['jobRoot', jobRoot],
        ['workspaceRoot', workspaceRoot],
        ['promptPath', prompt],
        ['executionPolicy:sandboxRoot', sandbox],
      ]) {
        if (
          candidate &&
          (containedBy(deniedPath, candidate) || containedBy(candidate, deniedPath))
        ) {
          issues.push(`${label}:forbidden_real_project:${denied}`);
        }
      }
    }
  }

  const uniqueIssues = [...new Set(issues)];
  return { ok: uniqueIssues.length === 0, issues: uniqueIssues };
}

export function validateSha1(value) {
  return typeof value === 'string' && SHA1.test(value);
}

export function validateSha256(value) {
  return typeof value === 'string' && SHA256.test(value);
}

export function validatePhaseId(value) {
  return typeof value === 'string' && PHASE_ID.test(value);
}

export function validateLaneId(value) {
  return typeof value === 'string' && LANE_ID.test(value);
}

export function isObject(value) {
  return isPlainObject(value);
}

export function isContainedBy(root, candidate) {
  return containedBy(root, candidate);
}
