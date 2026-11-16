"""Read-only original evidence/Git byte audit. No source or project execution."""
import collections
import datetime
import hashlib
import io
import json
import pathlib
import re
import stat
import subprocess
import zipfile

ROOT = pathlib.Path('/workspace/scratch/82d3f9ba6b85')
REPO = ROOT / 'agent-teams-e2e'
BASE = ROOT / 'ci-57885c/native'
HEAD = '57885c055a18b27c180c304762643eac632513ad'
E1 = 'e1d14b9cd0fa1d7896b58e513f9040639e9e4940'
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
STAMP = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z ?', re.M)

def ident(data):
    return {'bytes': len(data), 'blob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest(), 'sha256': hashlib.sha256(data).hexdigest()}

def file_ref(path):
    return {'path': str(path.relative_to(ROOT)), **ident(path.read_bytes())}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO)

def git_bytes(path, head=HEAD):
    return git('show', head + ':' + path)

def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def normalized(data):
    return data.decode('utf-8-sig').replace('\r\n', '\n')

def json_rows(data):
    rows = []
    for i, line in enumerate(normalized(data).splitlines(), 1):
        line = ANSI.sub('', STAMP.sub('', line))
        if line.startswith('{'):
            try:
                rows.append({'line': i, 'row': json.loads(line)})
            except ValueError:
                pass
    return rows

def write_new(path, value):
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    assert not path.exists(), str(path)
    path.write_bytes(data)
    assert path.read_bytes() == data
    print(json.dumps(file_ref(path), ensure_ascii=False))

jobs_path = BASE / 'owned-process-jobs-response-0752.json'
jobs = load(jobs_path)['structuredContent']['jobs']
artifacts_path = BASE / 'official-process-artifacts-0746.json'
artifacts = load(artifacts_path)['structuredContent']['artifacts']
old_source = load(ROOT / 'native-audit-E1e1d14b/process-windows-x64-failure-audit.json')
source_paths = {x['path'] for x in old_source['sources']}
source_paths.update([
    'tools/owned-process-broker/nativeEmulatedSourceScenario.ts',
    'tools/owned-process-broker/nativeEmulatedSourceProfile.ts',
    'tools/owned-process-broker/nativeEmulatedSourceReadiness.ts',
    'tools/owned-process-broker/nativeEmulatedProviderGate.ts',
    'tools/owned-process-broker/nativeEmulatedProfile.ts',
    'packages/legacy-agent-host/src/composition/prepareTeamModelReadiness.ts',
    'packages/legacy-agent-host/src/management/ModelProbeOwner.ts',
    'packages/legacy-agent-host/src/composition/projectRuntimeMember.ts',
    'packages/legacy-agent-host/src/composition/createRuntimeMemberProviderFactory.ts',
    'packages/legacy-agent-host/src/owned-process/HostWindowsLaunch.ts',
    'packages/legacy-agent-host/src/adapters/providers/CodexMemberProvider.ts',
    'packages/legacy-agent-host/src/adapters/providers/OpenCodeMemberProvider.ts',
    'packages/legacy-agent-host/src/runtime/RuntimeOwner.ts',
    'packages/legacy-agent-host/src/adapters/providers/readCodexMcpCatalog.ts',
    'tools/owned-process-broker/fixtures/providerPeer.mjs',
    'tools/owned-process-broker/fixtures/providerDesktopPeer.mjs',
    'tools/owned-process-broker/fixtures/claudeProviderPeer.mjs',
    'packages/legacy-agent-host/package.json',
    'packages/legacy-agent-host/tsconfig.json',
    'tools/owned-process-broker/native-tsconfig.json',
    'scripts/run-bound-test.mjs',
])
# Only paths that really exist at the immutable source can be claim inputs.
source_paths = {p for p in source_paths if subprocess.run(['git','cat-file','-e',HEAD+':'+p],cwd=REPO,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0}
sources = []
for path in sorted(source_paths):
    data = git_bytes(path)
    sources.append({'path': path, **ident(data), 'lines': len(data.splitlines()), 'equalsE1': data == git_bytes(path, E1)})

host_paths = git('ls-tree','-r','--name-only',HEAD,'packages/legacy-agent-host/src').decode().splitlines()
host_paths = sorted(p for p in host_paths if p.endswith('.ts'))
batch = subprocess.Popen(['git','cat-file','--batch'],cwd=REPO,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
host_rows = []
lf = hashlib.sha256(); crlf = hashlib.sha256()
for path in host_paths:
    batch.stdin.write((HEAD+':'+path+'\n').encode()); batch.stdin.flush()
    header = batch.stdout.readline().decode().strip().split()
    assert len(header)==3 and header[1]=='blob'
    data = batch.stdout.read(int(header[2])); assert batch.stdout.read(1)==b'\n'
    assert ident(data)['blob']==header[0]
    relative = path.removeprefix('packages/legacy-agent-host/src/')
    lf.update(relative.encode()+b'\0'+data+b'\0')
    converted = data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    crlf.update(relative.encode()+b'\0'+converted+b'\0')
    host_rows.append({'path':path, **ident(data), 'crlfSha256':hashlib.sha256(converted).hexdigest()})
batch.stdin.close(); assert batch.wait()==0
host_proof = {'kind':'Fresh immutable source census, not an independent rebuild', 'sourceHead':HEAD, 'files':len(host_rows), 'algorithm':'Sorted src-relative UTF-8 path + NUL + exact source bytes + NUL; Windows variant deterministically converts LF to CRLF.', 'LF':lf.hexdigest(), 'CRLF':crlf.hexdigest(), 'rows':host_rows, 'limit':'Windows source receipts pin selected src and built dist separately. This census is source attribution only; it does not establish archived executable or every installed dependency byte.'}
host_path = BASE/'host-source-E2-git-audit.json'
if host_path.exists():
    assert load(host_path) == host_proof
else:
    write_new(host_path, host_proof)

specs = [
    {'arch':'x64','job':133150850768,'artifact':14206178372,'provider':'opencode','failStep':22,'pollLine':62},
    {'arch':'arm64','job':133150850267,'artifact':14206705481,'provider':'codex','failStep':20,'pollLine':64},
]
for spec in specs:
    d = BASE / ('process-windows-' + spec['arch'])
    raw_path = d / ('job-'+str(spec['job'])+'.log')
    response_path = d / ('original-job-'+str(spec['job'])+'-response.json')
    raw = raw_path.read_bytes()
    response = load(response_path)
    assert response['structuredContent']['content'].encode() == raw
    text = normalized(raw)
    plain_body = STAMP.sub('',text)
    ansi_body = ANSI.sub('',plain_body)
    job = next(x for x in jobs if x['id']==spec['job'])
    assert job['run_id']==43823212637 and job['conclusion']=='failure'
    assert [x['number'] for x in job['steps'] if x['conclusion']=='failure']==[spec['failStep']]
    assert all(next(x for x in job['steps'] if x['number']==n)['conclusion']=='success' for n in [7,8,9,10,16,17,18,19,24])
    artifact = next(x for x in artifacts if x['id']==spec['artifact'])
    assert artifact['workflow_run']['head_sha']==HEAD and artifact['workflow_run']['id']==43823212637
    archive_path = d / ('artifact-'+str(spec['artifact'])+'.zip')
    data = archive_path.read_bytes()
    assert len(data)==artifact['size_in_bytes'] and 'sha256:'+ident(data)['sha256']==artifact['digest']
    z = zipfile.ZipFile(io.BytesIO(data)); assert z.testzip() is None
    assert len(z.namelist())==len(set(z.namelist()))
    members=[]
    for zi in z.infolist():
        path=pathlib.PurePosixPath(zi.filename)
        assert not path.is_absolute() and '..' not in path.parts and '\\' not in zi.filename and not stat.S_ISLNK(zi.external_attr>>16)
        if zi.is_dir(): continue
        mb=z.read(zi); local=d/'extracted'/zi.filename
        assert local.read_bytes()==mb
        members.append({'member':zi.filename,'crc32':format(zi.CRC,'08x'),**ident(mb)})
    b=d/'extracted/agent-teams-ai/agent-teams-ai/process-acceptance-evidence'
    assert normalized((b/'source-head.txt').read_bytes()).strip()==HEAD
    assert 'test "$(git rev-parse HEAD)" = "$HOST_PROCESS_SOURCE_HEAD"' in text
    assert 'HOST_PROCESS_SOURCE_HEAD: '+HEAD in text
    tee=[]
    for p in sorted(b.glob('*.log')):
        tt=normalized(p.read_bytes())
        direct=tt.strip('\n') in plain_body
        assert direct or ANSI.sub('',tt).strip('\n') in ansi_body, str(p)
        tee.append({**file_ref(p),'lines':len(tt.splitlines()),'fullContiguousJoin':True,'transformation':'UTF-8 BOM/newline normalization and original ISO timestamp prefix removal' + ('' if direct else '; additionally remove retained ANSI SGR on both sides (including PowerShell red error-stream decoration)')})
    native=[]
    for name in ['windows-node24.log','windows-electron.log']:
        p=b/name; rows=json_rows(p.read_bytes())
        gate=next(r['row'] for r in rows if r['row'].get('gate')=='owned-process-native-scenarios-only')
        assert len(gate['results'])==25
        phases=[r['row']['nativePhase'] for r in rows if r['row'].get('nativePhase',{}).get('phase')=='complete']; assert len(phases)==31
        i386=next(r for r in rows if 'nativeI386ChildObservation' in r['row'])
        obs=i386['row']['nativeI386ChildObservation']; assert obs['status']=='observed'
        assert len(obs['observations'])==6
        matching=[x for x in obs['observations'] if x['pid']==obs['child']['pid'] and x['birth']==obs['child']['birth']]
        assert len(matching)==4 and [x['handled'] for x in matching]==[1,1,0,0] and all(x['firstChance']==1 for x in matching)
        assert [x['code'] for x in matching[:2]]==[0x80000003,0x4000001f]
        assert obs['directI386RootLateHandler']=='unqualified'
        pending=next(r for r in rows if 'nativeServicePendingCreate' in r['row'])
        assert pending['row']['nativeServicePendingCreate']=={'rootExited':False,'activeProcesses':0,'queryError':0,'dispatchError':0,'stopReplied':False}
        before=next(r for r in rows if r['row'].get('cleanupObservation')=='before-private-abandon')
        after=next(r for r in rows if r['row'].get('cleanupObservation')=='after-helper-wait')
        assert before['row']['helperCount']==after['row']['helperCount']==64
        assert before['row']['retainedCount']==after['row']['retainedCount']==9
        assert [x['slot'] for x in before['row']['helpers'] if not x['closed']]==[0]
        assert all(x['closed'] for x in after['row']['helpers'])
        assert after['row']['helpers'][0]['exit']=={'code':None,'signal':'SIGTERM'} and after['row']['helpers'][0]['cleanupRequested']
        controller=rows[-1]; assert controller['row']=={'gateController':'drained','rootExitCode':0,'activeProcesses':0}
        native.append({'file':file_ref(p),'gate':gate,'completedPhases':phases,'i386':i386,'pendingCreate':pending,'negativeCases':[r for r in rows if 'nativeNegative' in r['row']],'cleanupBefore':before,'cleanupAfter':after,'controller':controller,'limit':'25 result labels and 31 complete phase records are different counters. Original sentinel and broker-crash use SIGTERM; negative exit codes remain. I386 output qualifies the original matching child rows only; direct I386 root late handling stays explicitly unqualified, and complete row delivery/fsync/absence of later rows is not established.'})
    prereqs={}
    for name in ['host-contracts.log','protocol.log','retained-main.log']:
        tt=ANSI.sub('',normalized((b/name).read_bytes()))
        if name=='host-contracts.log':
            counts={k:int(v) for k,v in re.findall(r'ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)',tt)}
            assert counts=={'tests':167,'pass':164,'fail':0,'cancelled':0,'skipped':3,'todo':0}
        else:
            count=54 if name=='protocol.log' else 81
            assert re.search(r'Tests\s+'+str(count)+r' passed',tt)
            counts={'pass':count,'fail':0,'skip':0,'files':3 if count==54 else 8}
        prereqs[name]=counts
    receipts=[]; pin_joins=[]; non_git=[]
    for rp in sorted(b.glob('*receipt.json')):
        rec=load(rp); assert rec['sourceHead']==HEAD and rec['platform']=='win32-'+spec['arch']
        assert rec['nodeVersion']=='v24.21.0'
        assert all(rec.get(k) is False for k in ['realProviderExecuted','desktopQualified','releaseQualified'])
        def visit(value,where='$'):
            if isinstance(value,dict):
                if set(value)=={'path','sha256'} and isinstance(value['path'],str):
                    path=value['path'].replace('\\','/')
                    marker='/agent-teams-ai/agent-teams-ai/'
                    relative=path.split(marker,1)[1] if marker in path else None
                    if relative and not '/dist/' in relative and subprocess.run(['git','cat-file','-e',HEAD+':'+relative],cwd=REPO,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
                        gd=git_bytes(relative); lfhash=hashlib.sha256(gd).hexdigest(); converted=gd.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'); whash=hashlib.sha256(converted).hexdigest()
                        assert value['sha256'] in [lfhash,whash],(relative,value['sha256'],lfhash,whash)
                        pin_joins.append({'receipt':rp.name,'field':where,'recordedPath':value['path'],'relative':relative,'recordedSha256':value['sha256'],'git':ident(gd),'conversion':'Git LF' if value['sha256']==lfhash else 'Git LF to Windows CRLF'})
                    else: non_git.append({'receipt':rp.name,'field':where,**value,'scope':'Retained digest only: compiled executable/dist, generated fixture or original installed Node; bytes not independently reconstructed from Git.'})
                for k,v in value.items():visit(v,where+'.'+k)
            elif isinstance(value,list):
                for i,v in enumerate(value):visit(v,where+'['+str(i)+']')
        visit(rec)
        scenarios=rec.get('sourceScenarios',[])
        receipts.append({'file':file_ref(rp),'kind':rec['kind'],'provider':rec.get('provider'),'status':rec['status'],'cleanup':rec['cleanup'],'sourceScenarios':scenarios,'otherTopLevelFields':{k:v for k,v in rec.items() if k not in ['pins','sourceScenarios']}})
    failure_receipt=load(b/('windows-source-'+spec['provider']+'-receipt.json')); scenario=failure_receipt['sourceScenarios'][0]
    assert failure_receipt['status']=='INCOMPLETE' and scenario['status']=='INCOMPLETE' and scenario['stage']=='Team-A'
    assert failure_receipt['cleanup'] is True
    assert 'nativeEmulatedSourceScenario.ts:'+str(spec['pollLine'])+':12' in text
    assert scenario['lastLaunchReadiness']['lastRuntimeRead']['nativeReady'] is False
    assert scenario['runtimeProjection']['recordReady'] is False and scenario['runtimeProjection']['providerReady'] is None and scenario['runtimeProjection']['ownerCurrent'] is None
    failure_jobs=scenario['epochs'][0]['jobs']
    if spec['arch']=='x64':
        assert scenario['cleanup'] is False and len(failure_jobs)==3
        assert all(all(j[k] for k in ['resumed','stopped','drained','released','originalHandleAbsent']) for j in failure_jobs[:2])
        j=failure_jobs[2];assert j['root'] is None and j['resumed'] is False and j['originalHandleAbsent'] is False and j['entryStart'] is None and j['entryEnd'] is None
        assert all(j[k] is True for k in ['stopped','drained','released'])
        ref,consumer,native,opening=scenario['firstRefusal']['observations']
        assert ref['phase']=='probe-expiry' and ref['probeNow']-ref['probeCutoff']==232
        assert ref['probeCutoff']-consumer['observedAt']==349 and ref['probeNow']-consumer['observedAt']==581
        assert consumer['currentCalls']=={'count':17,'totalMs':10189,'maxMs':674,'lastMs':608,'truncated':False}
        assert native['phase']=='prepare' and native['reason']=='current-false' and native['dispatched'] and native['staged'] and not native['rootCaptured'] and native['deadlineExpired'] is None
        assert opening['phase']=='native-ready' and opening['reason']=='threw'
    else:
        assert scenario['cleanup'] is True and len(failure_jobs)==7
        assert all(all(j[k] is True for k in ['resumed','stopped','drained','released','originalHandleAbsent']) for j in failure_jobs)
        assert scenario['firstRefusal']=={'status':'unknown','reason':'empty'}
    raw_rows=json_rows(raw)
    source_rows=[x for x in raw_rows if x['row'].get('kind','').startswith('TEST_SOURCE_')]
    cleanup_rows=[x for x in source_rows if x['row']['kind']=='TEST_SOURCE_CLEANUP' and x['row']['provider']==spec['provider']]
    error_lines=[{'line':i,'text':ANSI.sub('',STAMP.sub('',l))} for i,l in enumerate(text.splitlines(),1) if any(x in ANSI.sub('',l) for x in ['AggregateError:', 'AssertionError [ERR_ASSERTION]:','nativeEmulatedSourceScenario.ts:'+str(spec['pollLine'])+':12','original source controller did not confirm cleanup'])]
    report={
        'kind':'Author original E2 Windows Process evidence and first-boundary audit; independent R2 pending',
        'auditedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':HEAD,'runId':43823212637,'jobId':spec['job'],'job':job,
        'originalInputs':{'jobAPI':file_ref(jobs_path),'artifactAPI':file_ref(artifacts_path),'fullResponse':file_ref(response_path),'fullRawLog':file_ref(raw_path),'mcpUTF8Exact':True,'artifactMetadata':artifact,'archive':file_ref(archive_path),'safeCRC':True,'members':members,'sourceHeadMemberExact':True},
        'originalTeeJoins':tee,'selectedGitSources':sources,'hostSourceCensus':file_ref(host_path),
        'capturedSourcePinOccurrences':pin_joins,'nonGitDigestOccurrences':non_git,
        'prerequisites':{'originalWholeCommands':prereqs,'totalPass':299,'totalSkip':3,'totalFail':0,'wholeJobFailureIndependentOfPrerequisitePass':True},
        'originalNativeNodeAndElectron':native,'receipts':receipts,
        'firstFailure':{'provider':spec['provider'],'stage':'Team-A','message':'Original source Team readiness','originalPollLine':spec['pollLine'],'predicate':'pre-read deadline' if spec['pollLine']==62 else 'post-read deadline','originalBudgetMs':15000,'budgetAnchor':'after original Start acknowledgement for non-Claude source lanes','readiness':scenario['lastLaunchReadiness'],'runtimeProjection':scenario['runtimeProjection'],'firstRefusal':scenario['firstRefusal'],'errorLines':error_lines},
        'cleanup':{'scenarioCleanup':scenario['cleanup'],'outerGateCleanup':failure_receipt['cleanup'],'firstErrorPreservedInsideAggregate':spec['arch']=='x64','epochs':scenario['epochs'],'passiveBeforeWaitRows':cleanup_rows,'controller':[r for r in raw_rows if r['row'].get('gateController')=='drained'][-1],'sourceController':[r for r in source_rows if r['row'].get('kind')=='TEST_SOURCE_CONTROLLER_EXIT' and r['row'].get('provider')==spec['provider']],'roles':'Scenario close asserts root+witness+resumed+Stop/drain/release before original witness.wait. Its stdout precedes wait; final receipt is populated after close. Outer gate cleanup records its own retained sentinel/temporary sandbox work and is not a substitute for scenario custody. Controller active0 is its own original enclosing Job accounting, not a missing per-root HANDLE proof.'},
        'limits':[
            'No source/ref/project/native/provider/CI action was performed. All executable outputs are original CI observations; this Python reader only hashes/reads stored bytes and immutable Git.',
            'Exact 578 source; old E1 unknown I386 failure is not relabeled or causally diagnosed by new observed rows. Direct I386 root late handler remains unqualified.',
            'Native Node/Electron observations and preceding Codex/Claude successes are separate bounded leaf results; whole Process job remains failed and final completed-source receipt gate was skipped.',
            'Private generated profile/peer ledgers, installed Node, compiled Host dist and native executable bytes are not all archived. Captured digests and full original build/source assertions do not constitute an independent local rebuild.',
            'Codex allocated/owned/attached without record readiness does not identify a native/catalog/protocol await. Empty first-refusal remains unknown.',
            'OpenCode currentCalls measures one retained closure across its pre-refusal invocations, not a named caller route, RPC count or per-substage timing. Different Date/performance samples are not interchangeable.',
            'OpenCode root-null unresumed slot has no original witness; cleanup failure cannot be converted into proof that a specific root is alive or absent. No Stop/drain/release oracle or timeout is relaxed.',
            'No whole migration, desktop, release, P08/P09, renderer, real-vendor or unrelated composition qualification is transferred.'
        ]}
    write_new(d/'original-windows-process-failure-audit.json', report)

