"""Read-only evidence/Git/ZIP review. Does not load or run project source."""
from pathlib import Path, PurePosixPath
import datetime, hashlib, io, json, re, stat, subprocess, zipfile
from PIL import Image

BASE = Path('/workspace/scratch/82d3f9ba6b85')
D = BASE / 'ci-72e6ec/creation-macos'
REPO = BASE / 'agent-teams-e2e'
HEAD = '72e6ec04444969d343d73834c70bc4e261100fc9'
OLD = '57885c055a18b27c180c304762643eac632513ad'

def identity(b):
    return dict(bytes=len(b), gitBlob=hashlib.sha1(b'blob ' + str(len(b)).encode() + b'\0' + b).hexdigest(), sha256=hashlib.sha256(b).hexdigest())

def file_identity(p):
    return dict(path=str(p.relative_to(BASE)), **identity(p.read_bytes()))

def check_identity(b, expected):
    actual = identity(b)
    for key in ('bytes', 'gitBlob', 'sha256'):
        assert actual[key] == expected[key], (key, actual, expected)
    return actual

def load(p):
    return json.loads(p.read_bytes())

def walk(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)

def git(path, ref=HEAD):
    return subprocess.check_output(['git', '-C', str(REPO), 'show', ref + ':' + path])

cp = load(D / 'checkpoint.json')
audit = load(D / 'audit.json')
source = load(D / 'source-proof.json')
archive = load(D / 'archive-retention.json')
assert cp['sourceHead'] == audit['sourceHead'] == source['sourceHead'] == HEAD
assert cp['runId'] == audit['runId'] == 43831885626
assert cp['jobId'] == audit['jobId'] == 133178909700
payloads = []
assert len({r['path'] for r in cp['payloads']}) == len(cp['payloads']) == 10
for row in cp['payloads']:
    p = BASE / row['path']
    payloads.append(dict(path=row['path'], **check_identity(p.read_bytes(), row)))
assert sum(p['bytes'] for p in payloads) == cp['totalBytes'] == 1680069
assert cp['payloadCount'] == 10

raw = (D / 'job.log').read_bytes()
response = load(D / 'job-original-response.json')
assert response['structuredContent']['content'].encode('utf-8') == raw
text = raw.decode('utf-8')
raw_lines = text.splitlines()
strip = lambda line: re.sub(r'^\ufeff?\d{4}-\d\d-\d\dT\S+Z ', '', line)
lines = [strip(line) for line in raw_lines]
assert len(lines) == 788
assert lines[37].strip() == 'ref: ' + HEAD
assert lines[221] == HEAD
assert 'node: v26.12.1' in lines[298]
assert 'Done in 57.7s using pnpm v11.22.0' == lines[601]

terminal_response = load(BASE / 'ci-72e6ec/owned-jobs-0843.json')
jobs = [x for x in walk(terminal_response) if x.get('id') == cp['jobId'] and 'steps' in x]
assert len(jobs) == 1
job = jobs[0]
assert job == audit['terminalJob']
assert job['status'] == 'completed' and job['conclusion'] == 'failure' and job['run_id'] == cp['runId']
failed_steps = [x for x in job['steps'] if x['conclusion'] == 'failure']
assert len(failed_steps) == 1 and failed_steps[0]['number'] == 12
assert all(x['conclusion'] == 'success' for x in job['steps'] if x['number'] in [7,8,9,10,11])
initial = load(BASE / 'ci-72e6ec/initial-owned-api-0838.json')
assert initial['sourceHead'] == HEAD
initial_jobs = [x for x in walk(initial) if x.get('id') == cp['jobId'] and 'steps' in x]
assert len(initial_jobs) == 1 and initial_jobs[0]['run_id'] == cp['runId']
official_response = load(BASE / 'ci-72e6ec/creation-artifacts-0843.json')
official = [x for x in official_response['structuredContent']['artifacts'] if x['id'] == 14209557495]
assert len(official) == 1
official = official[0]
assert official == audit['officialArtifact'] == archive['artifact']
assert official['workflow_run']['id'] == cp['runId'] and official['workflow_run']['head_sha'] == HEAD
zip_bytes = (D / 'artifact-14209557495.zip').read_bytes()
assert official['size_in_bytes'] == len(zip_bytes) == 1446976
assert official['digest'] == 'sha256:' + hashlib.sha256(zip_bytes).hexdigest()
assert official['name'] == 'teams-create-page-macos-latest-' + HEAD

members = []
expected = {x['path']: x for x in archive['members']}
with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
    assert z.testzip() is None
    names = z.namelist()
    assert len(names) == len(set(names)) == 24
    assert set(names) == set(expected)
    for item in z.infolist():
        p = PurePosixPath(item.filename)
        assert not p.is_absolute() and '..' not in p.parts and '\\' not in item.filename
        assert not item.is_dir() and stat.S_IFMT(item.external_attr >> 16) != stat.S_IFLNK
        assert p.suffix == '.png'
        b = z.read(item)
        assert (D / 'extracted' / p).read_bytes() == b
        got = check_identity(b, expected[item.filename])
        assert expected[item.filename]['crc'] == item.CRC
        with Image.open(io.BytesIO(b)) as im:
            dimensions = list(im.size)
            assert im.format == 'PNG'
            im.verify()
        members.append(dict(path=item.filename, **got, crc32=f'{item.CRC:08x}', dimensions=dimensions))
assert cp['zipMembers'] == cp['pngBytesChecked'] == len(members)
assert len(audit['archiveMembers']) == 24
for row in audit['archiveMembers']:
    got = next(x for x in members if x['path'] == row.get('path', row.get('name')))
    for k in ('bytes','gitBlob','sha256'):
        assert got[k] == row[k]

fresh = []
bodies = {}
tree = subprocess.check_output(['git','-C',str(REPO),'rev-parse',HEAD+'^{tree}']).decode().strip()
assert tree == source['sourceTree'] == audit['sourceTree'] == 'de80fbfbffb3fe4daabf6cc9be258cc8df534524'
assert len(source['files']) == 8
for row in source['files']:
    b = git(row['path']); bodies[row['path']] = b
    got = check_identity(b, row)
    assert b == git(row['path'], OLD)
    fresh.append(dict(path=row['path'], **got, byteIdenticalTo578=True))
bindings = []
for row in source['bindings']:
    selected = ''.join(bodies[row['path']].decode().splitlines(keepends=True)[row['firstLine']-1:row['lastLine']])
    assert selected == row['text']
    bindings.append(dict(row, freshGitExact=True))
assert len(bindings) == 12

workflow = bodies['.github/workflows/teams-create-page-desktop-e2e.yml'].decode()
helper_argv = 'node --test scripts/e2e/teams-create-page-owned-processes.test.mjs'
assert helper_argv in workflow and helper_argv in lines[635] and helper_argv in lines[636]
assert 'desktop-team-ui-smoke.test.ts' not in workflow and 'team-contracts' not in workflow
counts = {k: re.findall(r'^ℹ '+re.escape(k)+r' (\S+)$', '\n'.join(lines), re.M) for k in ['tests','pass','fail','cancelled','skipped','duration_ms']}
assert counts == audit['originalPrerequisite']['counts']
assert counts == {'tests':['3'],'pass':['3'],'fail':['0'],'cancelled':['0'],'skipped':['0'],'duration_ms':['81.606459']}
helper_test = bodies['scripts/e2e/teams-create-page-owned-processes.test.mjs'].decode()
test_names = re.findall(r"^test\('([^']+)'", helper_test, re.M)
assert len(test_names) == 3
for name in test_names:
    assert sum('✔ '+name+' (' in line for line in lines) == 1
markers = [dict(line=i+1,timestamp=raw_lines[i].split(' ',1)[0],step=line.removeprefix('STEP: ')) for i,line in enumerate(lines) if line.startswith('STEP: ')]
assert len(markers) == 23 and markers == audit['originalActionMarkers']
assert markers[-1] == audit['lastStep']
old_ref = source['comparison']['passedMacLog']
old_raw = (BASE / old_ref['path']).read_bytes()
check_identity(old_raw,old_ref)
old_markers = [strip(l).removeprefix('STEP: ') for l in old_raw.decode().splitlines() if strip(l).startswith('STEP: ')]
assert len(old_markers) == 32 and [r['step'] for r in markers] == old_markers[:23]
assert lines[694] == audit['firstFailure']['message']
assert raw_lines[694:698] == audit['firstFailure']['stackRows']
assert lines[694] == 'Error: Timed out waiting for saved prompt acknowledgement visible before Save'
dump = json.loads('\n'.join(lines[688:694]))
assert dump == audit['failureRendererDump']
assert set(dump) == {'label','dialog','creationPageName','bodyText'}
assert len(dump['bodyText']) == 800 and dump['dialog'] is True and dump['creationPageName'] is None
assert 'org-team-e2e-8e8d57e5' in dump['bodyText']
assert not any(name.endswith('.json') for name in names)
assert not any('"success": true' in line for line in lines)
assert 'AggregateError: Create Page E2E and cleanup both failed' not in text
assert 'Fixture cleanup failed:' not in text
assert audit['resultJsonArchived'] is False and audit['resultJsonPrinted'] is False

driver = bodies['scripts/e2e/teams-create-page-desktop.mjs'].decode()
assert '}, 30_000);' in driver
assert "'saved prompt acknowledgement visible before Save', 45_000);" in driver
assert 'while (Date.now() < deadline)' in driver and 'setTimeout(resolve, 80)' in driver
assert "if (failure && cleanupFailure) {" in driver
assert "if (failure) throw failure;" in driver
assert "process.kill(-appProcessGroupId, 'SIGKILL')" in driver
assert 'waitForProcessGroupExit(appProcessGroupId, 4_000)' in driver
combobox = bodies['src/renderer/components/ui/combobox.tsx'].decode()
assert 'onValueChange(option.value);' in combobox
hook = bodies['src/renderer/components/team/schedule/useSavedPromptReview.ts'].decode()
assert 'getSavedRequest(teamName)' in hook and 'setSelectedTeamName' not in hook
assert "if (!prompt) {" in hook and 'cancelled = true' in hook

viewed = []
for original in audit['visualReview']['actuallyViewed']:
    actual = next(x for x in members if x['path'] == original['path'])
    for key in ('bytes','gitBlob','sha256','crc32','dimensions'):
        assert actual[key] == original[key]
    viewed.append(dict(actual, independentlyActuallyViewed=True, method='Original image opened singly using view_image; three views completed before this byte review', interpretation=original['scope']))
assert len(viewed) == 3

proof = dict(kind='E3_MACOS_CREATION_INDEPENDENT_BYTE_SOURCE_PROOF', sourceHead=HEAD, sourceTree=tree,
    originalCheckpoint=file_identity(D/'checkpoint.json'), payloads=payloads, payloadCount=10,totalBytes=1680069,
    fullMcpRawUtf8Exact=True, originalRawLines=len(lines), originalTerminalJob=job,
    originalInitialJob=initial_jobs[0], officialArtifact=official,
    zipMembers=members, allSafeUniqueNonSymlinkCRCAndExtractedBytesExact=True,
    freshGitFiles=fresh, allEightEqual578=True, sourceBindings=bindings,
    actualHelperCounts=counts, actualHelperNames=test_names, actionMarkers=markers,
    old578MarkerComparison=dict(originalLog=old_ref,count=32,first23NamesEqual=True,wholeQualificationTransferred=False),
    originalFirstFailure=raw_lines[694:698], originalRendererDump=dump, independentlyViewedImages=viewed)
proof_path=D/'independent-creation-byte-source-proof.json'
proof_bytes=(json.dumps(proof,ensure_ascii=False,indent=2)+'\n').encode()
with proof_path.open('xb') as f:f.write(proof_bytes)
assert proof_path.read_bytes()==proof_bytes

report=dict(kind='E3_MACOS_CREATION_INDEPENDENT_R2',reviewer='/root/native_failures',
    reviewedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    verdict='APPROVE original FAIL retention and qualified author wording; no repair or broader qualification',
    authorPacketUnchanged=True,findings=[],sourceHead=HEAD,sourceTree=tree,runId=43831885626,jobId=133178909700,
    originalCheckpoint=file_identity(D/'checkpoint.json'), authorAudit=file_identity(D/'audit.json'),
    authorSourceProof=file_identity(D/'source-proof.json'), authorAppendix=file_identity(D/'Plan29-appendix.md'),
    independentProof=file_identity(proof_path), integrity=dict(payloads=10,payloadBytes=1680069,zipFiles=1,zipMembers=24,
        allPngByteCrcDimensionsChecked=True,actuallyViewedPngs=3,remaining21IntegrityOnly=True,
        fullMcpToRawEquality=True,allEightGitBodiesFresh=True,allEightEqual578=True,all12AuthorSourceBindingsExact=True,
        sourceCensus1757Claimed=False,rebuiltRuntimeInventoryClaimed=False),
    originalJob=dict(status='completed',conclusion='failure',failedStep=failed_steps[0],
        checkoutExactHead=True,runnerNode='26.12.1',pnpm='11.22.0',os='macOS 26.7.2 / 25G332, macos-26-arm64',
        prerequisiteInstallHostBuildRuntimeStageElectronEnsureAndThreeHelperTestsSucceeded=True,
        helperArgv=helper_argv,helperTests=3,helperPassed=3,helperFailed=0,helperSkipped=0,helperCancelled=0,
        noP11WholeEightOrTeamOrStaticQualification=True),
    firstBoundary=dict(error=lines[694],rawLine=695,stack=raw_lines[694:698],lastActionMarker=markers[-1],
        originalScheduleOrder='Invalid cron/timezone native refusals; open editor; pristine Save and Team-is-required; open team Combobox; one option click selected by includes(fixture.teamName); then acknowledgement DOM wait.',
        intendedFixture='teams-create-page-e2e-961f3812-d46d-4321-a219-8e7161c753d4',
        finalVisibleSelectedTeam='org-team-e2e-8e8d57e5',
        retainedMismatch=True,actualOptionDispatchUnknown=True,geometryAndSelectionTransitionHistoryUnknown=True,
        savedRequestCompletionPromptAndPendingStateUnknown=True,
        wait=dict(milliseconds=45000,pollDelayMs=80,cdpCommandMs=30000,preReadDeadlineOnly=True,strictPostReadBound=False,
            actualReadCountUnretained=True),
        rendererProjection=dict(keys=list(dump),bodyPrefixCharacters=800),
        sourceImplication='Combobox non-disabled onSelect forwards its captured option.value; LaunchTeamDialog stores it. Saved-prompt hook reads that team, suppresses cancelled or empty results and only writes review state. These source branches do not identify the historical dispatched option or request outcome.',
        noCauseOrSourceRepairProven=True),
    views=viewed,
    cleanup=dict(originalFinallySourceOrderReviewed=True,originalCleanupReturnImpliedBySingleError=True,
        inferenceBasis='The original failure is rethrown after awaited cleanup; cleanup failure together with this Error would emit the distinct AggregateError branch.',
        originalUnixStrategy='SIGKILL original process group, fallback launcher kill, original 4s group-exit wait; fixture removal up to original eight attempts.',
        finalIndependentGroupCensusArchived=False,finalCleanupResultArchived=False,processGroupIdArchived=False,
        appOrHostExitCodesArchived=False,naturalExitProven=False,physicalCustodyCertificateProven=False,
        githubPostJobCleanupNotSubstitutedForHarnessEvidence=True),
    limits=['Twenty-three marker names match the earlier successful E2 prefix; the earlier PASS is not transferred.',
        'No final result JSON or complete 25-flag success record; later Schedule acknowledgement acceptance, valid create/update/delete and zh-TW path are unreached.',
        'The failure frame cannot prove lower offscreen content absent. The original DOM wait supplies the refusal boundary.',
        'Deny-all/degraded-runtime and SQLite fallback tail messages do not establish selection or saved-prompt cause.',
        'All three image interpretations were independently viewed; the other 21 were integrity checked only.',
        'No new API read, download, local project/native/vendor execution, CI action, source/ref change or candidate was performed for this independent review.'])
report_path=D/'independent-creation-review.json'
b=(json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode()
with report_path.open('xb') as f:f.write(b)
assert report_path.read_bytes()==b
print(json.dumps(dict(review=file_identity(report_path),proof=file_identity(proof_path),verdict=report['verdict']),ensure_ascii=False))
