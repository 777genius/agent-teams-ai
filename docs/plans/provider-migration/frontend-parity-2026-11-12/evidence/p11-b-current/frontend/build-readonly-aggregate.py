from pathlib import Path, PurePosixPath
import collections,datetime,hashlib,json,re,stat,subprocess,zipfile

ROOT=Path('/workspace/scratch/82d3f9ba6b85');BASE=ROOT/'ci-72e6ec/frontend-all-shards';REPO=ROOT/'agent-teams-e2e'
HEAD='72e6ec04444969d343d73834c70bc4e261100fc9';E2='57885c055a18b27c180c304762643eac632513ad';RUN=43831885807
def ident(b,path=None):
 r={'bytes':len(b),'blob':hashlib.sha1(b'blob '+str(len(b)).encode()+bytes([0])+b).hexdigest(),'sha256':hashlib.sha256(b).hexdigest()}
 return {'path':str(path.relative_to(ROOT)),**r} if path is not None else r
def ref(p):return ident(p.read_bytes(),p)
def read(p):return json.loads(p.read_bytes())
def put(p,v):
 b=(v if isinstance(v,str) else json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode()
 with p.open('xb') as f:f.write(b)
 return ref(p)
def walk(v):
 if isinstance(v,dict):
  yield v
  for x in v.values():yield from walk(x)
 elif isinstance(v,list):
  for x in v:yield from walk(x)
 elif isinstance(v,str) and v[:1] in ['{','[']:
  try:parsed=json.loads(v)
  except ValueError:return
  yield from walk(parsed)
def unique(rows):
 d={json.dumps(x,sort_keys=True):x for x in rows};assert len(d)==1
 return next(iter(d.values()))
def git(args):return subprocess.check_output(['git',*args],cwd=REPO)
def noansi(s):return re.sub(r'\x1b\[[0-9;]*m','',s)

prior=read(ROOT/'ci-57885c/frontend-all-shards/aggregate-audit.json')
priorProof=read(ROOT/'ci-57885c/frontend-all-shards/byte-source-proof.json')
runPath=ROOT/'external-primary-0833/initial-api-and-fetch.json'
run=unique([v for v in walk(read(runPath)) if v.get('id')==RUN and 'run_attempt' in v])
assert run['head_sha']==HEAD and run['run_attempt']==1 and run['event']=='pull_request'
terminalPath=ROOT/'ci-72e6ec/owned-jobs-0917.json';terminal=read(terminalPath)
officialPath=ROOT/'ci-72e6ec/official-host-artifacts-0918.json';official=read(officialPath)['structuredContent']['artifacts']
commit=git(['cat-file','commit',HEAD]);assert hashlib.sha1(b'commit '+str(len(commit)).encode()+bytes([0])+commit).hexdigest()==HEAD
tree=commit.splitlines()[0].decode().split()[1];assert tree=='de80fbfbffb3fe4daabf6cc9be258cc8df534524'
originals=[];allfiles=[];skips=[];allpaths=set();totals=collections.Counter();physical=collections.Counter();models=None;originalPaths=[]
for n,jobid,aid in [(1,133178913131,14211011775),(2,133178913038,14211385485),(3,133178912777,14211070806),(4,133178913127,14212311060)]:
 b=ROOT/f'ci-72e6ec/frontend{n}';job=unique([v for v in walk(terminal) if v.get('id')==jobid and 'steps' in v])
 assert job['run_id']==RUN and job['status']=='completed' and job['conclusion']=='success'
 assert len(job['steps'])==14 and all(x['status']=='completed' and x['conclusion']=='success' for x in job['steps'])
 rawPath=b/'job.log';responsePath=b/'job-original-response.json';raw=rawPath.read_bytes()
 assert read(responsePath)['structuredContent']['content'].encode()==raw
 a=next(a for a in official if a['id']==aid);assert a['workflow_run']['id']==RUN and a['workflow_run']['head_sha']==HEAD
 zp=b/f'artifact-{aid}.zip';zb=zp.read_bytes();assert len(zb)==a['size_in_bytes'] and 'sha256:'+hashlib.sha256(zb).hexdigest()==a['digest']
 members=[]
 with zipfile.ZipFile(zp) as z:
  assert z.testzip() is None and len(z.namelist())==len(set(z.namelist()))==2
  for zi in z.infolist():
   p=PurePosixPath(zi.filename);assert not p.is_absolute() and '..' not in p.parts and '\\' not in zi.filename and not zi.is_dir() and not stat.S_ISLNK(zi.external_attr>>16)
   data=z.read(zi);ex=b/'extracted'/zi.filename;assert ex.read_bytes()==data
   members.append({'member':zi.filename,**ident(data),'crc32':f'{zi.CRC:08x}','extractedPath':str(ex.relative_to(ROOT)),'extractedFullBytesEqual':True})
 teePath=b/f'extracted/host-offline-tests-{n}.log';tee=teePath.read_bytes()
 cleanLines=[re.sub(rb'^(?:\xef\xbb\xbf)?\d{4}-\d\d-\d\dT\S+Z ',b'',line) for line in raw.splitlines(keepends=True)]
 clean=b''.join(cleanLines);assert clean.count(tee)==1
 sourceLines=[x.rstrip(b'\r\n') for x in cleanLines];teeLines=tee.splitlines()
 starts=[i for i in range(len(sourceLines)-len(teeLines)+1) if sourceLines[i:i+len(teeLines)]==teeLines];assert len(starts)==1
 jp=b/f'extracted/host-offline-tests-{n}.json';j=read(jp);counts=collections.Counter();files=collections.Counter();rows=[]
 for i,result in enumerate(j['testResults']):
  path=result['name'].removeprefix('/home/runner/work/agent-teams-ai/agent-teams-ai/')
  assert path!=result['name'] and path not in allpaths;allpaths.add(path)
  statuses=collections.Counter(x['status'] for x in result['assertionResults']);assert not(set(statuses)-{'passed','skipped'}) and sum(statuses.values())>0
  assert result['status']=='passed' and result['message']=='' and all(x.get('failureMessages',[])==[] for x in result['assertionResults'])
  counts.update(statuses);wholly=not statuses['passed'];files['skipped' if wholly else 'passed']+=1
  row={'path':path,'shard':n,'jsonTestResultIndex':i,'counts':{'passed':statuses['passed'],'skipped':statuses['skipped'],'failed':statuses['failed'],'total':sum(statuses.values())},'physicalStatus':'wholly-skipped' if wholly else 'passed','originalJsonStatus':result['status'],'startTime':result['startTime'],'endTime':result['endTime']};rows.append(row);allfiles.append(row)
  for k,x in enumerate(result['assertionResults']):
   if x['status']=='skipped':skips.append({'path':path,'shard':n,'jsonTestResultIndex':i,'assertionIndex':k,'fullName':x['fullName'],'title':x['title'],'status':'skipped'})
  if path=='test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts':
   assert models is None and n==2 and statuses=={'passed':80};models={'path':path,'shard':n,'counts':dict(statuses),'all80OriginalCases':result['assertionResults']}
 totals.update(counts);physical.update(files)
 got={'filesTotal':len(rows),'filesPassed':files['passed'],'filesWhollySkipped':files['skipped'],'assertionsTotal':sum(counts.values()),'assertionsPassed':counts['passed'],'assertionsSkipped':counts['skipped'],'assertionsFailed':counts['failed']}
 assert j['success'] and j['numTotalTests']==sum(counts.values()) and j['numPassedTests']==counts['passed'] and j['numPendingTests']==counts['skipped'] and j['numFailedTests']==j['numTodoTests']==0
 plain=noansi(tee.decode());plainRaw=noansi(clean.decode())
 fs=next(x.strip() for x in plain.splitlines() if x.strip().startswith('Test Files '));cs=next(x.strip() for x in plain.splitlines() if x.strip().startswith('Tests '))
 assert f"{files['passed']} passed" in fs and f"{counts['passed']} passed" in cs and f"{counts['skipped']} skipped" in cs
 if files['skipped']:assert f"{files['skipped']} skipped" in fs
 duration=next(x.strip() for x in plain.splitlines() if x.strip().startswith('Duration '));seconds=float(re.search(r'Duration\s+([0-9.]+)s',duration).group(1))
 for token in [HEAD,'node: v24.21.0','node: v26.12.1','using pnpm v11.22.0','RUN  v3.2.6','[better-sqlite3-node] Node ABI rebuild verified','--maxWorkers=2','--shard="$HOST_TEST_SHARD/4"',"--exclude '**/*.live.test.*'","--exclude '**/*.live-e2e.test.*'","--exclude '**/*.native.test.*'",'bash --noprofile --norc -e -o pipefail','Unsupported engine']:
  assert token in plainRaw,(n,token)
 rawMarkers=[{'line':i+1,'original':x} for i,x in enumerate(raw.decode().splitlines()) if (x.endswith('Z '+HEAD) or any(k in noansi(x) for k in ['node: v24.21.0','node: v26.12.1','[better-sqlite3-node] Node ABI rebuild verified',' RUN  v3.2.6','Test Files ','Tests ',' Duration ','Build success in','@typescript/native/bin/tsc -p tsconfig.json','Unsupported engine','JSON report written']))]
 originals.append({'shard':n,'jobId':jobid,'artifactId':aid,'officialJob':job,'officialArtifact':a,'artifactApiFile':str(officialPath.relative_to(ROOT)),'rawOriginal':ref(rawPath),'fullOriginalResponse':ref(responsePath),'fullRawEqualsMcpContent':True,'archive':ref(zp),'archiveMembers':members,'teeJoin':{'method':'Remove only GitHub timestamp prefixes; preserve ANSI/blank lines and complete original tee bytes.','rawLineStart1Based':starts[0]+1,'rawLineEnd1BasedInclusive':starts[0]+len(teeLines),'allLines':len(teeLines),'wholeByteSequenceExactOnce':True},'originalJson':ref(jp),'counts':got,'reportedJsonCounters':{k:v for k,v in j.items() if k.startswith('num')},'snapshot':j['snapshot'],'fileSummary':fs,'assertionSummary':cs,'reportedDurationLine':duration,'reportedDurationSeconds':seconds,'reportedStartTime':next(x.strip() for x in plain.splitlines() if x.strip().startswith('Start at ')),'jsonStartTime':j['startTime'],'claimBearingRawMarkers':rawMarkers})
 originalPaths.extend([rawPath,responsePath,zp,b/'archive-retention.json'])

canonical={'filesTotal':len(allfiles),'filesPassed':physical['passed'],'filesWhollySkipped':physical['skipped'],'assertionsTotal':sum(totals.values()),'assertionsPassed':totals['passed'],'assertionsSkipped':totals['skipped'],'assertionsFailed':totals['failed']}
assert canonical=={'filesTotal':2162,'filesPassed':2155,'filesWhollySkipped':7,'assertionsTotal':25870,'assertionsPassed':25832,'assertionsSkipped':38,'assertionsFailed':0}
treeRows={}
for item in git(['ls-tree','-r','-z',HEAD]).split(bytes([0])):
 if not item:continue
 meta,path=item.split(b'\t',1);mode,kind,oid=meta.decode().split();treeRows[path.decode()]={'mode':mode,'kind':kind,'blob':oid}
configured={p for p in treeRows if re.fullmatch(r'(?:test|src)/(?:.*/)?[^/]+\.test\.tsx?',p)}
excluded={p for p in configured if re.search(r'\.(?:live\.test|live-e2e\.test|native\.test)\.[^/]+$',p)}
assert len(configured)==2195 and len(excluded)==33 and configured-excluded==allpaths
paths=sorted(configured|set(priorProof['configAndClaimSourcePaths']));assert len(paths)==2213
batch=git(['cat-file','--batch']) if False else subprocess.check_output(['git','cat-file','--batch'],input=('\n'.join(HEAD+':'+p for p in paths)+'\n').encode(),cwd=REPO)
offset=0;fresh=[];bodies={};priorMap={x['path']:x for x in priorProof['allFreshGitSourceLeaves']}
for p in paths:
 end=batch.index(b'\n',offset);head=batch[offset:end].decode().split();assert len(head)==3 and head[1]=='blob'
 size=int(head[2]);data=batch[end+1:end+1+size];assert batch[end+1+size:end+2+size]==b'\n';offset=end+2+size
 row={'path':p,'mode':treeRows[p]['mode'],**ident(data)};assert row['blob']==head[0]==treeRows[p]['blob'] and row==priorMap[p]
 fresh.append(row);bodies[p]=data
assert offset==len(batch) and sum(x['bytes'] for x in fresh)==32443485
config=bodies['vitest.config.ts'].decode();workflow=bodies['.github/workflows/host-emulated-acceptance.yml'].decode();package=json.loads(bodies['package.json'])
assert "include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx']" in config
assert "environment: 'happy-dom'" in config and 'testTimeout: 15000' in config and "setupFiles: ['./test/setup.ts']" in config
assert bodies['.node-version'].decode().strip()=='26.12.1' and package['packageManager']==prior['command']['packageManager']
assert prior['command']['literal'] in workflow and 'timeout-minutes: 45' in workflow[workflow.index('  offline-frontend-tests:'):]
guardRows=[]
for row in prior['all20SkipGuardSources']:
 data=bodies[row['path']];assert all(ident(data)[k]==row[k] for k in ['bytes','blob','sha256'])
 assert data==git(['show',row['comparisonHead']+':'+row['path']])
 lines=data.decode().splitlines()
 for snip in row['guardSnippets']:assert lines[snip['line']-1]==snip['text']
 assert sum(x['path']==row['path'] for x in skips)==row['skippedAssertionCount'];guardRows.append(row)
assert len(guardRows)==20 and sum(x['skippedAssertionCount'] for x in guardRows)==38
assert collections.Counter((x['path'],x['fullName'],x['title']) for x in skips)==collections.Counter((x['path'],x['fullName'],x['title']) for x in prior['all38SkippedAssertions'])
models['source']=next(x for x in fresh if x['path']==models['path']);assert models['source']['blob']=='6c31165af5b91090fa56bc89ddd286a68f84c978'
models['hookSource']=next(x for x in fresh if x['path']=='src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts')
models['presentationSource']=next(x for x in fresh if x['path']=='src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementPresentation.ts')
assert models['hookSource']['blob']=='1176fd06b70f1b717ba83deb387f87b05b18b45b' and models['presentationSource']['blob']=='907fb16a613785324fdbd342c2993e08c8209a55'
corrections=[]
for n in [1,2]:
 b=ROOT/f'ci-72e6ec/frontend{n}';initial=b/'archive-retention.initial-metadata-only.json.txt';oldBytes=initial.read_bytes();assert oldBytes.endswith(b'\\n')
 old=json.loads(oldBytes[:-2]);current=read(b/'archive-retention.json')
 for key,path in [('raw',b/'job.log'),('response',b/'job-original-response.json'),('zip',b/f"artifact-{current['artifact']['id']}.zip")]:
  data=path.read_bytes();actual=ident(data);assert old[key]['bytes']==current[key]['bytes']==actual['bytes'] and old[key]['sha256']==current[key]['sha256']==actual['sha256']
  assert current[key]['blob']==actual['blob']
  assert old[key]['blob']==hashlib.sha1(b'blob '+str(len(data)).encode()+b'\\0'+data).hexdigest()
 for row in old['members']:
  data=(b/'extracted'/row['path']).read_bytes();assert row['bytes']==len(data) and row['sha256']==hashlib.sha256(data).hexdigest()
  now=next(x for x in current['members'] if x['path']==row['path']);assert all(now[k]==ident(data)[k] for k in ['bytes','blob','sha256'])
 corrections.append({'shard':n,'originalDerivedMetadata':ref(initial),'canonicalDerivedMetadata':ref(b/'archive-retention.json'),'unchangedOriginalBytesSha256AndLengthsVerified':True,'originalIncorrectBlobPrefix':'ASCII backslash followed by zero rather than NUL','originalInvalidFinalTerminator':'literal backslash-n rather than newline','noOriginalRawZipOrMcpMutation':True,'noRefetch':True})
 correctionPath=initial;originalPaths.append(correctionPath)
correctionId=put(BASE/'retention-metadata-provenance.json',{'kind':'DERIVED_RETENTION_METADATA_ONLY_CORRECTION','cases':corrections,'limits':'The two initial files remain preserved, but their Git blob identifiers and JSON terminators are not canonical. Original full MCP/raw/ZIP/extracted bytes and SHA256 were unchanged. No CI, project, native or test failure is invented.'})
discovery={'configIncludes':['test/**/*.test.ts','test/**/*.test.tsx','src/**/*.test.ts','src/**/*.test.tsx'],'cliExclusions':['**/*.live.test.*','**/*.live-e2e.test.*','**/*.native.test.*'],'configuredTrackedTestPathCount':2195,'excludedTrackedPathCount':33,'actualPhysicalPathCount':2162,'exactSetEquality':True,'allActualShardPathSetsDisjoint':True,'excludedSourceLeaves':[x for x in fresh if x['path'] in excluded]}
rawPaths=[runPath,terminalPath,officialPath,ROOT/'ci-72e6ec/official-host-artifacts-0902.json',ROOT/'ci-72e6ec/official-host-artifacts-0907.json',*originalPaths]
assert len(rawPaths)==len(set(rawPaths))==23
for p in rawPaths:
 if p.suffix!='.zip':assert re.search(rb'https?://[^\s"<>]*(?:[?&](?:sig|X-Amz-Signature|skoid)=)',p.read_bytes(),re.I) is None
proof={'kind':'AUTHOR_E3_COMPLETE_FOUR_FRONTEND_BYTE_SOURCE_PROOF','author':'/root/ui_failures','createdAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':HEAD,'sourceTree':tree,'commitHashRecomputed':True,'runId':RUN,'originalRunIdentity':{k:run[k] for k in ['id','head_sha','path','event','run_attempt','created_at','run_started_at','head_commit']},'runIdentityOriginal':ref(runPath),'terminalSnapshot':ref(terminalPath),'allFourOriginals':originals,'rawInputs':[ref(p) for p in rawPaths],'sourceDiscovery':discovery,'freshGitSourceLeafCount':len(fresh),'freshGitSourceBytes':sum(x['bytes'] for x in fresh),'allFreshGitSourceLeaves':fresh,'allActual2162FileResultJoins':sorted(allfiles,key=lambda r:r['path']),'all38OriginalSkippedAssertions':skips,'all20UnchangedOriginalSkipGuardSources':guardRows,'configAndClaimSourcePaths':priorProof['configAndClaimSourcePaths'],'modelsExisting80CaseBaseline':models,'retentionMetadataCorrections':correctionId,'sameSelectedBodiesAsE2ButNoHistoricalResultTransfer':True,'noProjectExecution':True,'noCiPollingOrDownloadsByThisReader':True,'originalFilesUnmodified':True}
proofId=put(BASE/'byte-source-proof.json',proof)
limits=['Original four safe frontend shards at72e6 only; no aggregate Host matrix, Desktop business UI, Team179/stderr24, P11 semanticRED, native/vendor/packaged/P08/P09/release/merge qualification.',
 'The33 CLI-excluded files and38 skipped assertions remain unqualified. Seven physical files contain only skipped assertions although original JSON testResult.status is passed; physical counts come from assertion arrays and match the default reporter. Nested JSON suite counts are separate.',
 'Frontend runnerNode26.12.1 is distinct from the separately captured TESTNode24.21.0. Original engine warnings remain; no warning-free or complete installed-dependency census is claimed.',
 'Original CI installs/prerequisite compilers and SQLite ABI verification are retained. No local build, full output manifest or full transformed-module/import/process census was performed by the author.',
 'Models80 is the actual current6c311 baseline, hook1176 and formatter907f. Later followupbfc copy67e5/1738, inert90-case Models48bf and hookfixc2faa are not qualified.',
 'P11 PhaseA is present in the current72e source under scripts, outside this configured frontend discovery; this frontend success does not execute its required original whole8 Node helper command or establish its predicted semanticRED.',
 'Only derived frontend1/2 metadata initially used incorrect Git-hash framing/JSON terminators. Its initial bytes are separately preserved; canonical metadata rehashes unchanged original MCP/raw/ZIP bytes. No source execution or test failure is inferred.',
 'No current API repoll, source/ref mutation, CI action, original replay or project/native/provider execution by this aggregate reader.']
command={**prior['command'],'sourceInputs':[next(x for x in fresh if x['path']==p) for p in priorProof['configAndClaimSourcePaths']]}
audit={'kind':'E3_72E_ORIGINAL_COMPLETE_FOUR_FRONTEND_SHARDS_AUTHOR_AGGREGATE','author':'/root/ui_failures','createdAtUTC':proof['createdAtUTC'],'sourceHead':HEAD,'sourceTree':tree,'runId':RUN,'counts':canonical,'originals':originals,'terminalSnapshot':ref(terminalPath),'initialRunSnapshot':ref(runPath),'completeByteSourceProof':proofId,'archiveCount':4,'archiveMemberCount':8,'allPhysicalPathsUnique':True,'allAssertionArraysRecounted':True,'sourceDiscovery':discovery,'command':command,'all38SkippedAssertions':skips,'all20SkipGuardSources':guardRows,'modelsBaseline':models,'retentionMetadataProvenance':correctionId,'limits':limits,'independentReviewPending':True,'projectExecutionByAuthor':False}
auditId=put(BASE/'aggregate-audit.json',audit)
table='\n'.join(f"| {o['shard']}/4 | {o['jobId']} | {o['counts']['assertionsPassed']} | {o['counts']['assertionsSkipped']} | {o['counts']['filesPassed']} | {o['counts']['filesWhollySkipped']} | {o['reportedDurationSeconds']:.2f}s |" for o in originals)
appendix=f"""### Original E3: all four safe frontend shards on72e6

All four original frontend jobs in Host run **{RUN}**, attempt1/pull_request, completed SUCCESS at exact source **{HEAD}**. This packet joins the retained run/terminal/artifact APIs, four full original MCP responses and raw job logs, four official ZIPs and their eight exact CRC-checked members. Every complete original tee is one contiguous byte sequence in the corresponding job after removing only GitHub timestamp prefixes; ANSI, blank lines and all original output are preserved. No original endpoint was fetched again for the aggregate.

| Shard | Original job | PASS assertions | SKIP assertions | PASS physical files | Wholly skipped files | Original reported duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
{table}
| **Total** | **4 original jobs** | **25,832** | **38** | **2,155** | **7** | Separate invocations |

The complete25,870 assertion arrays and2,162 distinct physical file results were recounted; there are no failed assertions. Seven wholly skipped files still carry the reporter's JSON result.status=passed. Physical passed/skipped counts therefore come from their assertion arrays and agree with the original default reporter; nested JSON suite counters are retained separately and are not file counts.

Fresh Git enumeration finds exactly2,195 configured test paths under the original four src/test include patterns. The three original CLI exclusions remove exactly33 paths; the remaining set equals all2,162 actual paths, with no missing/extra/duplicate shard file. All2,213 source/config/claim leaves were freshly hashed at this exact commit,32,443,485 bytes. The38 skipped assertions map to20 unchanged original guard source files; names, locations and guard snippets are retained. Excluded files and skipped bodies do not acquire PASS, vendor or native qualification.

The unchanged original command uses pnpm exec vitest run, maxWorkers2 per shard, shard1–4/4, all three explicit exclusions, default and JSON reporters and the original pipefail tee. The actual frontend runner is **Node26.12.1**, pnpm11.22.0 and Vitest3.2.6 with happy-dom, the existing setup file,15000ms default test timeout and45-minute job timeout. Separately captured TESTNode24.21.0 serves prerequisites; it is not relabeled as the frontend runtime. Actual install/prerequisite build and SQLite ABI verification output are preserved, including original engine warnings. No independent build, complete output/dependency inventory or complete transitive execution census is asserted.

Shard2 contains all80 original Models hook cases passing on test blob **6c31165af5b91090fa56bc89ddd286a68f84c978**, with hook **1176fd06b70f1b717ba83deb387f87b05b18b45b** and old formatter **907fb16a613785324fdbd342c2993e08c8209a55**. This is not the later followupbfc copy expectation67e5/formatter1738, inert90-case Models48bf or the unselected hook repair. Current72e does contain P11 PhaseA under scripts, outside this frontend include set. These four frontend results do not execute the required original whole8 Node-helper P11 command or establish a semantic RED for it.

Two initial frontend1/2 retention metadata files had derived Git-blob framing and literal-newline serialization errors. Their exact initial bytes remain separately retained, and a dedicated provenance record verifies canonical metadata against unchanged original raw, MCP, ZIP and extracted bytes. Original lengths and SHA-256 values were unchanged; no original CI/test outcome was altered and no endpoint was re-fetched.

This is the current source's complete safe frontend scope, awaiting separate independent R2. It does not qualify Team/static gates, all Desktop lanes, native/vendor workflows, packaged P08/P09/P11, release or merge. No source/ref/CI mutation or local project/native/provider execution was performed by this aggregate reader.
"""
appendixId=put(BASE/'Plan29-all-frontend-shards-appendix.md',appendix)
payloads=[*rawPaths,BASE/'retention-metadata-provenance.json',BASE/'byte-source-proof.json',BASE/'aggregate-audit.json',BASE/'Plan29-all-frontend-shards-appendix.md']
cp={'kind':'FROZEN_E3_COMPLETE_FOUR_FRONTEND_ORIGINALS_AUTHOR_CHECKPOINT','sourceHead':HEAD,'sourceTree':tree,'runId':RUN,'status':'AUTHOR_AUDITED_AWAITING_INDEPENDENT_R2','canonicalCounts':canonical,'payloads':[ref(p) for p in payloads],'payloadCount':len(payloads),'payloadBytes':sum(p.stat().st_size for p in payloads),'originalRawAndMetadataPayloadCount':len(rawPaths),'recoverableArchiveCount':4,'recoverableMemberCount':8,'recoverableMembers':[{'shard':o['shard'],'artifactId':o['artifactId'],'archive':o['archive'],'members':o['archiveMembers']} for o in originals],'sourceProof':proofId,'metadataCorrection':correctionId,'limits':limits,'noProjectExecutionOrNewOriginalRetrievalByReader':True}
cpId=put(BASE/'checkpoint-all-shards.json',cp)
print(json.dumps({'audit':auditId,'proof':proofId,'appendix':appendixId,'checkpoint':cpId,'counts':canonical,'payloadCount':len(payloads),'payloadBytes':cp['payloadBytes']},indent=2))
