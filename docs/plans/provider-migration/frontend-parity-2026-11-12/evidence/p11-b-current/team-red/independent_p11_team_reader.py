import collections, datetime, hashlib, json, pathlib, re

ROOT = pathlib.Path('/workspace/scratch/82d3f9ba6b85')
BASE = ROOT / 'ci-72e6ec/team'
TASK = ROOT / 'ci-72e6ec/taskboard'
HEAD = '72e6ec04444969d343d73834c70bc4e261100fc9'
RUN, JOB = 43831885807, 133178913364

def identity(data, path=None):
    result = {'bytes': len(data), 'blob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest(), 'sha256': hashlib.sha256(data).hexdigest()}
    return {'path': str(path.relative_to(ROOT)), **result} if path is not None else result

def ref(path):
    return identity(path.read_bytes(), path)

def read(path):
    return json.loads(path.read_bytes())

def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)
    elif isinstance(value, str) and value.lstrip().startswith(('{', '[')):
        try:
            parsed = json.loads(value)
        except ValueError:
            return
        yield from walk(parsed)

def unique(rows):
    rows = {json.dumps(row, sort_keys=True): row for row in rows}
    assert len(rows) == 1, len(rows)
    return next(iter(rows.values()))

def freeze(name, value):
    path = BASE / name
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    with path.open('xb') as stream:
        stream.write(data)
    assert path.read_bytes() == data
    return ref(path)

checkpoint_path = BASE / 'checkpoint-p11-red.json'
audit_path = BASE / 'p11-team-red-audit.json'
appendix_path = BASE / 'Plan29-p11-team-original-red-appendix.md'
assert ref(checkpoint_path)['blob'] == 'd200e98ea29280e8018e26d6e777a445da2bc6a8'
assert ref(audit_path)['blob'] == '760d51346092215eff54f5be6ed10f2fef035f16'
assert ref(appendix_path)['blob'] == '12d290aa7a22f3e426d7cd1a7692bae9c9ec3427'
checkpoint, audit = read(checkpoint_path), read(audit_path)
assert checkpoint['sourceHead'] == audit['sourceHead'] == HEAD
assert checkpoint['runId'] == audit['runId'] == RUN and checkpoint['jobId'] == audit['jobId'] == JOB
inputs = checkpoint['payloads'] + checkpoint['sameSourceProofReferences']
for row in inputs:
    assert ref(ROOT / row['path']) == row
assert len(checkpoint['payloads']) == 6 and sum(row['bytes'] for row in checkpoint['payloads']) == checkpoint['payloadBytes'] == 418977

prior_proof_path = TASK / 'independent-p11-red-byte-source-proof.json'
prior_review_path = TASK / 'independent-p11-semantic-red-review.json'
assert ref(prior_proof_path)['blob'] == '129018c8b20eecc6887ec6ecef1600132cace7af'
assert ref(prior_review_path)['blob'] == 'fb7f28180bd65d164a3e22990c76a898fb3d1666'
prior, prior_review = read(prior_proof_path), read(prior_review_path)
source_author = read(TASK / 'p11-byte-source-proof.json')
assert prior['sourceHead'] == prior_review['sourceHead'] == source_author['sourceHead'] == HEAD
assert prior['runId'] == RUN and prior['sourceTree'] == 'de80fbfbffb3fe4daabf6cc9be258cc8df534524'
source_map = {row['path']: row for row in prior['fresh648GitObjects']}
assert len(source_map) == 648
assert len(audit['fresh29GitRechecks']) == 29
assert audit['fresh29GitRechecks'] == source_author['sourceLeaves']
for row in audit['fresh29GitRechecks']:
    assert {key: row[key] for key in ('path', 'bytes', 'blob', 'sha256')} == source_map[row['path']]
assert prior['hostGitOnly619Digest'] == source_author['hostGitOnlyCensus']['digest'] == '5c76bf6f2750c0070c59b8bf10db3dd83ea1a8c5c34aca5389c5c575bdc4a008'
assert len(source_author['hostGitOnlyCensus']['rows']) == 619

raw = (BASE / 'job.log').read_bytes()
response = read(BASE / 'job-original-response.json')
assert response['structuredContent']['content'].encode() == raw
assert len(raw) == 95536
raw_lines = raw.decode().splitlines()
lines = [re.sub(r'\x1b\[[0-9;]*m', '', re.sub(r'^(?:\ufeff)?\d{4}-\d\d-\d\dT\S+Z ', '', line)) for line in raw_lines]
summary_index = next(index for index, line in enumerate(lines) if line == 'ℹ tests 123')
cases = []
for index, line in enumerate(lines[:summary_index]):
    match = re.fullmatch(r'([✔✖]) (.+) \(([0-9.]+)ms\)', line)
    if match:
        cases.append({'line': index + 1, 'outcome': 'PASS' if match[1] == '✔' else 'FAIL', 'name': match[2], 'durationMs': float(match[3])})
assert cases == audit['cases'] and len(cases) == 123
assert collections.Counter(row['outcome'] for row in cases) == {'PASS': 120, 'FAIL': 3}
assert [(row['name'], row['outcome']) for row in cases] == [(row['name'], row['outcome']) for row in prior['all123ReporterRows']]
counts = {}
for line in lines[summary_index:summary_index + 8]:
    match = re.fullmatch(r'ℹ (\w+) ([0-9.]+)', line)
    assert match
    counts[match[1]] = float(match[2]) if '.' in match[2] else int(match[2])
assert counts == audit['counts'] == {'tests': 123, 'suites': 0, 'pass': 120, 'fail': 3, 'cancelled': 0, 'skipped': 0, 'todo': 0, 'duration_ms': 10621.178682}
new = [row for row in cases if row['name'].startswith('P11 ')]
old = [row for row in cases if not row['name'].startswith('P11 ')]
assert len(old) == 119 and all(row['outcome'] == 'PASS' for row in old)
assert len(new) == 4 and [row['outcome'] for row in new] == ['FAIL', 'FAIL', 'FAIL', 'PASS']
failures = []
for index, line in enumerate(lines):
    if line == 'test at scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts:1935:4':
        block = lines[index:index + 13]
        assert '  AssertionError [ERR_ASSERTION]: Missing expected rejection.' in block
        assert any('desktop-team-ui-smoke.test.ts:1937:3)' in item for item in block)
        assert "    operator: 'rejects'," in block and '    actual: undefined,' in block
        failures.append({'firstRawLine': index + 1, 'lines': block})
assert len(failures) == 3 and sum('Missing expected rejection.' in line for line in lines) == 3
assert sum('##[error]Process completed with exit code 1.' in line for line in lines) == 1
exit_index = lines.index('##[error]Process completed with exit code 1.')
assert raw_lines[exit_index].startswith('2026-11-16T09:30:37.2594675Z ')
command = audit['literalCommand']
assert command == prior['exactCommand'] and command.split() == audit['argv'] == prior['argv']
assert lines.count(command) == 1 and lines.index(command) + 1 == 712
assert lines[712] == 'node --test test/scripts/installDependenciesWithRetry.test.mjs'
assert lines[706] == 'set -euo pipefail'
assert sum(line.startswith('ℹ tests ') for line in lines) == 1
for row in audit['originalSetupBuildFacts']:
    assert lines[row['line'] - 1] == row['text']
for token in ['node: v24.21.0', 'Done in 31.7s using pnpm v11.22.0', 'Lockfile is up to date, resolution step is skipped', '✔ Rebuild Complete', '  HOST_EMULATED_LANE: team', '  HOST_EMULATED_PLATFORM: linux-x64', '$ pnpm --filter @agent-teams/task-change-ledger build', '$ node ./scripts/build.mjs', '$ tsup', 'ESM ⚡️ Build success in 441ms']:
    assert token in lines, token
assert lines.count('$ node node_modules/@typescript/native/bin/tsc -p tsconfig.json') == 2
assert any('Failed to create bin at ' in line and 'legacy-agent-host/dist/cli.js' in line for line in lines)
assert any('ExperimentalWarning: stripTypeScriptTypes is an experimental feature' in line for line in lines)

job = unique([value for value in walk(read(ROOT / audit['jobAPI']['path'])) if value.get('id') == JOB and 'steps' in value])
assert job == audit['job'] and job['run_id'] == RUN and job['status'] == 'completed' and job['conclusion'] == 'failure'
assert job['name'] == 'Offline Host Desktop (linux-x64, team)'
steps = {step['number']: step for step in job['steps']}
assert all(steps[number]['conclusion'] == 'success' for number in range(1, 8))
assert steps[8]['conclusion'] == 'failure' and all(steps[number]['conclusion'] == 'skipped' for number in range(9, 31))
assert steps[31]['conclusion'] == 'success'
run = unique([value for value in walk(read(ROOT / 'external-primary-0833/initial-api-and-fetch.json')) if value.get('id') == RUN and value.get('head_sha') == HEAD and 'event' in value])
assert run == prior['originalRun'] and run['run_attempt'] == 1 and run['event'] == 'pull_request'
artifacts = {value['id']: value for value in walk(read(ROOT / audit['artifactAPI']['path'])) if 'size_in_bytes' in value and 'workflow_run' in value}
assert len(artifacts) == 4 and all('frontend' in value['name'] for value in artifacts.values())
assert all(value['workflow_run']['head_sha'] == HEAD for value in artifacts.values())
assert not any(value['name'].endswith('-team') for value in artifacts.values())
assert any('No files were found with the provided path:' in line for line in lines)
for row in inputs:
    assert ref(ROOT / row['path']) == row
assert ref(checkpoint_path)['blob'] == 'd200e98ea29280e8018e26d6e777a445da2bc6a8'

proof = {
    'kind': 'INDEPENDENT_E3_TEAM_P11_RED_ORIGINAL_BYTE_AND_SOURCE_JOIN', 'reviewer': '/root/native_failures',
    'createdAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceHead': HEAD,
    'sourceTree': prior['sourceTree'], 'runId': RUN, 'jobId': JOB, 'matrixLane': 'team',
    'allSixPayloads': checkpoint['payloads'], 'sameSourceReferences': checkpoint['sameSourceProofReferences'],
    'sameHeadIndependentSourceProof': ref(prior_proof_path), 'sameHeadIndependentTaskboardReview': ref(prior_review_path),
    'mcpRawUtf8Exact': True, 'rawLineCount': len(raw_lines), 'originalJob': job,
    'runIdentity': {key: run[key] for key in ('id', 'head_sha', 'event', 'run_attempt', 'path', 'created_at')},
    'all123OriginalRows': cases, 'counts': counts, 'threeFailureBlocks': failures,
    'full123NameOutcomeOrderEqualTaskboard': True, 'all119OldPass': True, 'fourNewRows': new,
    'literalCommand': command, 'argv': audit['argv'], 'commandRawLine': 712, 'summaryRawLine': summary_index + 1,
    'exitRawLine': exit_index + 1, 'originalExitTimestamp': raw_lines[exit_index].split(' ', 1)[0],
    'source29ExactJoinToAlreadyIndependentlyReadImmutable72e': audit['fresh29GitRechecks'],
    'sourceOnly619HostDigest': prior['hostGitOnly619Digest'],
    'originalSetupBuildFacts': audit['originalSetupBuildFacts'],
    'officialFourFrontendArtifactsOnly': list(artifacts.values()),
    'allOriginalInputsPostflightUnchanged': True,
    'noProjectExecutionNetworkRefetchSourceRefCiActions': True,
}
proof_ref = freeze('independent-p11-team-red-byte-source-proof.json', proof)
report = {
    'kind': 'INDEPENDENT_E3_TEAM_ORIGINAL_P11_SEMANTIC_RED_SUPPLEMENT_REVIEW',
    'reviewer': '/root/native_failures', 'reviewedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'verdict': 'APPROVE exact original Team whole-eight semantic RED and author packet; no correction.',
    'sourceHead': HEAD, 'sourceTree': prior['sourceTree'], 'runId': RUN, 'runAttempt': 1,
    'event': 'pull_request', 'jobId': JOB, 'matrixLane': 'team',
    'authorCheckpoint': ref(checkpoint_path), 'authorAudit': ref(audit_path), 'authorAppendix': ref(appendix_path),
    'independentProof': proof_ref, 'sameHeadSourceAndSemanticsBasis': ref(prior_review_path),
    'payloadCount': 6, 'payloadBytes': 418977, 'rawOriginal': ref(BASE / 'job.log'),
    'fullMcpResponse': ref(BASE / 'job-original-response.json'), 'exactMcpRawByteEquality': True,
    'actualCounts': counts, 'all123NamesOutcomesOrderEqualIndependentTaskboard': True,
    'all119OldCasesPass': True, 'newFourRows': new,
    'actualFailure': {
        'registrationLine': 1935, 'assertRejectsLine': 1937, 'error': 'Missing expected rejection',
        'count': 3, 'operator': 'rejects', 'actualValueReported': 'undefined',
        'actualExtractedOriginalPollAcceptedLateTrue': True,
        'laterPerCaseReadTraceDelayAssertionsLine1938Executed': False,
        'positiveControlActualPass': True,
        'scope': 'Finite actual source-closure observations; no real90-second Desktop run or live membership journey.',
    },
    'sourceBinding': {
        'test': source_map['scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts'],
        'driver': source_map['scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts'],
        'literalWholeEight': command, 'all29AuthorRechecksEqualIndependent648ObjectProof': True,
        'sameHeadSourceProofReusedWithoutRepeatingGitCalls': ref(prior_proof_path),
        'host619Digest': prior['hostGitOnly619Digest'],
        'hostCensusScope': 'Immutable Git source only; no archived dist/product hash or complete dependency census.',
    },
    'originalSetupBuild': {
        'node': '24.21.0', 'pnpm': '11.22.0', 'electron': '44.10.1',
        'shell': 'bash --noprofile --norc -e -o pipefail; set -euo pipefail',
        'sourceCheckoutAndTuple': 'Step5 SUCCESS, exact72e/linux-x64/team in raw.',
        'frozenInstall': 'Step7 SUCCESS; pinned existing frozen-lockfile route source-bound by same-head independent proof.',
        'priorBuilds': 'Original Linux exec builder, ledger/Host TypeScript builds, controller build and MCP tsup reached and returned before the full8 reporter under set-e.',
        'warningsRetained': 'Pre-build missing Host dist CLI bin warning, original installation/deprecation warnings, experimental TypeScript stripping warning remain in full raw.',
        'fullBuildOutputAndDependencyInventory': False,
    },
    'downstream': {
        'installerSeven': 'Next printed command in same set-e block; unexecuted after helper exit1.',
        'team179AndStderr24': 'matrix.lane=team selects step9 here, but prerequisite step8 failed; SKIPPED, no result.',
        'workspaceDedicatedBackendTypesFast93TypedLint': 'matrix.lane=team selects step10 here, but it is SKIPPED; no result.',
        'differenceFromTaskboard': 'Taskboard additionally excludes both steps through the team-only matrix guard; no causal conflation.',
        'inputCaptureAndTeamUi': 'Steps11–30 SKIPPED; no Team UI action, receipt, PNG or physical cleanup witness.',
        'artifact': 'Step31 upload SUCCESS with no matching files; retained official listing has only four frontend artifacts.',
    },
    'limits': [
        'Separate original Team matrix job, not a Taskboard rerun or local experiment.',
        'All actual results belong to source72e; no bfc geometry/copy or later Models qualification transfer.',
        'The actual3REDs satisfy only the intended original PhaseA evidence boundary. PhaseB/C remains unselected by this review and requires fresh prospective R1/R2.',
        'No new source, query, API refetch, project/provider/native execution, CI mutation or ref write was performed.',
    ],
    'allOriginalInputsPostflightUnchanged': True,
}
print(json.dumps(freeze('independent-p11-team-red-review.json', report), indent=2))
print(json.dumps(proof_ref, indent=2))
