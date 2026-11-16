import collections, datetime, hashlib, json, pathlib, re, subprocess
ROOT=pathlib.Path('/workspace/scratch/82d3f9ba6b85'); BASE=ROOT/'ci-72e6ec/taskboard'; REPO=ROOT/'agent-teams-e2e'
HEAD='72e6ec04444969d343d73834c70bc4e261100fc9'; OLD='57885c055a18b27c180c304762643eac632513ad'; RUN=43831885807; JOB=133178913159
def ident(data,path=None):
 d={'bytes':len(data),'blob':hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest(),'sha256':hashlib.sha256(data).hexdigest()}
 return {'path':str(path.relative_to(ROOT)) if isinstance(path,pathlib.Path) else path,**d} if path is not None else d
def ref(p):return ident(p.read_bytes(),p)
def read(p):return json.loads(p.read_bytes())
def git(*args):return subprocess.check_output(['git',*args],cwd=REPO)
def walk(v):
 if isinstance(v,dict):
  yield v
  for x in v.values():yield from walk(x)
 elif isinstance(v,list):
  for x in v:yield from walk(x)
 elif isinstance(v,str) and v.lstrip().startswith(('{','[')):
  try:q=json.loads(v)
  except ValueError:return
  yield from walk(q)
def unique(rows):
 u={json.dumps(r,sort_keys=True):r for r in rows};assert len(u)==1,len(u);return next(iter(u.values()))
def lines(data):return [re.sub(r'\x1b\[[0-9;]*m','',re.sub(r'^(?:\ufeff)?\d{4}-\d\d-\d\dT\S+Z ', '',l)) for l in data.decode().splitlines()]
def cases(data,total):
 ls=lines(data);si=next(i for i,l in enumerate(ls) if l==f'ℹ tests {total}');rows=[]
 for i,l in enumerate(ls[:si]):
  m=re.fullmatch(r'([✔✖]) (.+) \(([0-9.]+)ms\)',l)
  if m:rows.append({'line':i+1,'outcome':'PASS' if m[1]=='✔' else 'FAIL','name':m[2],'durationMs':float(m[3])})
 return rows,si,ls
def freeze(name,value):
 p=BASE/name;data=(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()
 with p.open('xb')as f:f.write(data)
 assert p.read_bytes()==data;return ref(p)
cp_path=BASE/'checkpoint-p11-red.json';cp=read(cp_path);a=read(BASE/'p11-semantic-red-audit.json');ap=read(BASE/'p11-byte-source-proof.json')
assert ref(cp_path)['blob']=='179f6df904447ce891d0965216870e21257bd85b'
assert ref(BASE/'p11-semantic-red-audit.json')['blob']=='5c20c2b25f44c5e04d25c9500c60191c9c061e10'
assert ref(BASE/'p11-byte-source-proof.json')['blob']=='b4afc9cc262342c97aa2f996e65b4608cd6215e3'
assert ref(BASE/'Plan29-p11-first-original-red-appendix.md')['blob']=='8a8e40286952342a60970c17f97884b3ae8dd675'
assert cp['sourceHead']==a['sourceHead']==ap['sourceHead']==HEAD and cp['jobId']==a['jobId']==ap['jobId']==JOB
payloads=[]
for e in cp['payloads']:
 x=ref(ROOT/e['path']);assert x==e;payloads.append(x)
assert len(payloads)==13 and sum(x['bytes']for x in payloads)==cp['payloadBytes']==1789700
raw=(BASE/'job.log').read_bytes();response=read(BASE/'job-original-response.json');assert response['structuredContent']['content'].encode()==raw
assert len(raw)==94289 and len(raw.splitlines())==1031
commit=git('cat-file','commit',HEAD);assert hashlib.sha1(b'commit '+str(len(commit)).encode()+b'\0'+commit).hexdigest()==HEAD
tree=commit.splitlines()[0].decode().split()[1];assert tree==ap['sourceTree']=='de80fbfbffb3fe4daabf6cc9be258cc8df534524'
initial=read(ROOT/'external-primary-0833/initial-api-and-fetch.json');run=unique([v for v in walk(initial)if v.get('id')==RUN and v.get('head_sha')==HEAD and 'event'in v]);assert run==ap['runIdentity'] and run['run_attempt']==1 and run['event']=='pull_request'
terminal=read(ROOT/'ci-72e6ec/owned-jobs-0928.json');job=unique([v for v in walk(terminal)if v.get('id')==JOB and 'steps'in v]);assert job==ap['job'] and job['run_id']==RUN and job['status']=='completed'and job['conclusion']=='failure'
steps={s['number']:s for s in job['steps']};assert all(steps[i]['conclusion']=='success'for i in range(1,8));assert steps[8]['conclusion']=='failure';assert all(steps[i]['conclusion']=='skipped'for i in range(9,31));assert steps[31]['conclusion']=='success'
rows,summary,ls=cases(raw,123);assert rows==ap['all123CaseRows'] and summary+1==ap['summaryLine'] and len(rows)==123
counts={}
for line in ls[summary:summary+8]:
 m=re.fullmatch(r'ℹ (\w+) ([0-9.]+)',line);assert m
 counts[m[1]]=float(m[2])if'.'in m[2]else int(m[2])
assert counts==ap['counts']=={'tests':123,'suites':0,'pass':120,'fail':3,'cancelled':0,'skipped':0,'todo':0,'duration_ms':9107.032314}
assert collections.Counter(r['outcome']for r in rows)=={'PASS':120,'FAIL':3}
new=[r for r in rows if r['name'].startswith('P11 ')];oldrows=[r for r in rows if not r['name'].startswith('P11 ')];assert len(new)==4 and len(oldrows)==119 and all(r['outcome']=='PASS'for r in oldrows)
historical=[]
for e in cp['supportingNameComparisonOnly']:assert ref(ROOT/e['path'])==e
oldpath=ROOT/ap['original119NameComparison']['raw']['path'];oldresponse=ROOT/ap['original119NameComparison']['response']['path'];assert read(oldresponse)['structuredContent']['content'].encode()==oldpath.read_bytes()
for p in [oldpath,ROOT/'ci-57885c/team/job.log']:
 previous,_,_=cases(p.read_bytes(),119);assert len(previous)==119
 assert [(r['name'],r['outcome'])for r in oldrows]==[(r['name'],r['outcome'])for r in previous]
 historical.append({'raw':ref(p),'all119NamesAndOrderEqual':True,'noResultTransfer':True})
failblocks=[]
for i,l in enumerate(ls):
 if l=='test at scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts:1935:4':
  block=ls[i:i+13];assert '  AssertionError [ERR_ASSERTION]: Missing expected rejection.'in block
  assert any('desktop-team-ui-smoke.test.ts:1937:3)'in x for x in block)
  assert "    operator: 'rejects',"in block;failblocks.append({'firstRawLine':i+1,'lines':block})
assert len(failblocks)==3 and sum('Missing expected rejection.'in l for l in ls)==3
assert sum('##[error]Process completed with exit code 1.'in l for l in ls)==1
for r in a['failures']:
 assert any(all(c[k]==r[k]for k in ['line','outcome','name','durationMs'])for c in new)
 assert r['laterChecksExecuted']is False and r['location'].endswith(':1937:3')
# Fresh immutable source bodies; never import or execute a project module.
source_rows=ap['sourceLeaves'];host_rows=ap['hostGitOnlyCensus']['rows'];expected={r['path']:r for r in source_rows+host_rows};assert len(source_rows)==29 and len(host_rows)==619 and len(expected)==648
batch=subprocess.run(['git','cat-file','--batch'],cwd=REPO,input=('\n'.join(HEAD+':'+p for p in expected)+'\n').encode(),capture_output=True,check=True).stdout
bodies={};observed=[];off=0
for p,r in expected.items():
 end=batch.index(b'\n',off);oid,kind,size=batch[off:end].decode().split();size=int(size);data=batch[end+1:end+1+size];assert kind=='blob'and len(data)==size and batch[end+1+size:end+2+size]==b'\n';off=end+2+size
 x=ident(data,p);assert all(x[k]==r[k]for k in ['path','bytes','blob','sha256'])and x['blob']==oid;bodies[p]=data;observed.append(x)
assert off==len(batch)
htree=git('ls-tree','-r','-z',HEAD,'--','packages/legacy-agent-host/src');assert htree==git('ls-tree','-r','-z',OLD,'--','packages/legacy-agent-host/src')
paths=[]
for line in filter(None,htree.split(b'\0')):
 meta,p=line.split(b'\t',1);mode,kind,oid=meta.decode().split()
 if p.endswith(b'.ts'):assert mode=='100644'and kind=='blob';paths.append(p.decode());assert ident(bodies[p.decode()])['blob']==oid
assert paths==[r['path']for r in host_rows]and len(paths)==619
hd=hashlib.sha256()
for p in paths:hd.update(p.removeprefix('packages/legacy-agent-host/src/').encode()+b'\0'+bodies[p]+b'\0')
assert hd.hexdigest()==ap['hostGitOnlyCensus']['digest']=='5c76bf6f2750c0070c59b8bf10db3dd83ea1a8c5c34aca5389c5c575bdc4a008'
for r in source_rows:assert (bodies[r['path']]==git('show',OLD+':'+r['path']))==r['equals578']
command=ap['literalCommand'];assert command==a['command']['literal']and command.split()==ap['argv']==a['command']['argv']and len(command.split())==10
assert ls.count(command)==1 and ls.index(command)+1==689
wf=bodies['.github/workflows/host-emulated-acceptance.yml'].decode();assert wf.splitlines()[102].strip()==command
assert "      - name: Verify original Runtime and Team conversation contracts\n        if: matrix.lane == 'team'"in wf
assert "      - name: Verify complete workspace types and original typed lint scopes\n        if: matrix.lane == 'team'"in wf
assert '          node --test test/scripts/installDependenciesWithRetry.test.mjs'in wf
install=bodies['scripts/ci/install-dependencies-with-retry.mjs'].decode();assert "const installArgs = ['install', '--frozen-lockfile', ...options];"in install
package=json.loads(bodies['package.json']);assert package['packageManager'].startswith('pnpm@11.22.0+')
assert 'node-version: 24.21.0'in wf and 'timeout-minutes: 45'in wf
for token in ['node: v24.21.0','Done in 36.6s using pnpm v11.22.0','Lockfile is up to date, resolution step is skipped','✔ Rebuild Complete','  HOST_EMULATED_LANE: taskboard','  HOST_EMULATED_PLATFORM: linux-x64']:
 assert token in ls,token
for r in ap['originalSetupBuildEvidence']:assert ls[r['line']-1]==r['text']
testpath=ap['argv'][3];test=bodies[testpath];pre=git('show',OLD+':'+testpath);assert len(pre)==111672 and test.startswith(pre)
suffix=test[len(pre):];assert len(suffix)==4264 and len(suffix.splitlines())==62 and suffix.decode()==ap['p11Source']['testSuffix']and ident(suffix)['blob']=='08699c4890b2ef83bcbda53094c450c6a9c3b366'
driverpath='scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts';driver=bodies[driverpath].decode();begin='  const poll = async <T>(';end="  const workspace = join(fixture.root, 'workspace');";assert driver.count(begin)==driver.count(end)==1
poll=driver[driver.index(begin):driver.index(end)];assert poll==ap['p11Source']['actualExtractedPoll']and ident(bodies[driverpath])['blob']=='bd8bc728808eda00a45b300fd328d49e4e919bc2'
assert test.decode().splitlines()[1936].strip().startswith('await assert.rejects(f.run(label)')and 'f.reads()'in test.decode().splitlines()[1937]
assert "const actual = stripTypeScriptTypes(source.slice(source.indexOf(begin), source.indexOf(end)))"in test.decode()
assert new[-1]['outcome']=='PASS'and new[-1]['name']=='P11 actual poll retains timely acceptance, original cadence, currentness and read-error identity'
artifact_response=read(ROOT/'ci-72e6ec/official-host-artifacts-0929.json');artifacts=[v for v in walk(artifact_response)if 'size_in_bytes'in v and 'workflow_run'in v];assert not any(v.get('name','').endswith('-taskboard')for v in artifacts)
assert any('No files were found with the provided path:'in l for l in ls)
# Preserve evidence-reader-only corrections without executing their code.
for name in ['reader-correction-provenance.json','reader-api-envelope-provenance.json']:
 provenance=read(BASE/name)
 for v in walk(provenance):
  if {'path','bytes','blob','sha256'}<=set(v):
   p=pathlib.Path(v['path']);assert all(ident(p.read_bytes())[k]==v[k]for k in ['bytes','blob','sha256'])
 assert provenance['projectOrCIRerun']is False
for e in payloads:assert ref(ROOT/e['path'])==e
assert ref(cp_path)['blob']=='179f6df904447ce891d0965216870e21257bd85b'
source_review=ROOT/'external-primary-0833/independent-incoming-p11-phase-a-source-review.json';assert ref(source_review)['blob']=='13c89fcd420f1ddbbccb13fc44c141520fe51d63'
proof={'kind':'INDEPENDENT_E3_ACTUAL_P11_RED_BYTE_SOURCE_PROOF','reviewer':'native_failures','createdAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':HEAD,'sourceTree':tree,'commitHashVerified':True,'runId':RUN,'jobId':JOB,'all13FrozenPayloads':payloads,'fullRawMcpUtf8ByteEquality':True,'rawLineCount':len(raw.splitlines()),'originalRun':run,'originalJob':job,'all123ReporterRows':rows,'summary':counts,'threeOriginalFailureBlocks':failblocks,'all119OldPassNameOrderJoins':historical,'exactCommand':command,'argv':command.split(),'fresh648GitObjects':observed,'hostGitOnly619Digest':hd.hexdigest(),'all619HostBodiesEqual578':True,'actualPoll':poll,'actual62LineSuffix':suffix.decode(),'sourceReview':ref(source_review),'authorInputPostflightAllUnchanged':True,'noOriginalTaskboardArtifact':True,'readerOnlyProvenanceRetained':True,'noProjectExecutionNetworkSourceOrCiAction':True}
proof_ref=freeze('independent-p11-red-byte-source-proof.json',proof)
report={'kind':'INDEPENDENT_FIRST_ACTUAL_E3_P11_WHOLE_EIGHT_SEMANTIC_RED_REVIEW','reviewer':'/root/native_failures','reviewedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verdict':'APPROVE actual intended three semantic REDs and retained author packet; no corrections; future PhaseB/C remains separately selected/reviewed','sourceHead':HEAD,'sourceTree':tree,'runId':RUN,'runAttempt':1,'event':'pull_request','jobId':JOB,'matrixLane':'taskboard','authorCheckpoint':ref(cp_path),'authorAudit':ref(BASE/'p11-semantic-red-audit.json'),'authorAppendix':ref(BASE/'Plan29-p11-first-original-red-appendix.md'),'independentProof':proof_ref,'payloadCount':13,'payloadBytes':sum(r['bytes']for r in payloads),'rawOriginal':ref(BASE/'job.log'),'fullMcpResponse':ref(BASE/'job-original-response.json'),'fullByteJoin':True,'actualCounts':counts,'actual123Cases':rows,'old119':{'actualCurrentPass':119,'historicalNamesAndOrderExact':historical,'fullOldTestPrefixPreserved':True,'sevenOtherTestFilesUnchanged':True,'noResultTransfer':True},'newFour':new,'actualFailureBoundary':{'registrationLine':1935,'assertRejectsLine':1937,'error':'AssertionError [ERR_ASSERTION]: Missing expected rejection.','failureCount':3,'operator':'rejects','actualValueReported':'undefined','lateTruePollResolved':True,'markersStripAndFixtureSetupReached':True,'laterReadTraceDelayAssertionsLine1938Executed':False,'timingTraceInferenceLimit':'Finite observation tables and actual source explain the accepted late true values. The later trace assertions in the three failed cases did not execute; their expected trace arrays are not independently measured successful results.'},'passedControl':{'actualPass':True,'allStraightLineAssertionsCompleted':True,'cases':['true89999','false0→true101 with original100ms timer','read Error object identity at90001','currentness Error identity before timer/second read','false90000 rejects'],'noGlobalClockMutation':True},'sourceBinding':{'test':ident(test,testpath),'driver':ident(bodies[driverpath],driverpath),'actualExtractedPoll':poll,'new62LineSuffix':ident(suffix),'freshSelectedLeaves':29,'freshHostSourceLeaves':619,'freshTotalObjects':648,'hostSourceDigest':hd.hexdigest(),'hostCensusIsGitOnly':True,'originalDesignReview':ref(source_review)},'originalCommand':a['command'],'toolchainAndBuild':{'node':'24.21.0','pnpm':'11.22.0','electron':'44.10.1','shell':'bash --noprofile --norc -e -o pipefail','jobTimeoutMinutes':45,'sourceCheckoutAndRunnerTupleStep5':'SUCCESS','installStep7':'SUCCESS','frozenLockfileRouteSourceVerified':True,'linuxExecBuilderAndLedgerHostControllerMcpBeforeTest':'Reached and returned under original set-e before test output','typescriptStripWarningRetained':True,'fullBinaryBuildOutputOrInstalledDependencyCensus':False,'sourceOnly619IsNotCapturedBuildReceipt':True,'warnings':a['setupAndBuild']['warningsRetained']},'downstream':{'installer7':'Printed next shell command, not executed after full8 exit1','team179AndStderr24':'Not executed; matrix taskboard excludes this team-only step independently of prerequisite failure','workspaceBackendTypesFast93AndTypedScopes':'Not executed; same team-only matrix guard applies','selectedInputCaptureTaskboardUi':'Not executed after prerequisite failure','uploadStep31':'Executed with no matching files; no Taskboard artifact in retained official response','receiptPngBusinessCleanupWitness':'Absent; no assertion of native action or physical cleanup'},'sourceCurrentnessLimits':['Original source72e only, including applied P11 A test and unfixed bd8 poll.','Separate bfc geometry/copy or later Models source is not qualified.','Actual RED closes this intended semantic-failure evidence gate only. No B/C source action or future GREEN is selected or performed by this review.','This finite extracted-closure result is not a90-second wall-clock UI run, complete live-membership journey, native/provider qualification or historical causal attribution.','The whole original helper command ran once in the retained original CI job. Review only reads immutable Git and retained bytes; no local project execution, refetch, replay, source/ref or CI action.'],'readerCorrectionLimits':'Two author-reader corrections are documented separately: parser bracket typo before execution, then decoding a nested original API JSON string. All13 original packet hashes remain exact; neither is treated as a project/CI failure.','allOriginalPayloadsPostflightUnchanged':True}
print(json.dumps(freeze('independent-p11-semantic-red-review.json',report),indent=2));print(json.dumps(proof_ref,indent=2))
