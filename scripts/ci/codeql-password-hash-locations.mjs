import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ruleId = 'js/insufficient-password-hash';
const maximumInputBytes = 64 * 1024 * 1024;
const row = (value) => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** Deliberately excludes every SARIF message, snippet, property and unrelated rule. */
export function collectPasswordHashLocations(sarif, { trackedPaths, workspace, provenance }) {
  const report = { schemaVersion: 1, ruleId, status: 'complete', provenance,
    counts: { results: 0, flows: 0, threads: 0, locations: 0, omitted: 0 }, results: [] };
  const incomplete = () => { report.status = 'partial'; report.counts.omitted++; };
  if (provenance.analysisOutcome !== 'success') incomplete();
  const unavailable = () => ({ ...report, status: 'unavailable', reason: 'invalid-sarif' });
  if (!row(sarif) || sarif.version !== '2.1.0' || !Array.isArray(sarif.runs) ||
      !sarif.runs.length || sarif.runs.length > 16) return unavailable();
  const tracked = new Set(trackedPaths);
  const checkoutUrl = pathToFileURL(resolve(workspace) + sep).href;
  const relativeUri = (value) => {
    if (typeof value !== 'string' || !value || value.length > 4096) return undefined;
    try {
      const decoded = decodeURIComponent(value);
      if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || /[\\\0\r\n?#]/u.test(decoded) ||
          isAbsolute(decoded) || decoded.split('/').some(part => !part || part === '.' || part === '..'))
        return undefined;
      return decoded;
    } catch { return undefined; }
  };
  for (const [runIndex, run] of sarif.runs.entries()) {
    if (!row(run) || run.tool?.driver?.name !== 'CodeQL' || !Array.isArray(run.results)) {
      incomplete(); continue;
    }
    if (run.invocations !== undefined) {
      if (!Array.isArray(run.invocations) || run.invocations.length > 64) incomplete();
      else for (const invocation of run.invocations) {
        if (!row(invocation) || invocation.executionSuccessful === false ||
            (invocation.executionSuccessful !== undefined && typeof invocation.executionSuccessful !== 'boolean'))
          incomplete();
        for (const kind of ['toolExecutionNotifications', 'toolConfigurationNotifications']) {
          const notifications = invocation?.[kind];
          if (notifications !== undefined && (!Array.isArray(notifications) ||
              notifications.length > 128 || notifications.some(value => !row(value) || value.level === 'error')))
            incomplete();
        }
      }
    }
    const resolveLocation = (location) => {
      if (!row(location)) return undefined;
      const path = relativeUri(location.uri);
      if (!path) return undefined;
      if (location.uriBaseId !== undefined) {
        if (typeof location.uriBaseId !== 'string') return undefined;
        const base = run.originalUriBaseIds?.[location.uriBaseId];
        // The standard absolute checkout base is accepted internally, never emitted.
        if (!row(base) || base.uriBaseId !== undefined || base.uri !== checkoutUrl) return undefined;
      }
      return tracked.has(path) ? path : undefined;
    };
    const artifact = (reference) => {
      if (!row(reference)) return undefined;
      if (reference.index !== undefined) {
        if (!Number.isSafeInteger(reference.index) || reference.index < 0 || !Array.isArray(run.artifacts))
          return undefined;
        const indexed = run.artifacts?.[reference.index]?.location;
        if (!row(indexed) || indexed.index !== undefined) return undefined;
        const path = resolveLocation(indexed);
        const explicit = { uri: reference.uri === undefined ? indexed.uri : reference.uri,
          uriBaseId: reference.uriBaseId === undefined ? indexed.uriBaseId : reference.uriBaseId };
        return path && resolveLocation(explicit) === path ? path : undefined;
      }
      return resolveLocation(reference);
    };
    for (const [resultIndex, result] of run.results.entries()) {
      if (report.counts.results >= 10_000) { incomplete(); break; }
      report.counts.results++;
      if (!row(result)) { incomplete(); continue; }
      // This bounded diagnostic resolves only direct driver-rule references.
      if (result.rule !== undefined) { incomplete(); continue; }
      const indexedRule = Array.isArray(run.tool.driver.rules) && Number.isSafeInteger(result.ruleIndex) && result.ruleIndex >= 0
        ? run.tool.driver.rules?.[result.ruleIndex]?.id : undefined;
      if ((result.ruleId !== undefined && typeof result.ruleId !== 'string') ||
          (result.ruleIndex !== undefined && typeof indexedRule !== 'string') ||
          (result.ruleId === undefined && result.ruleIndex === undefined)) { incomplete(); continue; }
      if (result.ruleId !== ruleId && indexedRule !== ruleId) continue;
      if ((result.ruleId !== undefined && result.ruleId !== ruleId) ||
          (result.ruleIndex !== undefined && indexedRule !== ruleId)) { incomplete(); continue; }
      if (report.results.length >= 128) { incomplete(); break; }
      const selected = { runIndex, resultIndex, locations: [] };
      report.results.push(selected);
      const add = (location, identity) => {
        if (report.counts.locations >= 4096) { incomplete(); return false; }
        report.counts.locations++;
        const physical = location?.physicalLocation, region = physical?.region;
        const path = artifact(physical?.artifactLocation);
        if (!path || !row(region) || !integer(region.startLine) ||
            (region.startColumn !== undefined && !integer(region.startColumn)) ||
            (region.endLine !== undefined && (!integer(region.endLine) || region.endLine < region.startLine)) ||
            (region.endColumn !== undefined && (!integer(region.endColumn) ||
              ((region.endLine ?? region.startLine) === region.startLine &&
                region.startColumn !== undefined && region.endColumn < region.startColumn)))) {
          incomplete(); return true;
        }
        selected.locations.push({ ...identity, path, startLine: region.startLine,
          ...(region.startColumn === undefined ? {} : { startColumn: region.startColumn }),
          ...(region.endLine === undefined ? {} : { endLine: region.endLine }),
          ...(region.endColumn === undefined ? {} : { endColumn: region.endColumn }) });
        return true;
      };
      for (const kind of ['locations', 'relatedLocations']) {
        const values = result[kind];
        if (!Array.isArray(values)) {
          if (kind === 'locations' || values !== undefined) incomplete();
          continue;
        }
        if (kind === 'locations' && !values.length) incomplete();
        for (let index = 0; index < Math.min(values.length, 4096); index++)
          if (!add(values[index], { kind, locationIndex: index })) break;
        if (values.length > 4096) incomplete();
      }
      if (!Array.isArray(result.codeFlows) || !result.codeFlows.length) { incomplete(); continue; }
      for (const [codeFlowIndex, flow] of result.codeFlows.entries()) {
        if (report.counts.flows >= 512) { incomplete(); break; }
        report.counts.flows++;
        if (!Array.isArray(flow?.threadFlows) || !flow.threadFlows.length) { incomplete(); continue; }
        for (const [threadFlowIndex, thread] of flow.threadFlows.entries()) {
          if (report.counts.threads >= 1024) { incomplete(); break; }
          report.counts.threads++;
          if (!Array.isArray(thread?.locations) || !thread.locations.length) { incomplete(); continue; }
          for (let locationIndex = 0; locationIndex < Math.min(thread.locations.length, 4096); locationIndex++) {
            const entry = thread.locations[locationIndex];
            let location = entry?.location;
            if (entry?.index !== undefined) {
              const indexed = Array.isArray(run.threadFlowLocations) && Number.isSafeInteger(entry.index) && entry.index >= 0
                ? run.threadFlowLocations?.[entry.index]?.location : undefined;
              location = location === undefined ? indexed : undefined;
            }
            if (!add(location, { kind: 'flow', codeFlowIndex, threadFlowIndex, locationIndex })) break;
          }
          if (thread.locations.length > 4096) incomplete();
        }
      }
    }
  }
  return report;
}

export function readPasswordHashLocations(path, options) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const original = fstatSync(descriptor);
    if (!original.isFile() || original.size > maximumInputBytes) throw new Error();
    const bytes = Buffer.alloc(original.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const current = fstatSync(descriptor);
    if (count !== original.size || current.size !== original.size || current.mtimeMs !== original.mtimeMs)
      throw new Error();
    return collectPasswordHashLocations(JSON.parse(bytes.subarray(0, count).toString('utf8')), options);
  } catch {
    return { schemaVersion: 1, ruleId, status: 'unavailable', reason: 'unreadable-sarif',
      provenance: options.provenance };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function main() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const workspace = git('rev-parse', '--show-toplevel').trim();
  const checkoutSha = git('rev-parse', 'HEAD').trim(), treeSha = git('rev-parse', 'HEAD^{tree}').trim();
  if (!sha(checkoutSha) || !sha(treeSha) || process.env.GITHUB_SHA !== checkoutSha)
    throw new Error('Source identity unavailable');
  git('diff', '--quiet', 'HEAD', '--');
  const analysisOutcome = process.env.CODEQL_ANALYSIS_OUTCOME;
  if (!['success', 'failure', 'cancelled', 'skipped'].includes(analysisOutcome))
    throw new Error('Analysis outcome unavailable');
  const provenance = { checkoutSha, treeSha, language: 'javascript-typescript', analysisOutcome };
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    const value = process.env[key];
    if (!/^[1-9][0-9]{0,19}$/.test(value ?? '')) throw new Error('Run identity unavailable');
    provenance[key] = value;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(process.env.GITHUB_JOB ?? ''))
    throw new Error('Job identity unavailable');
  provenance.job = process.env.GITHUB_JOB;
  if (sha(process.env.CODEQL_PR_HEAD_SHA)) provenance.prHeadSha = process.env.CODEQL_PR_HEAD_SHA;
  const directory = process.env.CODEQL_SARIF_DIRECTORY;
  const trackedPaths = git('ls-tree', '-r', '-z', '--full-tree', 'HEAD').split('\0').flatMap(entry => {
    const match = /^(?:100644|100755) blob [a-f0-9]{40}\t([\s\S]+)$/.exec(entry);
    return match ? [match[1]] : [];
  });
  const options = { trackedPaths, workspace, provenance };
  const report = readPasswordHashLocations(directory ? resolve(directory, 'javascript.sarif') : '', options);
  const bytes = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('Diagnostic size limit');
  const output = process.env.CODEQL_FLOW_OUTPUT;
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary || !isAbsolute(temporary) || !output ||
      resolve(output) !== resolve(temporary, 'codeql-password-hash-locations.json'))
    throw new Error('Diagnostic output unavailable');
  writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, counts: report.counts ?? null }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error('CodeQL source-location diagnostic unavailable'); process.exitCode = 1; }
}
