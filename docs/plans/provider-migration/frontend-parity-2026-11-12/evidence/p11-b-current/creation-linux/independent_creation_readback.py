"""Read-only evidence/Git verification. Does not import or execute project code."""
import binascii
import hashlib
import json
import pathlib
import re
import stat
import struct
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

ROOT = pathlib.Path('/workspace/scratch/82d3f9ba6b85')
REPO = ROOT / 'agent-teams-e2e'
H = '72e6ec04444969d343d73834c70bc4e261100fc9'
E2 = '57885c055a18b27c180c304762643eac632513ad'
PLATFORM = sys.argv[1]
assert PLATFORM in ('windows', 'ubuntu')
B = ROOT / f'ci-72e6ec/creation-{PLATFORM}'

def ids(b):
    return {'bytes': len(b), 'blob': hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest(),
            'sha256': hashlib.sha256(b).hexdigest()}

def ref(p):
    p = pathlib.Path(p)
    return {'path': str(p.relative_to(ROOT)), **ids(p.read_bytes())}

def load(p):
    return json.loads(pathlib.Path(p).read_bytes())

def check(b, expected):
    actual = ids(b)
    for k in actual:
        if k in expected:
            assert actual[k] == expected[k], (expected.get('path'), k, actual[k], expected[k])
    return actual

def objects(v):
    if isinstance(v, dict):
        yield v
        for x in v.values():
            yield from objects(x)
    elif isinstance(v, list):
        for x in v:
            yield from objects(x)
    elif isinstance(v, str) and v.lstrip().startswith(('{', '[')):
        try:
            parsed = json.loads(v)
        except (ValueError, TypeError):
            return
        yield from objects(parsed)

def unique_rows(v, predicate):
    rows = {json.dumps(x, sort_keys=True): x for x in objects(v) if predicate(x)}
    return list(rows.values())

def git(path, head=H):
    return subprocess.check_output(['git', 'show', head+':'+path], cwd=REPO)

cp = load(B/'checkpoint.json')
audit = load(B/'audit.json')
source = load(B/'source-proof.json')
assert cp['sourceHead'] == audit['sourceHead'] == source['sourceHead'] == H
assert cp['jobId'] == audit['jobId'] and cp['runId'] == audit['runId'] == 43831885626
original_refs = []
for p in cp['payloads']:
    bb = (ROOT/p['path']).read_bytes()
    original_refs.append({'path':p['path'], **check(bb, p)})
assert len(original_refs) == cp['payloadCount']
assert sum(p['bytes'] for p in original_refs) == cp['payloadBytes']
for key in ('authorAudit', 'appendix', 'sourceProof'):
    check((ROOT/cp[key]['path']).read_bytes(), cp[key])

raw_path = ROOT/audit['originalLog']['path']
raw = raw_path.read_bytes()
response_path = ROOT/audit['originalLogResponse']['path']
response = load(response_path)
assert response.get('isError') is not True
assert response['structuredContent']['content'].encode('utf-8') == raw
raw_text = raw.decode('utf-8')
lines = raw_text.splitlines()
strip_ts = re.compile(r'^\ufeff?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z ?')
plain_lines = [strip_ts.sub('', s) for s in lines]
plain = '\n'.join(plain_lines)
assert H in plain_lines
assert f'HEAD is now at {H[:7]}' in plain
assert 'node: v26.12.1' in plain and 'using pnpm v11.22.0' in plain
assert '##[error]' not in raw_text

correction = None
if PLATFORM == 'windows':
    correction = load(B/'raw-serialization-correction.json')
    check(raw, correction['retainedOriginalLog'])
    check(response_path.read_bytes(), correction['originalResponse'])
    check(raw.replace(b'\r\n', b'\n'), correction['firstLocalLog'])
    assert raw.count(b'\r\n') == 956
    assert not correction['apiRefetched'] and not correction['rawSourceChanged']

jobs_response = load(ROOT/audit['terminalJobsResponse']['path'])
job_rows = unique_rows(jobs_response, lambda x:x.get('id') == cp['jobId'] and 'steps' in x)
assert len(job_rows) == 1, len(job_rows)
job = job_rows[0]
assert job['run_id'] == cp['runId'] and job['status'] == 'completed' and job['conclusion'] == 'success'
for k,v in audit['terminalJob'].items():
    assert job[k] == v, k
steps = {s['number']:s for s in job['steps']}
assert steps[11]['conclusion'] == steps[12]['conclusion'] == steps[13]['conclusion'] == 'success'
assert steps[2]['conclusion'] == ('success' if PLATFORM == 'windows' else 'skipped')
assert steps[6]['conclusion'] == ('skipped' if PLATFORM == 'windows' else 'success')

archive_path = ROOT/audit['originalZip']['path']
ar = archive_path.read_bytes()
official_response = load(ROOT/audit['officialArtifactsResponse']['path'])
artifact_rows = unique_rows(official_response, lambda x:x.get('id') == audit['officialArtifact']['id'] and 'digest' in x)
assert len(artifact_rows) == 1
artifact = artifact_rows[0]
assert artifact == audit['officialArtifact']
assert artifact['digest'] == 'sha256:'+ids(ar)['sha256']
assert artifact['size_in_bytes'] == len(ar)
assert artifact['workflow_run']['id'] == cp['runId'] and artifact['workflow_run']['head_sha'] == H
assert str(artifact['id']) in raw_text and ids(ar)['sha256'] in raw_text
retention = load(ROOT/audit['archiveRetention']['path'])
retained_members = {x.get('name', x.get('path')): {**x, 'blob': x.get('blob', x.get('gitBlob')), 'crc32': x.get('crc32', f"{x.get('crc', 0):08x}")} for x in retention['members']}
author_members = {x['path']:x for x in audit['archiveMembers']}
members = []
with zipfile.ZipFile(archive_path) as z:
    infos=z.infolist()
    assert len(infos) == 41 and len({x.filename for x in infos}) == 41
    for i in infos:
        n=i.filename; p=pathlib.PurePosixPath(n)
        assert not p.is_absolute() and '..' not in p.parts and '\\' not in n and ':' not in n
        assert not stat.S_ISLNK(i.external_attr >> 16) and not i.is_dir()
        b=z.read(i)
        assert (B/'extracted'/n).read_bytes() == b
        assert binascii.crc32(b) & 0xffffffff == i.CRC
        ident=check(b,retained_members[n]); check(b,author_members[n])
        row={'path':n, **ident, 'crc32':f'{i.CRC:08x}'}
        assert row['crc32'] == retained_members[n]['crc32'] == author_members[n]['crc32']
        if n.endswith('.png'):
            assert b[:8] == b'\x89PNG\r\n\x1a\n'
            row['dimensions'] = list(struct.unpack('>II',b[16:24]))
            assert row['dimensions'] == author_members[n]['dimensions']
        members.append(row)
assert set(retained_members)==set(author_members)=={x['path'] for x in members}
assert len([x for x in members if x['path'].endswith('.png')]) == 40

result_bytes = (B/'extracted/teams-create-page-result.json').read_bytes()
result = json.loads(result_bytes)
pos = plain.index('{\n  "success": true,')
printed,end = json.JSONDecoder().raw_decode(plain[pos:])
assert printed == result == audit['resultObject']
assert plain[pos:pos+end].encode('utf-8') == result_bytes
assert result['success'] is True
flags={k:v for k,v in result.items() if type(v) is bool and k != 'success'}
assert len(flags)==25 and all(flags.values()) and flags == audit['behaviorFlags']
assert result['scheduleUiEvidence']['createdAndDeleted'] is True
assert result['zhTwMcpUiEvidence']['locale']=='zh-TW'
assert result['zhTwMcpUiEvidence']['parsedServerNames']==['github','sentry']
assert result['macInputSelectionFallbackCount']==0
marker_rows=[]
for j,s in enumerate(lines):
    if plain_lines[j].startswith('STEP: '):
        marker_rows.append({'line':j+1,'timestamp':s.split(' ',1)[0], 'step':plain_lines[j][6:]})
assert len(marker_rows)==32 and marker_rows==audit['originalActionMarkers']
counts={}
for key in ['tests','pass','fail','cancelled','skipped','todo','duration_ms']:
    counts[key]=[float(m.group(1)) if '.' in m.group(1) else int(m.group(1)) for m in re.finditer(r'(?m)^ℹ '+key+r' ([\d.]+)$',plain)]
assert all(counts[k]==[n] for k,n in [('tests',3),('pass',3),('fail',0),('cancelled',0),('skipped',0),('todo',0)])
for k,v in audit['originalPrerequisite']['counts'].items(): assert counts[k]==v

sources=[]; bodies={}
for expected in source['files']:
    p=expected['path']; b=git(p); body=b.decode(); bodies[p]=body
    actual=check(b,expected)
    assert len(body.splitlines())==expected['lines']
    assert git(p,E2)==b
    sources.append({'path':p,**actual,'fullFreshGitRead':True,'equalE2Source':True})
assert len(sources)==4
assert subprocess.check_output(['git','rev-parse',H+'^{tree}'],cwd=REPO).decode().strip()==source['sourceTree']==audit['sourceTree']
for binding in source['bindings']:
    body=bodies[binding['sourcePath']].splitlines(keepends=True)
    assert ''.join(body[binding['firstLine']-1:binding['lastLine']]) == binding['text']
assert 'ownedProcessHelper' not in source or bodies['scripts/e2e/teams-create-page-owned-processes.mjs'] == source['ownedProcessHelper']
assert 'ownedProcessHelperTest' not in source or bodies['scripts/e2e/teams-create-page-owned-processes.test.mjs'] == source['ownedProcessHelperTest']
driver=bodies['scripts/e2e/teams-create-page-desktop.mjs']
workflow=bodies['.github/workflows/teams-create-page-desktop-e2e.yml']
assert all(("log('"+row['step']+"')") in driver for row in marker_rows)
assert "await cleanup({ ...fixture, root: null });" in driver
assert "process.exit(77)" in driver and 'fixture-runtime-deny.cjs' in driver
assert 'CLAUDE_CLI_PATH: fixture.providerCliPaths.claude' in driver
assert 'CODEX_CLI_PATH: fixture.providerCliPaths.codex' in driver
assert 'run: node --test scripts/e2e/teams-create-page-owned-processes.test.mjs' in workflow
assert 'xvfb-run -a node scripts/e2e/teams-create-page-desktop.mjs' in workflow
extra_path='scripts/e2e/opencode-diagnostics/platform.mjs'
extra_body=git(extra_path)
extra_source={'path':extra_path,**ids(extra_body),'purpose':'Independent context for original processes() and PID/birth parser; not an additional artifact capture pin'}

cleanup=result['cleanup']
if PLATFORM=='windows':
    assert cleanup['processGroupAbsent'] is None
    assert cleanup['windowsTaskkillExitedZero'] is True and cleanup['windowsExactOwnedProcessesAbsent'] is True
    assert len(cleanup['windowsTeardowns'])==3
    assert [x['launcherPid'] for x in cleanup['windowsTeardowns']]==[8116,2092,860]
    assert all(x['taskkillAttempted'] and x['taskkillExitCode']==0 and x['observedIdentityCount']==17 and x['exactOwnedProcessesAbsent'] and x['cdpPortAbsent'] for x in cleanup['windowsTeardowns'])
else:
    assert cleanup['processGroupAbsent'] is True
    assert all(cleanup[k] is None for k in ('windowsTaskkillExitedZero','windowsExactOwnedProcessesAbsent','windowsTeardowns'))
assert cleanup['temporaryProfileRemoved'] is True

views=[]
for name,meaning in [
 ('teams-create-restarted.png','Actual singly opened original frame: restored Create Team editor; named draft, lead, checked Run command after create. This is editor persistence, not runtime readiness.'),
 ('teams-create-copy-resumed-edits.png','Actual singly opened original frame: edited copied-team name and retained editor controls; collapsed prompt/description bodies are not independently visible.'),
 ('teams-create-launch-controls-loaded.png','Actual singly opened original frame: loaded Launch modal, sandbox-project/OpenCode/test-model; disabled Launch. Provider status is separately recorded below; no accepted runtime launch.')]:
    row=next(x for x in members if x['path']==name)
    views.append({**row,'independentlyViewed':True,'method':'view_image, one original PNG per tool call','interpretation':meaning})

views[0]['interpretation'] = 'Actual singly viewed1280x900 original: draft create-page-e2e-b207a842, Opus4.8 lead, checked Run command after create, empty Tasks sidebar, no projects, Anthropic Checking and disabled Create. No readiness proof.'
views[1]['interpretation'] = 'Actual singly viewed1280x900 original: copy-edited-e2e-3c62a3aa retained, Lead prompt and Description chips with collapsed bodies, original draft tab, Anthropic Checking and disabled Create.'
views[2]['interpretation'] = 'Actual singly viewed1280x900 original: sandbox-project/OpenCode/test-model loaded Launch modal; Needs attention, fresh project-scoped provider catalog diagnostic, disabled Launch. No launch or readiness success.'

proof={'kind':'INDEPENDENT_E3_CREATION_BYTE_SOURCE_PROOF','reviewer':'/root/native_failures','sourceHead':H,'platform':PLATFORM,
       'checkpoint':ref(B/'checkpoint.json'),'payloads':original_refs,'payloadCount':len(original_refs),'payloadBytes':sum(p['bytes'] for p in original_refs),
       'originalMcpToRawExact':True,'rawLineCount':len(lines),'rawCRLFCount':raw.count(b'\r\n'),'rawSerializationCorrection':correction,
       'terminalJob':job,'officialArtifact':artifact,'archiveMembers':members,'safeUniqueNonSymlinkCrcExtractedEquality':True,
       'result':{'identity':ref(B/'extracted/teams-create-page-result.json'),'printedBytesEqualArchivedBytes':True,'object':result},
       'sourceTree':source['sourceTree'],'fourAuthorClaimSourcesFreshGit':sources,'additionalReadOnlySource':extra_source,
       'sourceBindingsFreshGitEqual':source['bindings'],'ownedProcessHelper':bodies['scripts/e2e/teams-create-page-owned-processes.mjs'],'ownedProcessHelperTest':bodies['scripts/e2e/teams-create-page-owned-processes.test.mjs'],
       'originalActionMarkers':marker_rows,'nodeReporterCounts':counts,
       'originalRunCommandLines':[{'line':i+1,'text':s} for i,s in enumerate(lines) if '##[group]Run ' in s],
       'originalCheckoutLines':[{'line':i+1,'text':s} for i,s in enumerate(lines) if H in s],
       'pngViews':views,'otherPngsByteCrcDimensionsOnly':37,'projectExecution':False,'apiRefetch':False}
report={'kind':'INDEPENDENT_E3_CREATION_R2','reviewer':'/root/native_failures','reviewedAtUTC':datetime.now(timezone.utc).isoformat(),
        'verdict':'APPROVE_SCOPED_ORIGINAL_RESULT_NO_CORRECTIONS','sourceHead':H,'sourceTree':source['sourceTree'],'runId':cp['runId'],'jobId':cp['jobId'],
        'authorCheckpoint':ref(B/'checkpoint.json'),'authorAudit':ref(B/'audit.json'),'authorAppendix':ref(B/'Plan29-appendix.md'),
        'foundation':{'fullPayloadCount':len(original_refs),'fullPayloadBytes':sum(p['bytes'] for p in original_refs),'fullOriginalMcpUtf8Join':True,
                      'rawIdentity':ref(raw_path),'rawLineCount':len(lines),'rawCRLFCount':raw.count(b'\r\n'),'officialZip':ref(archive_path),
                      'all41MembersSafeUniqueCrcAndExtractionEqual':True,'40PngByteAndDimensionChecks':True,'threeActualIndependentSingleImageViews':views,
                      'fourClaimSourceBodiesFreshGitEqualE2':sources,'additionalContextSource':extra_source,
                      'sourceBoundary':'Four claim/venue Git bodies plus one independently read parser/context source. No 1757 Desktop census, full compiled-output census or independent rebuild.'},
        'originalAcceptance':{'terminalJobSuccess':True,'node':'26.12.1','pnpm':'11.22.0','helperArgv':'node --test scripts/e2e/teams-create-page-owned-processes.test.mjs',
            'helperCounts':counts,'driverArgv':('node scripts/e2e/teams-create-page-desktop.mjs' if PLATFORM=='windows' else 'xvfb-run -a node scripts/e2e/teams-create-page-desktop.mjs'),
            'orderedMarkers':marker_rows,'25BehaviorFlags':flags,'scheduleUiEvidence':result['scheduleUiEvidence'],'zhTwMcpUiEvidence':result['zhTwMcpUiEvidence'],
            'resultPrintedEqualsArchivedBytes':True,'macInputSelectionFallbackCount':0,
            'launchLimit':'Original driver verifies loaded modal then sends Escape without starting the deny-all runtime. Screenshot status is not NativeReady or runtime execution. Config-only creation, validation, and schedule Run-now/persistence checks are distinct from provider execution.',
            'vendorLimit':'Exact source binds finite metadata-only Claude/Codex peers and deny-all lifecycle runtime. This is not execution or qualification of real vendors, login, or a paid provider.'},
        'cleanup':{'originalResult':cleanup,'forced':True,'naturalExitQualified':False,'nativeProviderCustodyQualified':False,'productStopQualified':False,
            'sourceOrder':'Original cleanup awaits termination/absence and profile removal; saved success JSON is emitted only after scenario and cleanup error checks. Simultaneous failure retains AggregateError precedence.',
            'windowsLimit':'PID/birth history and CDP absence jointly gate success after taskkill /PID /T /F. Three counts of17 are per teardown, not51 globally distinct. No archived identity-array or per-child exit ledger, original-HANDLE certificate or natural-exit claim.' if PLATFORM=='windows' else None,
            'unixLimit':'Original detached group is forcibly signalled SIGKILL (fallback direct kill if the signal call throws); signal0 polling accepts ESRCH and refuses EPERM, with original4s bound. No PID/birth census, natural shutdown, original-HANDLE certificate or per-child exit ledger.' if PLATFORM=='ubuntu' else None},
        'rawCorrection':'Exact original CRLF bytes recovered from retained original MCP; LF-normalized predecessor reproduced and identified. No endpoint refetch.' if correction else None,
        'visualStatus':'Checking, disabled Launch' if PLATFORM=='windows' else 'Needs attention, disabled Launch; see actual image notes',
        'qualificationLimits':['Only this original platform Creation result at72e; same-source macOS failure remains failed and has no final cleanup certificate.',
            'No Team/static, P11 semantic RED, Models tests, whole frontend, other Desktop, packaged/native or release qualification.',
            'No result transfer to later bfc/followup source and no historical causal repair assertion.',
            'Complete raw log read; artifact images are three actual views and37 remaining byte/CRC/dimension checks, not40 visual reviews.'],
        'changesRequired':[],'originalPayloadsPreserved':True,'noProjectExecution':True,'noApiCallsOrCiSourceRefMutations':True}
proof_path=B/'independent-creation-byte-source-proof.json'
report_path=B/'independent-creation-review.json'
assert not proof_path.exists() and not report_path.exists()
for p in original_refs:
    check((ROOT/p['path']).read_bytes(),p)
pb=(json.dumps(proof,ensure_ascii=False,indent=2)+'\n').encode()
with proof_path.open('xb') as f:f.write(pb)
assert proof_path.read_bytes()==pb
report['byteSourceProof']=ref(proof_path)
rb=(json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode()
with report_path.open('xb') as f:f.write(rb)
assert report_path.read_bytes()==rb
print(json.dumps({'review':ref(report_path),'proof':ref(proof_path),'verdict':report['verdict']},indent=2))
