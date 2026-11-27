import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectPasswordHashLocations, readPasswordHashLocations } from './codeql-password-hash-locations.mjs';

const ruleId = 'js/insufficient-password-hash';
const privateText = 'PRIVATE-TEST-NEVER-EXPORT';
const options = { workspace: '/TEST-checkout', trackedPaths: ['src/source.ts', 'src/sink.ts', 'src/with space.ts'],
  provenance: { checkoutSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), analysisOutcome: 'success' } };
const location = (uri = 'src/source.ts', line = 8) => ({ physicalLocation: {
  artifactLocation: { uri }, region: { startLine: line, startColumn: 3,
    snippet: { text: privateText } },
}, message: { text: privateText }, properties: { token: privateText } });
function fixture() {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', rules: [{ id: ruleId }] } },
    invocations: [{ executionSuccessful: true }], results: [{ ruleId, ruleIndex: 0,
      message: { text: privateText }, properties: { secret: privateText },
      locations: [location('src/sink.ts', 27)], relatedLocations: [location()],
      codeFlows: [{ threadFlows: [{ locations: [{ location: location() },
        { location: location('src/sink.ts', 27) }] }] }],
    }] }] };
}
const collect = (source, custom = options) => collectPasswordHashLocations(source, custom);

test('retains exact nested source/sink flow coordinates without any private SARIF text', () => {
  const report = collect(fixture());
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.results[0], { runIndex: 0, resultIndex: 0, locations: [
    { kind: 'locations', locationIndex: 0, path: 'src/sink.ts', startLine: 27, startColumn: 3 },
    { kind: 'relatedLocations', locationIndex: 0, path: 'src/source.ts', startLine: 8, startColumn: 3 },
    { kind: 'flow', codeFlowIndex: 0, threadFlowIndex: 0, locationIndex: 0, path: 'src/source.ts', startLine: 8, startColumn: 3 },
    { kind: 'flow', codeFlowIndex: 0, threadFlowIndex: 0, locationIndex: 1, path: 'src/sink.ts', startLine: 27, startColumn: 3 },
  ] });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|snippet|properties|message|\/TEST-checkout/);
});

test('resolves rule, artifact and shared thread-location indices against the exact checkout base', () => {
  const source = fixture(), run = source.runs[0], result = run.results[0];
  delete result.ruleId;
  run.originalUriBaseIds = { SRCROOT: { uri: pathToFileURL(options.workspace + '/').href } };
  run.artifacts = [{ location: { uri: 'src/with%20space.ts', uriBaseId: 'SRCROOT' },
    contents: { text: privateText } }];
  const indexed = { physicalLocation: { artifactLocation: { index: 0, uri: 'src/with space.ts' },
    region: { startLine: 12 } } };
  result.relatedLocations = [indexed];
  run.threadFlowLocations = [{ location: indexed }];
  result.codeFlows[0].threadFlows[0].locations[0] = { index: 0 };
  const report = collect(source);
  assert.equal(report.status, 'complete');
  assert.equal(report.results[0].locations[1].path, 'src/with space.ts');
  assert.equal(report.results[0].locations[2].path, 'src/with space.ts');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|file:/);
});

for (const uri of ['/etc/secret', 'C:/secret', 'C:%5csecret', 'file:///secret', 'https://example.test/key',
  '//other/secret', '../src/source.ts', '%2e%2e/src/source.ts', 'src/%2e%2e/source.ts',
  './src/source.ts', 'src/source.ts?secret', 'src/source.ts%23secret', 'src/%00source.ts',
  'src/%ZZsource.ts', 'src/untracked-secret.ts']) {
  test('unsafe or untracked selected-rule location makes evidence partial: ' + uri, () => {
    const source = fixture(); source.runs[0].results[0].locations[0] = location(uri);
    const report = collect(source);
    assert.equal(report.status, 'partial'); assert.ok(report.counts.omitted > 0);
    assert.equal(report.results[0].locations.some(value => value.kind === 'locations'), false);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|untracked-secret|example\.test|\/etc/);
  });
}

test('ambiguous rule/artifact/base references and invalid coordinates never become complete evidence', () => {
  for (const mutate of [
    run => { run.results[0].ruleIndex = 1; },
    run => { delete run.results[0].ruleId; delete run.results[0].ruleIndex; },
    run => { delete run.results[0].ruleId; run.results[0].ruleIndex = 'PRIVATE'; },
    run => { run.results[0].ruleId = 'unrelated'; },
    run => { run.results[0].locations[0].physicalLocation.artifactLocation = { index: 500 }; },
    run => { run.artifacts = [{ location: { uri: 'src/source.ts' } }];
      run.results[0].locations[0].physicalLocation.artifactLocation = { index: 0, uri: 'src/sink.ts' }; },
    run => { run.results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = 'missing'; },
    run => { run.originalUriBaseIds = { ROOT: { uri: 'file:///PRIVATE-other/' } };
      run.results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = 'ROOT'; },
    run => { run.results[0].locations[0].physicalLocation.region.startLine = 0; },
    run => { run.results[0].locations[0].physicalLocation.region.startColumn = 1.5; },
    run => { run.results[0].locations[0].physicalLocation.region.endLine = 1; },
    run => { run.results[0].locations[0].physicalLocation.region.endColumn = 1; },
    run => { run.results[0].codeFlows = []; },
  ]) {
    const source = fixture(); mutate(source.runs[0]);
    const report = collect(source);
    assert.equal(report.status, 'partial');
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|unrelated/);
  }
});

test('unrelated results are omitted and failed analysis cannot look like a complete empty result', () => {
  const source = fixture(), run = source.runs[0];
  run.results[0].ruleId = 'unrelated'; delete run.results[0].ruleIndex;
  assert.deepEqual(collect(source).results, []);
  assert.equal(collect(source).status, 'complete');
  assert.equal(collect(source, { ...options, provenance: { ...options.provenance, analysisOutcome: 'failure' } }).status, 'partial');
  run.invocations[0].executionSuccessful = false;
  assert.equal(collect(source).status, 'partial');
  run.invocations[0].executionSuccessful = 'false';
  assert.equal(collect(source).status, 'partial');
  run.invocations[0] = { executionSuccessful: true,
    toolExecutionNotifications: [{ level: 'error', message: { text: privateText } }] };
  assert.equal(collect(source).status, 'partial');
  assert.doesNotMatch(JSON.stringify(collect(source)), /PRIVATE/);
});

test('explicit invalid indexed URI/base and malformed optional related locations are partial', () => {
  for (const reference of [{ index: 0, uri: null }, { index: 0, uriBaseId: null },
    { index: 0, uri: 1 }, { index: 0, uriBaseId: [] }]) {
    const source = fixture(), run = source.runs[0];
    run.artifacts = [{ location: { uri: 'src/source.ts' } }];
    run.results[0].locations[0].physicalLocation.artifactLocation = reference;
    const report = collect(source);
    assert.equal(report.status, 'partial');
    assert.equal(report.results[0].locations.some(value => value.kind === 'locations'), false);
  }
  for (const relatedLocations of [null, {}, 'PRIVATE']) {
    const source = fixture(); source.runs[0].results[0].relatedLocations = relatedLocations;
    assert.equal(collect(source).status, 'partial');
    assert.doesNotMatch(JSON.stringify(collect(source)), /PRIVATE/);
  }
  const source = fixture(); delete source.runs[0].results[0].relatedLocations;
  assert.equal(collect(source).status, 'complete');
});

test('invalid shared thread indices still consume the global visited-location budget', () => {
  const source = fixture();
  source.runs[0].results[0].codeFlows[0].threadFlows = Array.from({ length: 2 }, () => ({
    locations: Array.from({ length: 4096 }, () => ({ index: -1 })),
  }));
  const report = collect(source);
  assert.equal(report.status, 'partial');
  assert.equal(report.counts.locations, 4096);
  assert.ok(report.counts.omitted <= 4098, 'rejected references cannot bypass the visitation cap');
});

test('count limits also bound rejected locations and report incomplete selected results', () => {
  const source = fixture(), result = source.runs[0].results[0];
  result.codeFlows[0].threadFlows[0].locations = Array.from({ length: 5000 }, () => ({ location: location('../PRIVATE') }));
  const report = collect(source);
  assert.equal(report.status, 'partial'); assert.equal(report.counts.locations, 4096);
  assert.ok(report.counts.omitted > 0); assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  source.runs[0].results = Array.from({ length: 10_001 }, () => ({ ruleId: 'unrelated' }));
  assert.equal(collect(source).status, 'partial');
  assert.equal(collect(source).counts.results, 10_000);
  assert.equal(collect({ version: '2.1.0', runs: [] }).status, 'unavailable');
});

test('unreadable, truncated and oversized input produce a text-free unavailable report', t => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-codeql-locations-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'javascript.sarif');
  assert.equal(readPasswordHashLocations(path, options).status, 'unavailable');
  writeFileSync(path, '{"PRIVATE-TEST-NEVER-EXPORT":');
  assert.doesNotMatch(JSON.stringify(readPasswordHashLocations(path, options)), /PRIVATE/);
  assert.equal(readPasswordHashLocations(path, options).status, 'unavailable');
  truncateSync(path, 64 * 1024 * 1024 + 1);
  assert.equal(readPasswordHashLocations(path, options).status, 'unavailable');
  writeFileSync(path, JSON.stringify(fixture()));
  assert.equal(readPasswordHashLocations(path, options).status, 'complete');
});

test('CLI binds the real Git checkout, refuses changed source and never overwrites an old output', t => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-codeql-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=TEST');
  writeFileSync(join(directory, 'source.ts'), 'export const value = 1;\n');
  git('add', 'source.ts');
  git('-c', 'user.name=TEST', '-c', 'user.email=TEST@example.invalid', 'commit', '--quiet', '-m', 'TEST source');
  const source = fixture();
  for (const value of source.runs[0].results[0].locations) value.physicalLocation.artifactLocation.uri = 'source.ts';
  source.runs[0].results[0].relatedLocations = [];
  source.runs[0].results[0].codeFlows[0].threadFlows[0].locations = [{ location: location('source.ts') }];
  writeFileSync(join(directory, 'javascript.sarif'), JSON.stringify(source));
  const output = join(directory, 'codeql-password-hash-locations.json');
  const env = { ...process.env, GITHUB_SHA: git('rev-parse', 'HEAD'), GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'analyze', RUNNER_TEMP: directory,
    CODEQL_ANALYSIS_OUTCOME: 'success', CODEQL_SARIF_DIRECTORY: directory, CODEQL_FLOW_OUTPUT: output };
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./codeql-password-hash-locations.mjs', import.meta.url))],
    { cwd: directory, env, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const original = readFileSync(output, 'utf8'), report = JSON.parse(original);
  assert.equal(report.status, 'complete'); assert.equal(report.provenance.checkoutSha, env.GITHUB_SHA);
  assert.equal(report.provenance.treeSha, git('rev-parse', 'HEAD^{tree}'));
  assert.equal(run().status, 1, 'existing output is never adopted as current evidence');
  assert.equal(readFileSync(output, 'utf8'), original);
  rmSync(output); writeFileSync(join(directory, 'source.ts'), 'export const value = 2;\n');
  const changed = run(); assert.equal(changed.status, 1);
  assert.doesNotMatch(changed.stderr, /PRIVATE/);
  assert.throws(() => readFileSync(output));
});
