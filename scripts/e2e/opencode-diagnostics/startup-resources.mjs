// Read-only measurements for the disposable real-runtime Electron E2E.
// Never inspect or persist command lines, environment, credentials or foreign PIDs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownedTree, powershell, processes } from './platform.mjs';

const PHASES = new Set(['renderer-ready', 'post-renderer-delay', 'after-provider-settings']);

export function parseCpuTimeMs(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  assert(match, 'Invalid OS CPU time');
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  assert(seconds < 60 && (match[2] == null || minutes < 60), 'Invalid OS CPU time components');
  const milliseconds = Math.round((days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000);
  assert(Number.isSafeInteger(milliseconds) && milliseconds >= 0, 'Invalid OS CPU time range');
  return milliseconds;
}

export function parseUnixResourceRows(output) {
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    assert(match, 'Invalid OS resource row');
    const pid = Number(match[1]);
    const rssBytes = Number(match[2]) * 1024;
    const cpuTimeMs = parseCpuTimeMs(match[3]);
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(rssBytes) && rssBytes >= 0,
      'Invalid OS resource count');
    return { pid, rssBytes, cpuTimeMs, name: match[4] };
  });
}

export function parseWindowsResourceRows(output) {
  const raw = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  return (Array.isArray(raw) ? raw : [raw]).map((row) => {
    assert(row && row.pid != null && row.rssBytes != null && row.cpuTimeMs != null,
      'Invalid Windows process resources');
    const pid = Number(row.pid);
    const rssBytes = Number(row.rssBytes);
    const cpuTimeMs = Number(row.cpuTimeMs);
    assert(Number.isSafeInteger(pid) && pid > 0 &&
      Number.isSafeInteger(rssBytes) && rssBytes >= 0 &&
      Number.isFinite(cpuTimeMs) && cpuTimeMs >= 0 &&
      typeof row.name === 'string', 'Invalid Windows process resources');
    return { pid, rssBytes, cpuTimeMs, name: row.name };
  });
}

function readResources(pids) {
  assert(pids.length > 0 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  if (process.platform === 'win32') {
    const script = '$ids=@(' + pids.join(',') +
      '); @(Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object {' +
      ' if ($null -eq $_.WorkingSetSize -or $null -eq $_.KernelModeTime -or $null -eq $_.UserModeTime) { throw "Missing process resource" };' +
      ' [pscustomobject]@{ pid=[int]$_.ProcessId; rssBytes=[double]$_.WorkingSetSize;' +
      ' cpuTimeMs=([double]$_.KernelModeTime + [double]$_.UserModeTime)/10000;' +
      ' name=[string]$_.Name } }) | ConvertTo-Json -Compress';
    return parseWindowsResourceRows(powershell(script));
  }
  return parseUnixResourceRows(execFileSync('ps', [
    '-p', pids.join(','), '-o', 'pid=,rss=,time=,comm=',
  ], { encoding: 'utf8', timeout: 30000, env: { ...process.env, LC_ALL: 'C' } }));
}

/** Include only still-owned PIDs with unchanged OS birth identities after the resource read. */
export function stableOwnedResources(owned, resources, after) {
  const latest = new Map(after.map((entry) => [entry.pid, entry.birth]));
  const observed = new Map(resources.map((entry) => [entry.pid, entry]));
  return owned.flatMap(({ pid, birth }) => {
    const resource = observed.get(pid);
    return resource && latest.get(pid) === birth ? [{ pid, birth, ...resource }] : [];
  });
}

/** Aggregate without exporting private identities, paths, process names, or commands. */
export function summarizePhase(phase, ownedCount, stable, previous, elapsedMs) {
  assert(PHASES.has(phase) && Number.isSafeInteger(ownedCount) && ownedCount >= stable.length);
  const old = new Map(previous.map((row) => [row.pid + ':' + row.birth, row.cpuTimeMs]));
  let cpuTimeMsSurvivorsDelta = 0;
  let comparableSurvivors = 0;
  for (const row of stable) {
    const prevCpu = old.get(row.pid + ':' + row.birth);
    if (prevCpu !== undefined && row.cpuTimeMs >= prevCpu) {
      cpuTimeMsSurvivorsDelta += row.cpuTimeMs - prevCpu;
      comparableSurvivors += 1;
    }
  }
  return {
    phase,
    elapsedSincePreviousMs: elapsedMs,
    ownedProcessCount: ownedCount,
    resourceSampledProcessCount: stable.length,
    rssWorkingSetBytesSum: stable.reduce((sum, row) => sum + row.rssBytes, 0),
    cumulativeCpuTimeMsLive: Math.round(stable.reduce((sum, row) => sum + row.cpuTimeMs, 0)),
    cpuTimeMsSurvivorsDelta: Math.round(cpuTimeMsSurvivorsDelta),
    comparableSurvivorCount: comparableSurvivors,
    cliNamedAliveLowerBound: stable.filter((row) =>
      /^(?:opencode|codex|claude)(?:$|[-.])/i.test(path.basename(row.name))
    ).length,
  };
}

async function capture(root, phase) {
  assert(PHASES.has(phase), 'Unsupported startup resource phase');
  assert(root && path.basename(root).startsWith('opencode-diagnostics-e2e-'));
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(path.resolve(manifest.root), path.resolve(root));
  assert(manifest.realRuntime && manifest.launcher?.birth, 'Only real-runtime owned sessions can be sampled');
  const owned = ownedTree(processes(), manifest.launcher);
  const resourceRows = readResources(owned.map((item) => item.pid));
  const stable = stableOwnedResources(owned, resourceRows, processes());
  assert(stable.length > 0, 'No stable owned process resources');
  const privateFile = path.join(root, 'startup-resource-private.json');
  let previous = { at: Date.now(), instances: [], observations: [] };
  try {
    previous = JSON.parse(await readFile(privateFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const at = Date.now();
  const report = summarizePhase(phase, owned.length, stable, previous.instances, at - previous.at);
  const observations = [...previous.observations, report];
  await writeFile(privateFile, JSON.stringify({
    at, instances: stable.map(({ pid, birth, cpuTimeMs }) => ({ pid, birth, cpuTimeMs })),
    observations,
  }), { mode: 0o600 });
  await writeFile(path.join(root, 'startup-resource-metrics.json'), JSON.stringify({
    schemaVersion: 1,
    platform: process.platform,
    qualification: 'owned-process-sampled-only',
    complete: phase === 'after-provider-settings',
    observations,
  }, null, 2));
  console.log('Startup resource sample: ' + phase + ' (' + stable.length + ' owned alive)');
}

/**
 * A failed later sample retains only validated numeric fields from previously
 * published samples. Never copy the private PID/birth snapshot into CI.
 */
export function safePriorResourceObservations(report, failedPhase) {
  const fields = [
    'elapsedSincePreviousMs', 'ownedProcessCount', 'resourceSampledProcessCount',
    'rssWorkingSetBytesSum', 'cumulativeCpuTimeMsLive', 'cpuTimeMsSurvivorsDelta',
    'comparableSurvivorCount', 'cliNamedAliveLowerBound',
  ];
  if (report?.schemaVersion !== 1 || report.qualification !== 'owned-process-sampled-only' ||
      report.platform !== process.platform || !Array.isArray(report.observations) ||
      report.observations.length > 3) return [];
  const seen = new Set();
  return report.observations.flatMap((row) => {
    if (!row || !PHASES.has(row.phase) || row.phase === failedPhase || seen.has(row.phase) ||
        !fields.every((key) => Number.isSafeInteger(row[key]) && row[key] >= 0)) return [];
    seen.add(row.phase);
    return [{ phase: row.phase, ...Object.fromEntries(fields.map((key) => [key, row[key]])) }];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv[3] ?? '';
  capture(process.argv[2], phase).catch(async () => {
    try {
      const evidenceFile = path.join(process.argv[2], 'startup-resource-metrics.json');
      let observations = [];
      try {
        observations = safePriorResourceObservations(
          JSON.parse(await readFile(evidenceFile, 'utf8')), phase
        );
      } catch { /* An unreadable prior report is not evidence. */ }
      await writeFile(evidenceFile, JSON.stringify({
        schemaVersion: 1, platform: process.platform, complete: false,
        failedPhase: phase, reason: 'measurement_unavailable', observations,
      }, null, 2));
    } catch { /* Preserve the failure exit code. */ }
    process.exitCode = 1;
  });
}
