import collections, datetime, hashlib, json, pathlib, re, stat, subprocess, zipfile

ROOT=pathlib.Path('/workspace/scratch/82d3f9ba6b85')
BASE=ROOT/'ci-72e6ec/frontend-all-shards'
REPO=ROOT/'agent-teams-e2e'
HEAD='72e6ec04444969d343d73834c70bc4e261100fc9'
OLD='0660c748f88675063e3051fb0f8b2022e8f6f056'
RUN=43831885807

def ident(data,path=None):
    result={'bytes':len(data),'blob':hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest(),'sha256':hashlib.sha256(data).hexdigest()}
    if path is not None: result={'path':str(path.relative_to(ROOT)) if isinstance(path,pathlib.Path) else path,**result}
    return result
def ref(path):return ident(path.read_bytes(),path)
def read(path):return json.loads(path.read_bytes())
def walk(v):
    if isinstance(v,dict):
        yield v
        for x in v.values():yield from walk(x)
    elif isinstance(v,list):
        for x in v:yield from walk(x)
    elif isinstance(v,str) and v.lstrip().startswith(('{','[')):
        try: parsed=json.loads(v)
        except (ValueError,TypeError): return
        yield from walk(parsed)
def unique(rows):
    d={json.dumps(r,sort_keys=True):r for r in rows};assert len(d)==1,len(d)
    return next(iter(d.values()))
def git(args):return subprocess.check_output(['git',*args],cwd=REPO)
def freeze(path,value):
    data=(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()
    with path.open('xb') as f:f.write(data)
    assert path.read_bytes()==data
    return ref(path)
def noansi(s):return re.sub(r'\x1b\[[0-9;]*m','',s)

checkpoint_path=BASE/'checkpoint-all-shards.json';cp=read(checkpoint_path)
author=read(BASE/'aggregate-audit.json');ap=read(BASE/'byte-source-proof.json')
assert cp['sourceHead']==HEAD and cp['runId']==RUN
assert ref(checkpoint_path)['blob']=='2e967e7c5eea941d131294a925bd767fa9b6157d'
assert ref(BASE/'aggregate-audit.json')['blob']=='267be0b8a989a2e056b5f128a8bb03848924a106'
assert ref(BASE/'byte-source-proof.json')['blob']=='2d27d954b990f5a4fae52e87b7a4e24d36ef018c'
assert ref(BASE/'Plan29-all-frontend-shards-appendix.md')['blob']=='10a10047f97a2c87cbb1ff83b23229c0e33c5807'
payloads=[]
for entry in cp['payloads']:
    actual=ref(ROOT/entry['path']);assert actual==entry,(actual,entry)
    payloads.append(actual)
assert len(payloads)==27 and sum(x['bytes'] for x in payloads)==cp['payloadBytes']==5856614
commit=git(['cat-file','commit',HEAD]);assert hashlib.sha1(b'commit '+str(len(commit)).encode()+b'\0'+commit).hexdigest()==HEAD
tree=commit.splitlines()[0].decode().split()[1];assert tree==cp['sourceTree']==ap['sourceTree']=='de80fbfbffb3fe4daabf6cc9be258cc8df534524'
initial=read(ROOT/'external-primary-0833/initial-api-and-fetch.json')
run=unique([v for v in walk(initial) if v.get('id')==RUN and v.get('head_sha')==HEAD and 'event' in v])
assert {k:run[k] for k in ap['originalRunIdentity']}==ap['originalRunIdentity']
assert run['id']==RUN
assert run['head_sha']==HEAD and run['run_attempt']==1 and run['event']=='pull_request'
terminal=read(ROOT/'ci-72e6ec/owned-jobs-0917.json')
originals=[];allfiles=[];all_skips=[];all_names=set();assertions_total=collections.Counter();physical_total=collections.Counter();models=None
for n,expected in enumerate(ap['allFourOriginals'],1):
    assert expected['shard']==n
    b=ROOT/f'ci-72e6ec/frontend{n}';jobid=expected['jobId'];aid=expected['artifactId']
    job=unique([v for v in walk(terminal) if v.get('id')==jobid and 'steps' in v])
    assert job==expected['officialJob'] and job['run_id']==RUN and job['status']=='completed' and job['conclusion']=='success'
    assert len(job['steps'])==14 and all(s['status']=='completed' and s['conclusion']=='success' for s in job['steps'])
    raw=(b/'job.log').read_bytes();response=read(b/'job-original-response.json')
    assert response['structuredContent']['content'].encode()==raw
    artifact=unique([v for v in walk(read(ROOT/expected['artifactApiFile'])) if v.get('id')==aid and 'size_in_bytes' in v])
    assert artifact==expected['officialArtifact'] and artifact['workflow_run']['id']==RUN and artifact['workflow_run']['head_sha']==HEAD
    archive_path=ROOT/expected['archive']['path'];archive_bytes=archive_path.read_bytes()
    assert len(archive_bytes)==artifact['size_in_bytes'] and 'sha256:'+hashlib.sha256(archive_bytes).hexdigest()==artifact['digest']
    members=[]
    with zipfile.ZipFile(archive_path) as z:
        assert z.testzip() is None and len(z.namelist())==len(set(z.namelist()))==2
        for info in z.infolist():
            name=pathlib.PurePosixPath(info.filename)
            assert not name.is_absolute() and '..' not in name.parts and '\\' not in info.filename
            assert not info.is_dir() and not stat.S_ISLNK(info.external_attr>>16)
            data=z.read(info);ex=b/'extracted'/info.filename;assert ex.read_bytes()==data
            members.append({'member':info.filename,**ident(data),'crc32':f'{info.CRC:08x}','extractedPath':str(ex.relative_to(ROOT)),'extractedFullBytesEqual':True})
    assert members==expected['archiveMembers']
    tee_path=b/f'extracted/host-offline-tests-{n}.log';tee=tee_path.read_bytes()
    clean_lines=[re.sub(rb'^(?:\xef\xbb\xbf)?\d{4}-\d\d-\d\dT\S+Z ',b'',line) for line in raw.splitlines(keepends=True)]
    clean=b''.join(clean_lines);assert clean.count(tee)==1
    tee_lines=tee.splitlines();source_lines=[line.rstrip(b'\r\n') for line in clean_lines]
    starts=[i for i in range(len(source_lines)-len(tee_lines)+1) if source_lines[i:i+len(tee_lines)]==tee_lines]
    assert len(starts)==1 and starts[0]+1==expected['teeJoin']['rawLineStart1Based'] and starts[0]+len(tee_lines)==expected['teeJoin']['rawLineEnd1BasedInclusive']
    jpath=b/f'extracted/host-offline-tests-{n}.json';j=read(jpath)
    counts=collections.Counter();physical=collections.Counter();names=[];files=[];skips=[]
    for i,result in enumerate(j['testResults']):
        path=result['name'].removeprefix('/home/runner/work/agent-teams-ai/agent-teams-ai/')
        assert path!=result['name'] and path not in all_names;all_names.add(path);names.append(path)
        statuses=collections.Counter(x['status'] for x in result['assertionResults'])
        assert not(set(statuses)-{'passed','skipped'}) and sum(statuses.values())>0
        assert result['status']=='passed' and result['message']==''
        for x in result['assertionResults']:assert x.get('failureMessages',[])==[]
        counts.update(statuses);wholly=not statuses['passed'];physical['skipped' if wholly else 'passed']+=1
        row={'path':path,'shard':n,'jsonTestResultIndex':i,'counts':{'passed':statuses['passed'],'skipped':statuses['skipped'],'failed':statuses['failed'],'total':sum(statuses.values())},'physicalStatus':'wholly-skipped' if wholly else 'passed','originalJsonStatus':result['status'],'startTime':result['startTime'],'endTime':result['endTime']}
        files.append(row);allfiles.append(row)
        for k,x in enumerate(result['assertionResults']):
            if x['status']=='skipped':skips.append({'path':path,'shard':n,'jsonTestResultIndex':i,'assertionIndex':k,'fullName':x['fullName'],'title':x['title'],'status':'skipped'})
        if path=='test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts':
            assert models is None and n==2 and statuses=={'passed':80}
            models={'path':path,'shard':n,'jsonTestResultIndex':i,'counts':dict(statuses),'allOriginalCases':result['assertionResults']}
    all_skips+=skips;assertions_total.update(counts);physical_total.update(physical)
    got={'filesTotal':len(files),'filesPassed':physical['passed'],'filesWhollySkipped':physical['skipped'],'assertionsTotal':sum(counts.values()),'assertionsPassed':counts['passed'],'assertionsSkipped':counts['skipped'],'assertionsFailed':counts['failed']}
    assert got==expected['counts']
    assert j['numTotalTests']==sum(counts.values()) and j['numPassedTests']==counts['passed'] and j['numPendingTests']==counts['skipped'] and j['numFailedTests']==0 and j['numTodoTests']==0
    counters={k:v for k,v in j.items() if k.startswith('num')};assert counters==expected['reportedJsonCounters']
    assert j['snapshot']==expected['snapshot'] and j['success'] is True
    plain=noansi(tee.decode());plain_raw=noansi(clean.decode())
    file_summary=next(l.strip() for l in plain.splitlines() if l.strip().startswith('Test Files '))
    case_summary=next(l.strip() for l in plain.splitlines() if l.strip().startswith('Tests '))
    assert f"{physical['passed']} passed" in file_summary
    if physical['skipped']:assert f"{physical['skipped']} skipped" in file_summary
    assert f"{counts['passed']} passed" in case_summary and f"{counts['skipped']} skipped" in case_summary
    duration=next(l.strip() for l in plain.splitlines() if l.strip().startswith('Duration '));assert duration==expected['reportedDurationLine']
    assert float(re.search(r'Duration\s+([0-9.]+)s',duration).group(1))==expected['reportedDurationSeconds']
    for marker in expected['claimBearingRawMarkers']:assert raw.decode().splitlines()[marker['line']-1]==marker['original']
    for token in [HEAD,'node: v24.21.0','node: v26.12.1','using pnpm v11.22.0','RUN  v3.2.6','[better-sqlite3-node] Node ABI rebuild verified','--maxWorkers=2','--shard="$HOST_TEST_SHARD/4"',"--exclude '**/*.live.test.*'", "--exclude '**/*.live-e2e.test.*'", "--exclude '**/*.native.test.*'",'bash --noprofile --norc -e -o pipefail','Unsupported engine']:
        assert token in plain_raw,(n,token)
    originals.append({'shard':n,'jobId':jobid,'artifactId':aid,'job':job,'artifact':artifact,'raw':ref(b/'job.log'),'originalMcp':ref(b/'job-original-response.json'),'fullMcpUtf8Exact':True,'archive':ref(archive_path),'members':members,'fullTeeTimestampOnlyByteJoin':{'path':ref(tee_path),'rawStartLine':starts[0]+1,'rawEndLine':starts[0]+len(tee_lines),'lineCount':len(tee_lines),'oneContiguousWholeByteSequence':True},'originalJson':ref(jpath),'counts':got,'physicalFileSummary':file_summary,'assertionSummary':case_summary,'durationLine':duration,'durationSeconds':expected['reportedDurationSeconds'],'jsonCountersNotPhysicalFiles':counters,'snapshot':j['snapshot'],'rawMarkers':expected['claimBearingRawMarkers']})

total={'filesTotal':len(allfiles),'filesPassed':physical_total['passed'],'filesWhollySkipped':physical_total['skipped'],'assertionsTotal':sum(assertions_total.values()),'assertionsPassed':assertions_total['passed'],'assertionsSkipped':assertions_total['skipped'],'assertionsFailed':assertions_total['failed']}
assert total==cp['canonicalCounts']==author['counts']
assert total=={'filesTotal':2162,'filesPassed':2155,'filesWhollySkipped':7,'assertionsTotal':25870,'assertionsPassed':25832,'assertionsSkipped':38,'assertionsFailed':0}
assert all_skips==author['all38SkippedAssertions']==ap['all38OriginalSkippedAssertions']
assert sorted(allfiles,key=lambda r:r['path'])==ap['allActual2162FileResultJoins']
tree_rows={}
for item in git(['ls-tree','-r','-z',HEAD]).split(b'\0'):
    if not item:continue
    meta,path=item.split(b'\t',1);mode,kind,oid=meta.decode().split();tree_rows[path.decode()]={'mode':mode,'kind':kind,'blob':oid}
configured={p for p in tree_rows if re.fullmatch(r'(?:test|src)/(?:.*/)?[^/]+\.test\.tsx?',p)}
excluded={p for p in configured if re.search(r'\.(?:live\.test|live-e2e\.test|native\.test)\.[^/]+$',p)}
assert len(configured)==2195 and len(excluded)==33 and configured-excluded==all_names
assert excluded=={r['path'] for r in ap['sourceDiscovery']['excludedSourceLeaves']}
expected_leaves=ap['allFreshGitSourceLeaves'];paths=[r['path'] for r in expected_leaves]
assert len(paths)==len(set(paths))==2213 and configured.issubset(paths)
batch=subprocess.run(['git','cat-file','--batch'],input=('\n'.join(HEAD+':'+p for p in paths)+'\n').encode(),cwd=REPO,capture_output=True,check=True).stdout
offset=0;bodies={};fresh=[]
for p,exp in zip(paths,expected_leaves):
    end=batch.index(b'\n',offset);header=batch[offset:end].decode().split();assert len(header)==3 and header[1]=='blob'
    size=int(header[2]);data=batch[end+1:end+1+size];assert len(data)==size and batch[end+1+size:end+2+size]==b'\n';offset=end+2+size
    observed={'path':p,'mode':tree_rows[p]['mode'],**ident(data)}
    assert observed==exp and observed['blob']==header[0]==tree_rows[p]['blob']
    fresh.append(observed);bodies[p]=data
assert offset==len(batch) and sum(r['bytes'] for r in fresh)==32443485
config=bodies['vitest.config.ts'].decode();workflow=bodies['.github/workflows/host-emulated-acceptance.yml'].decode();package=json.loads(bodies['package.json'])
assert "include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx']" in config
assert "environment: 'happy-dom'" in config and 'testTimeout: 15000' in config and "setupFiles: ['./test/setup.ts']" in config
assert bodies['.node-version'].decode().strip()=='26.12.1' and package['packageManager']==author['command']['packageManager']
assert author['command']['literal'] in workflow and 'timeout-minutes: 45' in workflow[workflow.index('  offline-frontend-tests:'):]
assert [r['path'] for r in author['command']['sourceInputs']]==ap['configAndClaimSourcePaths']
guards=[]
for row in author['all20SkipGuardSources']:
    p=row['path'];data=bodies[p];old=git(['show',OLD+':'+p]);assert data==old
    for k in ['bytes','blob','sha256']:assert ident(data)[k]==row[k]
    lines=data.decode().splitlines()
    for snippet in row['guardSnippets']:assert lines[snippet['line']-1]==snippet['text']
    count=sum(r['path']==p for r in all_skips);assert count==row['skippedAssertionCount']
    guards.append(row)
assert len(guards)==20 and sum(g['skippedAssertionCount'] for g in guards)==38
prior_guard=ROOT/'ci-desktop-m0660/frontend-all-shards/independent-skip-source-review.json'
prior=read(prior_guard);assert prior['sourceHead']==OLD
assert {(r['path'],r['fullName']) for r in all_skips}=={(r['path'],r['fullName']) for r in prior['exactSkippedAssertions']}
assert models is not None and ident(bodies[models['path']])['blob']=='6c31165af5b91090fa56bc89ddd286a68f84c978'
models['source']=next(r for r in fresh if r['path']==models['path'])
models['hookSource']=next(r for r in fresh if r['path']=='src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts')
models['presentationSource']=next(r for r in fresh if r['path']=='src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementPresentation.ts')

metadata_provenance=read(BASE/'retention-metadata-provenance.json')
metadata_checks=[]
for correction in metadata_provenance['cases']:
    n=correction['shard'];b=ROOT/f'ci-72e6ec/frontend{n}'
    old_path=ROOT/correction['originalDerivedMetadata']['path'];new_path=ROOT/correction['canonicalDerivedMetadata']['path']
    assert ref(old_path)==correction['originalDerivedMetadata'] and ref(new_path)==correction['canonicalDerivedMetadata']
    old_bytes=old_path.read_bytes();assert old_bytes.endswith(b'\\n')
    try: json.loads(old_bytes)
    except json.JSONDecodeError: pass
    else: raise AssertionError('original metadata terminator unexpectedly valid')
    old_meta=json.loads(old_bytes[:-2]);new_meta=read(new_path)
    assert set(new_meta)==set(old_meta)|{'metadataCorrection'}
    normalized=json.loads(json.dumps(old_meta))
    for key,filename in [('raw','job.log'),('response','job-original-response.json'),('zip',f"artifact-{old_meta['artifact']['id']}.zip")]:
        data=(b/filename).read_bytes();proper=ident(data)
        wrong=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\\0'+data).hexdigest()
        assert old_meta[key]['bytes']==proper['bytes'] and old_meta[key]['sha256']==proper['sha256'] and old_meta[key]['blob']==wrong and wrong!=proper['blob']
        assert new_meta[key]==proper;normalized[key]=proper
    assert len(old_meta['members'])==len(new_meta['members'])==2
    for j,member in enumerate(old_meta['members']):
        data=(b/'extracted'/member['path']).read_bytes();proper=ident(data)
        assert member['bytes']==proper['bytes'] and member['sha256']==proper['sha256']
        assert member['blob']==hashlib.sha1(b'blob '+str(len(data)).encode()+b'\\0'+data).hexdigest()
        normalized['members'][j]['blob']=proper['blob']
    canonical_without_note={k:v for k,v in new_meta.items() if k!='metadataCorrection'}
    assert normalized==canonical_without_note
    metadata_checks.append({'shard':n,'initial':ref(old_path),'canonical':ref(new_path),'originalLiteralBackslashNVerified':True,'allFiveWrongBlobPrefixesReproduced':True,'rawMcpZipAndTwoExtractedBodiesFullShaAndLengthsSame':True,'onlyFiveBlobFieldsAndAddedExplanationChangeAfterParsingOriginalTerminator':True})
assert len(metadata_checks)==2
assert models['allOriginalCases']==author['modelsBaseline']['all80OriginalCases']
for key in ['source','hookSource','presentationSource']:assert models[key]==author['modelsBaseline'][key]
expected_recovery=[{'shard':r['shard'],'artifactId':r['artifactId'],'archive':r['archive'],'members':r['members']} for r in originals]
assert cp['recoverableMembers']==expected_recovery
assert len(all_names)==2162 and not any(p.startswith('scripts/') for p in all_names)
# A second complete read of every frozen payload protects the review's input boundary.
for entry in payloads:assert ref(ROOT/entry['path'])==entry
assert ref(checkpoint_path)['blob']=='2e967e7c5eea941d131294a925bd767fa9b6157d'

proof={'kind':'INDEPENDENT_E3_FOUR_FRONTEND_BYTE_GIT_ASSERTION_PROOF','reviewer':'native_failures','createdAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':HEAD,'sourceTree':tree,'commitBytesHashVerified':True,'all27Payloads':payloads,'allFourOriginals':originals,'allFresh2213GitLeaves':fresh,'freshGitBytes':sum(r['bytes'] for r in fresh),'all2162PhysicalFileResults':sorted(allfiles,key=lambda r:r['path']),'all38SkippedAssertions':all_skips,'all20FreshGuardSources':guards,'all33ExcludedSourcePaths':sorted(excluded),'configuredCount':len(configured),'configuredMinusActualCliExclusionsExactlyEqualsOriginalJsonFiles':True,'oldGuardAnalysisReference':ref(prior_guard),'models80ActualBaseline':models,'metadataOnlyCorrection':{'originalProvenance':ref(BASE/'retention-metadata-provenance.json'),'independentChecks':metadata_checks},'all27FrozenPayloadsPostflightUnchanged':True,'noProjectExecutionOrNetworkOrSourceMutation':True}
proof_ref=freeze(BASE/'independent-byte-source-proof.json',proof)
report={'kind':'INDEPENDENT_E3_ALL_FOUR_FRONTEND_ORIGINAL_REVIEW','reviewer':'native_failures','reviewedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verdict':'APPROVE original complete configured frontend scope on72e6; no corrections','sourceHead':HEAD,'sourceTree':tree,'runId':RUN,'originalRunAttempt':1,'originalEvent':'pull_request','authorCheckpoint':ref(checkpoint_path),'authorAudit':ref(BASE/'aggregate-audit.json'),'authorAppendix':ref(BASE/'Plan29-all-frontend-shards-appendix.md'),'independentProof':proof_ref,'metadataOnlyCorrection':{'provenance':ref(BASE/'retention-metadata-provenance.json'),'checks':metadata_checks},'originalRunIdentity':ap['originalRunIdentity'],'originalRunResponse':ref(ROOT/'external-primary-0833/initial-api-and-fetch.json'),'terminalResponse':ref(ROOT/'ci-72e6ec/owned-jobs-0917.json'),'all27PayloadBytes':sum(r['bytes'] for r in payloads),'allFourOriginalJobs':originals,'totals':total,'allOriginalResultsRecounted':True,'reportedJsonSuitesSeparate':True,'wholeSkippedFiles':[r for r in allfiles if r['physicalStatus']=='wholly-skipped'],'actualCommandAndVenue':author['command'],'exactDiscovery':{'configIncludes':ap['sourceDiscovery']['configIncludes'],'cliExclusions':ap['sourceDiscovery']['cliExclusions'],'configured2195':len(configured),'excluded33':sorted(excluded),'actual2162':len(all_names),'disjoint':True,'setEquality':True,'freshLeaves':len(fresh),'freshBytes':sum(r['bytes'] for r in fresh)},'runtime':{'actualFrontendNode':'26.12.1','separateCapturedTestNode':'24.21.0','pnpm':'11.22.0','vitest':'3.2.6','happyDom':True,'defaultTestTimeoutMs':15000,'originalJobTimeoutMinutes':45,'engineWarningsRetained':True},'skips':{'all38':all_skips,'guards20':guards,'comparisonOldHead':OLD,'all20WholeBytesEqual':True,'noSkippedCaseAcceptance':True,'vendorBoundary':'The original live Codex resolver/version and real Anthropic memory/native-inference assertion bodies are skipped. Other imported modules, registration, neighboring finite tests and prerequisites are not a complete no-vendor-process census. No real vendor execution/qualification is credited.'},'modelsBaseline':models,'limits':['Source72e6 only; no transfer to later bfc geometry/copy composition or Models afterimages. Incoming P11 PhaseA is under scripts outside this frontend command; no P11 semantic RED is established.','All four selected job results do not qualify the aggregate Host matrix or Desktop UI/native/vendor/packaged/P08/P09/release/merge.','Seven wholly skipped physical files still have original JSON result.status passed; physical counts derive from assertion arrays and match the default reporter. JSON nested suite counts are preserved separately.','The33 excluded files and38 skipped assertions remain unqualified. Original guard sources are exact; an independent complete runner-environment/import/process census is not available.','Whole original tee bytes match after timestamp-prefix removal only; ANSI bytes and blank lines are preserved.','Actual CI install/prerequisite build and SQLite ABI result are preserved; no independent build, full output manifest, complete installed-dependency or transformed-module census is claimed.','Actual frontend runtime26.12.1 differs from separately captured TEST24.21.0, and original engine warnings are retained.','Models80 is the existing baseline on6c311 with hook1176 and formatter907f; later bfc hook expectation67e5 and formatter1738, inert90-case Models48bf and hook repairc2faa are not qualified.','Only derived frontend1/2 metadata had incorrect ASCII backslash-zero Git-hash framing and a literal backslash-n JSON terminator. The old metadata remains preserved. Both exact malformed prefixes were reproduced for raw/MCP/ZIP/two members; canonical metadata changes exactly those five blob fields plus its explanation, while original bytes/lengths/SHA256 remain joined.', 'All27 frozen payloads were rehashed again before output. No original file was modified.', 'No project/test/compiler/install/native/provider execution, new download/poll, source/ref or CI mutation by this review.']}
print(json.dumps(freeze(BASE/'independent-all-frontend-review.json',report),indent=2))
print(json.dumps(proof_ref,indent=2))
