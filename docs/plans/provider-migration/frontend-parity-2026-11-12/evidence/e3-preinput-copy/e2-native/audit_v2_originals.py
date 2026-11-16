"""Read-only audit of already retained original E2 V2 jobs; never executes project code."""
import collections
import datetime
import hashlib
import json
import pathlib
import re
import stat
import subprocess
import zipfile

ROOT = pathlib.Path('/workspace/scratch/82d3f9ba6b85')
BASE = ROOT / 'ci-57885c/native'
REPO = ROOT / 'agent-teams-e2e'
HEAD = '57885c055a18b27c180c304762643eac632513ad'
E1 = 'e1d14b9cd0fa1d7896b58e513f9040639e9e4940'
RUN = 43823212364
JOBS = BASE / 'owned-v2-jobs-response-0757.json'
ARTIFACTS = BASE / 'official-v2-artifacts-0746.json'
ANSI = re.compile(r'\x1b\[[0-9;]*m')
STAMP = re.compile(r'^\ufeff?\d{4}-\d\d-\d\dT\S+Z ')


def identity(data, path=None):
    out = {'bytes': len(data), 'blob': hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest(), 'sha256': hashlib.sha256(data).hexdigest()}
    if path is not None:
        out = {'path': str(path.relative_to(ROOT) if isinstance(path, pathlib.Path) else path), **out}
    return out


def ref(path):
    return identity(path.read_bytes(), path)


def read_json(path):
    return json.loads(path.read_bytes())


def git_bytes(path, revision=HEAD):
    return subprocess.check_output(['git', 'show', revision+':'+path], cwd=REPO)


def source(path):
    data = git_bytes(path)
    previous = git_bytes(path, E1)
    return {**identity(data, path), 'lines': data.count(b'\n'), 'sameBytesAsE1': data == previous}


def normalized_lines(data):
    return [ANSI.sub('', STAMP.sub('', line)) for line in data.decode('utf-8').lstrip('\ufeff').splitlines()]


def log_facts(data):
    lines = normalized_lines(data)
    commands = [{'line': i+1, 'text': l.removeprefix('##[group]Run ')} for i, l in enumerate(lines) if l.startswith('##[group]Run ')]
    blocks = []
    for i, line in enumerate(lines):
        m = re.fullmatch(r'ℹ tests (\d+)', line)
        if not m:
            continue
        block = {'line': i+1, 'tests': int(m[1])}
        for l in lines[i+1:i+10]:
            m2 = re.fullmatch(r'ℹ (suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)', l)
            if m2:
                block[m2[1]] = float(m2[2]) if '.' in m2[2] else int(m2[2])
        assert block['tests'] == sum(block.get(k, 0) for k in ['pass', 'fail', 'cancelled', 'skipped', 'todo'])
        blocks.append(block)
    checkout = [{'line': i+1, 'text': l} for i, l in enumerate(lines) if HEAD in l or 'HEAD is now at 57885c0' in l or 'Node.js v24.21.0' in l]
    assert any('HEAD is now at 57885c0' in x['text'] for x in checkout)
    assert any(HEAD in x['text'] for x in checkout)
    return {'commands': commands, 'reporterBlocks': blocks, 'sourceIdentityLines': checkout}, lines


def audit_originals(directory, job_id, artifact_id):
    folder = BASE / directory
    log = folder / f'job-{job_id}.log'
    response = folder / f'original-job-{job_id}-response.json'
    raw = log.read_bytes()
    assert read_json(response)['structuredContent']['content'].encode('utf-8') == raw
    job = next(j for j in read_json(JOBS)['structuredContent']['jobs'] if j['id'] == job_id)
    assert job['run_id'] == RUN and job['status'] == 'completed'
    artifact = next(a for a in read_json(ARTIFACTS)['structuredContent']['artifacts'] if a['id'] == artifact_id)
    assert artifact['workflow_run']['head_sha'] == HEAD and artifact['workflow_run']['id'] == RUN
    archive = folder / f'artifact-{artifact_id}.zip'
    archive_ref = ref(archive)
    assert archive_ref['bytes'] == artifact['size_in_bytes'] and 'sha256:'+archive_ref['sha256'] == artifact['digest']
    retained = read_json(folder / 'archive-retention.json')
    rows = []
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        assert len(z.namelist()) == len(set(z.namelist())) == 4
        for item in z.infolist():
            path = pathlib.PurePosixPath(item.filename)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in item.filename
            assert not stat.S_ISLNK(item.external_attr >> 16)
            data = z.read(item)
            extracted = folder / 'extracted' / item.filename
            assert extracted.read_bytes() == data
            previous = next(r for r in retained['members'] if r.get('path', r.get('member')) == item.filename)
            row = identity(data, item.filename)
            assert row['sha256'] == previous['sha256'] and row['bytes'] == previous['bytes']
            rows.append({**row, 'crc32': f'{item.CRC:08x}', 'extracted': str(extracted.relative_to(ROOT)), 'exactExtractedBytes': True})
    facts, lines = log_facts(raw)
    return folder, {
        'job': job, 'originalJobsResponse': ref(JOBS), 'officialArtifactsResponse': ref(ARTIFACTS), 'officialArtifact': artifact,
        'fullLog': ref(log), 'originalResponse': ref(response), 'entireUtf8ContentEquals': True,
        'archive': archive_ref, 'archiveRetention': ref(folder/'archive-retention.json'),
        'archiveByteReview': {'safeUniqueNonsymlinkNames': True, 'allCRC': True, 'members': rows}, **facts
    }, lines


def cpu_arithmetic(cpu):
    assert cpu['status'] == 'available' and cpu['epoch'] == 1 and cpu['rawDiscarded'] is True
    assert cpu['scope'] == 'original-source-host-including-cleanup'
    categories = cpu['categories']
    totals = {'samples': sum(r['exclusiveSamples'] for r in categories), 'sampledUs': sum(r['exclusiveSampledUs'] for r in categories)}
    assert totals == {'samples': cpu['sampleCount'], 'sampledUs': cpu['sampledUs']}
    assert cpu['profileDurationUs'] == cpu['sampledUs'] + cpu['unsampledUs']
    writer = next(r for r in categories if r['category'] == 'team-writer-authority')
    namespace = next(r for r in cpu['teamWriterDetails'] if r['family'] == 'namespace-fence')
    for rows, parent in [(cpu['teamWriterDetails'], writer), (cpu['namespaceFenceDetails'], namespace), (cpu['teamWriterCallers']['rows'], writer)]:
        for key in ['exclusiveSamples', 'exclusiveSampledUs']:
            assert sum(r[key] for r in rows) == parent[key]
    for key, parent_key in [('namespaceSamples', 'exclusiveSamples'), ('namespaceSampledUs', 'exclusiveSampledUs')]:
        assert sum(r[key] for r in cpu['teamWriterCallers']['rows']) == namespace[parent_key]
    return {'exclusiveCategoryTotals': totals, 'profileDurationEqualsSampledPlusUnsampled': True, 'writerDetailsAndCallerTotalsEqualWriterCategory': True, 'namespaceDetailsAndCallerTotalsEqualNamespaceFamily': True,
            'limits': 'Original Host epoch 1 including cleanup only. Inclusive categories overlap; sampled time is not a per-query elapsed measure. Raw CPU profile discarded; no Bun, later Host, native-wide or causal latency attribution.'}


HOST = read_json(BASE/'host-source-E2-git-audit.json')
assert HOST['sourceHead'] == HEAD and HOST['files'] == 619
OLD = read_json(ROOT/'native-audit-E1e1d14b/v2-windows-x64-qualification-audit.json')
SOURCE_PATHS = [r['path'] for r in OLD['interpretationSourceLeaves']]
SOURCE_PATHS += ['packages/legacy-agent-host/tests/registered-process-executable.native.ts', 'packages/legacy-agent-host/tests/fixtures/posix-exec-native.c', 'scripts/legacy-agent-host/desktop-opencode-v2-fixture.test.ts']
SOURCE_PATHS = list(dict.fromkeys(SOURCE_PATHS))
SOURCES = [source(path) for path in SOURCE_PATHS]
assert all(s['sameBytesAsE1'] for s in SOURCES)
PAIR_PATHS = ['vendor/provider-migration/host-logs-thinking-9423f600/agent-teams-provider-implementations-0.0.0.tgz', 'vendor/provider-migration/host-logs-thinking-9423f600/agent-teams-provider-session-contracts-0.0.0.tgz']
PAIR = [source(path) for path in PAIR_PATHS]
PROVIDER = PAIR[0]['sha256']


def embedded(folder, mode, platform, input_data):
    path = folder/'extracted'/('opencode-v2-embedded-host-auto.json' if mode == 'auto' else 'opencode-v2-embedded-host.json')
    d = read_json(path)
    assert d['sourceHead'] == HEAD and d['platform'] == platform and d['nodeVersion'] == 'v24.21.0'
    assert d['status'] == 'PASS' and d['approvalMode'] == mode and d['cleanup'] is True and d['failureCode'] is None
    assert d['vendorAuthQualified'] is False and d['desktopQualified'] is False and d['releaseQualified'] is False
    assert d['hosts'] == [{'exitCode': 0, 'signalCode': None, 'stdoutValid': True}]*2
    assert d['modelRequests'] == 11 and d['modelOrigin'] == 'localhost-scripted' and d['modelFailures'] == []
    assert len(d['steps']) == 6 and len(set(d['steps'])) == 6 and d['cancelled'] is False
    assert d['coordination'] == {'status': 'unqualified', 'cleanup': None}
    assert d['digests']['hostSource'] == HOST['CRLF' if platform.startswith('win32') else 'LF']
    assert d['digests']['provider'] == PROVIDER and d['digests']['bun'] == input_data['bun']['sha256'] and d['digests']['manifest'] == input_data['manifestSha256']
    assert d['inputObservation']['last']['inputs'] == [{'phase': 'terminal', 'terminal': 'succeeded'}]*2
    assert d['inputObservation']['last']['interactions'] == ([{'kind': 'permission', 'phase': 'resolved'}]*2 if mode == 'manual' else [])
    assert d['launchObservation']['afterOpen']['nativeReady'] is True and d['launchObservation']['afterOpen']['capturedTimeoutMs'] == 120000
    trace = d['passiveNativeDiagnostics']
    assert len(trace) == 254 and trace[-1]['event'] == 'trace-limit' and {r['epoch'] for r in trace} == {1}
    facts = {k:v for k,v in d.items() if k != 'passiveNativeDiagnostics'}
    return {'receipt': ref(path), 'selectedFacts': facts, 'CPUArithmeticJoins': cpu_arithmetic(d['originalHostCpu']),
            'passiveTrace': {'rows': len(trace), 'eventCounts': dict(collections.Counter(r['event'] for r in trace)), 'epochs': [1], 'last': trace[-1], 'complete': False, 'limit': 'Bounded passive trace ends before the complete scenario; does not establish later original exit or epoch-2 cleanup. Those rely on distinct original final receipts/assertions.'},
            'allReceiptBytesRecoverableFromOfficialZip': True}


CONFIGS = [('windows-x64',133150849292,14206031385,'win32-x64'), ('v2-windows-arm64',133150849362,14206282008,'win32-arm64'), ('darwin-x64',133150849285,14206056428,'darwin-x64'), ('v2-darwin-arm64',133150849484,14206376458,'darwin-arm64')]
for directory, job_id, artifact_id, platform in CONFIGS:
    completed = BASE/directory/'original-v2-and-p09-audit.json'
    if completed.exists():
        previous = read_json(completed)
        assert previous['sourceHead'] == HEAD and previous['jobId'] == job_id
        print(json.dumps({'preservedPreviouslyFrozen':ref(completed)},ensure_ascii=False))
        continue
    folder, original, lines = audit_originals(directory, job_id, artifact_id)
    inputs_path = folder/'extracted/opencode-v2-embedded-inputs.json'
    inputs = read_json(inputs_path)
    assert inputs['sourceHead'] == HEAD and inputs['platform'] == platform and inputs['nodeVersion'] == 'v24.21.0'
    assert inputs['status'] == 'READY' and inputs['productQualified'] is False
    assert inputs['bun']['version'] == ('1.4.3' if platform.startswith('win32') else '1.4.4')
    modes = ['manual', 'auto'] if platform.startswith('win32') else ['manual']
    flows = [embedded(folder, m, platform, inputs) for m in modes]
    custody_path = folder/'extracted'/('opencode-v2-windows-custody.json' if platform.startswith('win32') else 'opencode-v2-darwin-custody.json')
    custody = read_json(custody_path)
    assert custody['sourceHead'] == HEAD and custody['status'] == 'PASS' and custody['productQualified'] is False
    assert custody['hostBuild']['hostSourceDigest'] == HOST['CRLF' if platform.startswith('win32') else 'LF']
    assert custody['hostBuild']['providerDigest'] == PROVIDER
    if platform.startswith('win32'):
        assert custody['cleanup'] is True and custody['captureBeforeInput'] is True and custody['descendantSurvivedRootExit'] is True
        assert custody['originalJobCleanup'] == 'confirmed' and custody['neighborJobCleanup'] == 'confirmed' and custody['neighborSurvivedTargetStop'] is True
        assert original['job']['conclusion'] == 'success'
        expected = [(58,57,0,1),(1,1,0,0),(1,1,0,0),(1,1,0,0)]
    else:
        assert custody['cleanup'] == 'confirmed' and custody['replacementRefused'] is True and custody['siblingSurvivedTargetStop'] is True
        assert original['job']['conclusion'] == 'failure'
        expected = [(58,57,0,1),(2,1,0,1),(1,1,0,0),(1,1,0,0),(1,0,1,0)]
    assert [(x['tests'],x['pass'],x['fail'],x['skipped']) for x in original['reporterBlocks']] == expected
    out = {'kind':'AUTHOR_READ_ONLY_E2_ORIGINAL_V2_AUDIT', 'auditedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceHead':HEAD, 'runId':RUN, 'jobId':job_id,
           **original, 'sourceLeaves':SOURCES, 'selectedProviderPairGitBytes':PAIR,
           'hostSourceAudit':ref(BASE/'host-source-E2-git-audit.json'), 'freshHostSourceFiles':619,
           'inputs':{'receipt':ref(inputs_path),'content':inputs}, 'custody':{'receipt':ref(custody_path),'content':custody}, 'manualAndAuto':flows,
           'totals':{k:sum(x[k] for x in original['reporterBlocks']) for k in ['tests','pass','fail','skipped','cancelled']},
           'scopeLimits':['Source-bound original TEST leaf results only. No Team177/stderr24, whole renderer/types/lint, Process or packaged P08 qualification.', 'Host source digest independently joins all619 Git source files with actual runner EOL form. Host dist/runtime/Bun/native image hashes remain captured original build/input evidence, not a local independent rebuild.', 'No actual vendor credential/model action or installed product/release qualification; local-scripted model only.', 'Manual and auto are separate original invocations; passive trace ends at254, no full trace/custody or CPU performance causal inference.', 'All Git source comparisons are exact578; historical source equality is not result transfer. No project commands or original actions repeated by auditor.']}
    if not platform.startswith('win32'):
        p = folder/'extracted/opencode-v2-posix-exec.json'
        d = read_json(p)
        assert d['sourceHead'] == HEAD and d['nodeVersion'] == 'v24.21.0' and d['status'] == 'INCOMPLETE' and d['cleanup'] is True
        assert d['sourceSha256'] == next(s['sha256'] for s in SOURCES if s['path'].endswith('posix-exec-native.c'))
        assert all(d[k] is False for k in ['productQualified','installedRuntimeQualified','customExecutableQualified','scriptQualified','nativeFixtureQualified'])
        obs = {r['label']:r for r in d['observations']}
        assert len(d['observations']) == len(obs) == 10
        assert all(r['cleanup'] is True and r['originalReaped'] is True and r['originalGroupAbsent'] is True for r in obs.values())
        for label in ['adhoc-test-only:after-check','adhoc-test-only:writer-open']:
            row = obs[label]
            assert row['mutationAfterCheckErrno'] == 0 and row['imageMatched'] is True and row['resumed'] is True
            assert row['result'] == 'INCOMPLETE' and row['markerLines'] == ['LIB','BIN:A','MAIN:A']
        script = obs['script:script-negative']
        assert script['result'] == 'COUNTEREXAMPLE' and script['resumed'] is True and script['markerLines'] == ['SCRIPT:B'] and script['imageMatched'] is False
        line_number = 476 if platform.endswith('x64') else 496
        assert any(f'registered-process-executable.native.ts:{line_number}:' in l for l in lines)
        if platform.endswith('x64'):
            first = obs['compiler-default:baseline']
            assert first['result'] == 'INCOMPLETE' and first['stage'] == 'kernel-image-validity' and first['errno'] == 13 and first['codeSigningError'] == -67062 and first['resumed'] is False and first['markerLines'] == []
        else:
            assert obs['compiler-default:baseline']['result'] == 'PASS'
            first = obs['adhoc-test-only:after-check']
        out['P09'] = {'receipt':ref(p),'content':d,'actualFirstAssertionLine':line_number,'firstRetainedAssertionOperand':first,
            'limits':['P09 remains failed/unqualified despite separate preceding V2 and custody PASS.', 'Accepted original write and original A markers establish the retained original oracle failure; no B payload execution inference for after-check or writer-open.', 'All10 observations and their original cleanup are retained before first failure is rethrown; later diagnostics are not a qualified replacement acceptance.', 'Script:B is the original explicit negative counterexample. No signing/format/rights/fixture-law amendment or universal impossibility conclusion.']}
    output = folder/'original-v2-and-p09-audit.json'
    data = (json.dumps(out,ensure_ascii=False,indent=2)+'\n').encode()
    with output.open('xb') as f:
        f.write(data)
    print(json.dumps(identity(data,output),ensure_ascii=False))
