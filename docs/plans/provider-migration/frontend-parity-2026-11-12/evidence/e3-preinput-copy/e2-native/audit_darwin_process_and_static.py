"""Audit already captured bytes only; no project command is invoked."""
import datetime
import json
import pathlib
import re
import stat
import zipfile
from audit_v2_originals import ROOT, BASE, HEAD, E1, ref, read_json, source, git_bytes, identity, normalized_lines, log_facts


def freeze(path, value):
    data = (json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode()
    with path.open('xb') as f:
        f.write(data)
    print(json.dumps(identity(data,path),ensure_ascii=False))


def line_refs(lines, predicate):
    return [{'line':i+1,'text':l} for i,l in enumerate(lines) if predicate(l)]


def full_log(folder, job_id):
    raw_path = folder/f'job-{job_id}.log'
    response_path = folder/f'original-job-{job_id}-response.json'
    raw = raw_path.read_bytes()
    assert read_json(response_path)['structuredContent']['content'].encode('utf-8') == raw
    facts, lines = log_facts(raw)
    facts.update({'fullLog':ref(raw_path),'originalMCPResponse':ref(response_path),'fullResponseUtf8ByteJoin':True})
    return facts, lines


def zip_and_tees(folder, artifact_id, artifact, full_lines):
    p = folder/f'artifact-{artifact_id}.zip'
    r = ref(p)
    assert r['bytes'] == artifact['size_in_bytes'] and 'sha256:'+r['sha256'] == artifact['digest']
    retention = read_json(folder/'archive-retention.json')
    members, tees = [], []
    with zipfile.ZipFile(p) as z:
        assert z.testzip() is None and len(z.namelist()) == len(set(z.namelist())) == 6
        for item in z.infolist():
            relative = pathlib.PurePosixPath(item.filename)
            assert not relative.is_absolute() and '..' not in relative.parts and '\\' not in item.filename
            assert not stat.S_ISLNK(item.external_attr>>16)
            data = z.read(item)
            extracted = folder/'extracted'/item.filename
            assert extracted.read_bytes() == data
            rr = identity(data,item.filename)
            old = next(x for x in retention['members'] if x.get('path',x.get('member')) == item.filename)
            assert rr['sha256'] == old['sha256'] and rr['bytes'] == old['bytes']
            members.append({**rr,'crc32':f'{item.CRC:08x}','extracted':str(extracted.relative_to(ROOT))})
            if item.filename.endswith('.log'):
                tee = normalized_lines(data)
                hits = [i for i in range(len(full_lines)-len(tee)+1) if full_lines[i:i+len(tee)] == tee]
                assert len(hits) == 1, (item.filename, len(hits))
                tees.append({'member':item.filename,'lines':len(tee),'fullJobFirstLine':hits[0]+1,'fullJobLastLine':hits[0]+len(tee),'wholeContiguousJoin':True,'transform':'UTF8 BOM and line-ending normalization; remove only timestamp prefix from full job and ANSI SGR from both sides. Original raw bytes remain separately retained.'})
    assert len(tees)==4
    return {'archive':r,'originalRetention':ref(folder/'archive-retention.json'),'safeUniqueNonsymlinkCRC':True,'members':members,'originalFourTeeJoins':tees}


old_darwin = read_json(ROOT/'native-audit-E1e1d14b/process-darwin-arm64-qualification-audit.json')
old_root = read_json(ROOT/'native-audit-E1e1d14b/process-darwin-x64-failure-audit.json')
darwin_paths = list(dict.fromkeys([r['path'] for r in old_root['sourceAndCommands']['sourcePins']] + [r['path'] for r in old_darwin['selectedInterpretationGitSources']]))
darwin_sources = [source(p) for p in darwin_paths]
assert [s['path'] for s in darwin_sources if not s['sameBytesAsE1']] == ['test/features/agent-backend/capturedHostClient.test.ts']
jobs_path = BASE/'owned-process-jobs-response-0802.json'
artifacts_path = BASE/'official-process-artifacts-0746.json'
for directory, job_id, artifact_id, platform in [('process-darwin-x64',133150850618,14205659983,'darwin-x64'),('process-darwin-arm64',133150850917,14206855210,'darwin-arm64')]:
    folder=BASE/directory
    existing=folder/'original-darwin-process-audit.json'
    if existing.exists():
        previous=read_json(existing)
        assert previous['sourceHead']==HEAD and previous['jobId']==job_id
        print(json.dumps({'preservedPreviouslyFrozen':ref(existing)},ensure_ascii=False))
        continue
    job = next(j for j in read_json(jobs_path)['structuredContent']['jobs'] if j['id']==job_id)
    assert job['status']=='completed' and job['conclusion']=='success' and job['run_id']==43823212637
    artifact = next(a for a in read_json(artifacts_path)['structuredContent']['artifacts'] if a['id']==artifact_id)
    assert artifact['workflow_run']['head_sha']==HEAD and artifact['workflow_run']['id']==43823212637
    original, lines=full_log(folder,job_id)
    archive=zip_and_tees(folder,artifact_id,artifact,lines)
    scope_path=next((folder/'extracted').rglob('scope.json'))
    scope=read_json(scope_path)
    head_path=next((folder/'extracted').rglob('source-head.txt'))
    assert head_path.read_text().strip()==HEAD
    assert scope['sourceHead']==HEAD and scope['platform']==platform and scope['nodeVersion']=='v24.21.0' and scope['status']=='PASS'
    assert scope['native']==[] and scope['controlledContracts'] is True and scope['retainedMainTransport'] is True and scope['posixProcessGroups'] is True
    for key in ['nativeProviderRuntimeQualified','darwinNativeRegistrationQualified','posixExecutableAdmissionQualified','desktopQualified','releaseQualified']:
        assert scope[key] is False
    assert [(b['tests'],b['pass'],b['fail'],b['skipped']) for b in original['reporterBlocks']]==[(167,165,0,2),(27,27,0,0)]
    vitest=line_refs(lines,lambda l:re.fullmatch(r'\s*Tests\s+(54|81) passed \((54|81)\)',l) is not None)
    assert len(vitest)==2
    literal_commands=line_refs(lines,lambda l:l.startswith('node ') and ('--test ' in l or 'vitest.mjs run ' in l or 'tsc ' in l or 'build.mjs' in l))
    host_command=next(x['text'] for x in literal_commands if 'tee process-acceptance-evidence/host-contracts.log' in x['text'])
    main_command=next(x['text'] for x in literal_commands if 'tee process-acceptance-evidence/retained-main.log' in x['text'])
    posix_command=next(x['text'] for x in literal_commands if 'tee process-acceptance-evidence/posix-lifecycle.log' in x['text'])
    assert len(re.findall(r'\S+\.test\.ts',host_command))==18 and len(re.findall(r'\S+\.test\.ts',main_command))==8 and len(re.findall(r'\S+\.test\.ts',posix_command))==2
    posix=next((folder/'extracted').rglob('posix-lifecycle.log'))
    diagnostics=[]
    for row in normalized_lines(posix.read_bytes()):
        if row.startswith('ℹ {'):
            diagnostics.append(json.loads(row[2:]))
    assert diagnostics==[{'cleanupConfirmed':True,'descendantAbsent':True,'neighborPreserved':True},{'cleanupConfirmed':False,'descendantAbsent':True,'neighborPreserved':True}]
    main=next((folder/'extracted').rglob('retained-main.log'))
    main_lines=normalized_lines(main.read_bytes())
    pressure_rows=[l for l in main_lines if 'holds Main reply bytes before native effect' in l]
    assert len(pressure_rows)==2 and all('✓' in l for l in pressure_rows)
    out={'kind':'AUTHOR_READ_ONLY_E2_DARWIN_PROCESS_ORIGINAL_AUDIT','auditedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':HEAD,'runId':43823212637,'jobId':job_id,
         'job':job,'jobsResponse':ref(jobs_path),'artifactMetadataResponse':ref(artifacts_path),'officialArtifact':artifact,**original,**archive,
         'scopeFile':ref(scope_path),'scope':scope,'sourceHeadFile':ref(head_path),'sourceLeaves':darwin_sources,'sourceCount':len(darwin_sources),
         'literalOriginalCommands':literal_commands,'commandComposition':{'hostFiles':18,'protocolVitestFiles':3,'retainedMainFiles':8,'POSIXFiles':2},
         'vitestReporterRows':vitest,'totalObservedAssertions':{'pass':327,'fail':0,'skip':2,'cancel':0},'actualMainPressureCases':pressure_rows,
         'physicalNegativeDiagnostics':diagnostics,'physicalSemantics':old_darwin['physicalSemantics'],'providerNameLimits':old_darwin['providerNameLimits'],
         'limits':['Actual source578 SUCCESS is separate from earlier sourceE1 failure. The only changed selected interpretation leaf adds a closed reply-status diagnostic to an existing rejection; the optional pre-schema20ms pressure request and original Main gate remain unchanged. Neither this success nor new source proves old failure cause or qualifies the separate unselected Main-cap proposal.',
                   '18-file Host contracts include finite TEST peers and mocked ownership cases. The original POSIX lane runs two source files, not a real vendor CLI/version acceptance.',
                   'Original native array is empty; no Darwin native registered execution/P09, Desktop, installed product, vendor or release qualification.',
                   'Source-selected constructor/cleanup semantics and original actual test assertions are retained. A diagnostic cleanupConfirmed:false is the deliberately earlier observation before subsequent original marker/reap/ESRCH assertions, not a failed final-cleanup aggregate.',
                   'No source/test/compiler/native/provider/CI action by auditor. Full original logs, four tees and six ZIP members are byte joined.']}
    freeze(folder/'original-darwin-process-audit.json',out)


folder=BASE/'static-windows'
job_id=133150849402
v2_jobs=BASE/'owned-v2-jobs-response-0802.json'
job=next(j for j in read_json(v2_jobs)['structuredContent']['jobs'] if j['id']==job_id)
assert job['status']=='completed' and job['conclusion']=='success' and job['run_id']==43823212364
original, lines=full_log(folder,job_id)
assert [(b['tests'],b['pass'],b['fail'],b['skipped']) for b in original['reporterBlocks']]==[(7,7,0,0),(41,41,0,0),(225,224,0,1)]
vitest=line_refs(lines,lambda l:re.fullmatch(r'\s*Tests\s+189 passed \(189\)',l) is not None)
assert len(vitest)==1
skip=line_refs(lines,lambda l:l.startswith('﹣ ') and 'POSIX FIFO only' in l)
assert len(skip)==1
old_static=read_json(ROOT/'native-audit-E1e1d14b/static-windows-qualification-audit.json')
static_sources=[source(r['path']) for r in old_static['freshGitClaimInputs']]
assert all(s['sameBytesAsE1'] for s in static_sources)
assert "if (process.platform === 'win32') { t.skip('POSIX FIFO only'); return; }" in git_bytes('packages/legacy-agent-host/tests/opencode-v2-static-preflight.test.ts').decode()
main_command_index=next(i for i,l in enumerate(lines) if l=='##[group]Run git -C .current-product-lock rev-parse HEAD')
main_hashes=[l for l in lines[main_command_index+1:main_command_index+15] if re.fullmatch(r'[a-f0-9]{40}',l)]
assert len(main_hashes)==1
live_lock_rows=line_refs(lines,lambda l:l.startswith('✔ ') and 'current-main live checkout never inherits a TEST-only historical candidate' in l)
assert len(live_lock_rows)==1
assert any(l=='node: v24.21.0' for l in lines)
assert any('Done in' in l and 'using pnpm v11.22.0' in l for l in lines)
build_steps=[s for s in job['steps'] if s['name'] in ['Build Stage1 Host without launching providers','Typecheck Host TEST contracts']]
assert len(build_steps)==2 and all(s['conclusion']=='success' for s in build_steps)
out={'kind':'AUTHOR_READ_ONLY_E2_STATIC_WINDOWS_ORIGINAL_AUDIT','auditedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':HEAD,'runId':43823212364,'jobId':job_id,'job':job,'jobsResponse':ref(v2_jobs),**original,
     'sourceLeaves':static_sources,'freshGitClaimInputCount':len(static_sources),'hostSourceCensus':ref(BASE/'host-source-E2-git-audit.json'),'hostSourceFiles':619,
     'vitestReporterRows':vitest,'totalObservedAssertions':{'pass':461,'fail':0,'skip':1,'cancel':0},'skip':{'actualRows':skip,'sourcePath':'packages/legacy-agent-host/tests/opencode-v2-static-preflight.test.ts','guard':"if (process.platform === 'win32') { t.skip('POSIX FIFO only'); return; }"},
     'actualRuntime':{'node':'v24.21.0','pnpm':'11.22.0','profile':'node-ci','electronSkipBinaryDownload':'1','originalInstallOnly':True},
     'currentProductLock':{'separateCheckout':'.current-product-lock','requestedRef':'main','observedCommit':main_hashes[0],'actualCase':live_lock_rows,'limit':'Separate moving main checkout is observed from original log; no independent byte reconstruction of its runtime.lock.json and no conflation with source578.'},
     'buildAndTypes':{'actualApiSteps':build_steps,'HostBuildBody':'node node_modules/@typescript/native/bin/tsc -p tsconfig.json','HostTestTypecheckBody':'node node_modules/@typescript/native/bin/tsc -p tsconfig.test.json','limit':'Original CI success only;619-source inventory is not a full emitted-output/installed-dependency byte census.'},
     'qualificationLimits':old_static['qualificationLimits']}
freeze(folder/'original-static-windows-audit.json',out)
