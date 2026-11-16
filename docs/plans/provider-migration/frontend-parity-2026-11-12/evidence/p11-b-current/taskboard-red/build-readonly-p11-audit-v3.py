from pathlib import Path
import json,hashlib,subprocess,re,collections,datetime
ROOT=Path('/workspace/scratch/82d3f9ba6b85'); REPO=ROOT/'agent-teams-e2e'; D=ROOT/'ci-72e6ec/taskboard'
HEAD='72e6ec04444969d343d73834c70bc4e261100fc9'; OLD='57885c055a18b27c180c304762643eac632513ad'
def ident(b): return {'bytes':len(b),'blob':hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest(),'sha256':hashlib.sha256(b).hexdigest()}
def fi(p): return {'path':str(p.relative_to(ROOT)),**ident(p.read_bytes())}
def load(p): return json.loads(p.read_text())
def git(*args): return subprocess.check_output(['git',*args],cwd=REPO)
def walk(x):
 if isinstance(x,dict):
  yield x
  for v in x.values(): yield from walk(v)
 elif isinstance(x,list):
  for v in x: yield from walk(v)
 elif isinstance(x,str) and x[:1] in ('{','['):
  try: decoded=json.loads(x)
  except (ValueError,TypeError): return
  yield from walk(decoded)
def plain(b): return [re.sub(r'\x1b\[[0-9;]*m','',re.sub(r'^\d{4}-\d\d-\d\dT\S+Z ','',x)) for x in b.decode('utf-8-sig').splitlines()]
def first_report(b):
 ls=plain(b); end=next(i for i,l in enumerate(ls) if l.startswith('ℹ tests ')); vals={}
 for l in ls[end:end+8]:
  m=re.fullmatch(r'ℹ (\S+) ([0-9.]+)',l); assert m,l
  vals[m[1]]=float(m[2]) if '.' in m[2] else int(m[2])
 rows=[]
 for i,l in enumerate(ls[:end]):
  m=re.fullmatch(r'([✔✖]) (.*) \(([0-9.]+)ms\)',l)
  if m: rows.append({'line':i+1,'outcome':'PASS' if m[1]=='✔' else 'FAIL','name':m[2],'durationMs':float(m[3])})
 return vals,rows,end+1
raw=(D/'job.log').read_bytes(); response=load(D/'job-original-response.json')
assert response['structuredContent']['content'].encode()==raw and not response.get('isError',False)
assert ident(raw)['blob']=='4f7af0d5218f6c2b34457e63a4dcce05f4f2ce84'
snapshot=ROOT/'ci-72e6ec/owned-jobs-0928.json'; snap=load(snapshot)
job=next(x for r in snap['reads'] if r['lane']=='host' for x in r['response']['structuredContent']['jobs'] if x['id']==133178913159)
assert job['run_id']==43831885807 and job['status']=='completed' and job['conclusion']=='failure'
steps={x['number']:x for x in job['steps']}; assert steps[8]['conclusion']=='failure'
assert all(steps[n]['conclusion']=='success' for n in range(1,8))
assert all(steps[n]['conclusion']=='skipped' for n in range(9,31)); assert steps[31]['conclusion']=='success'
initial=ROOT/'external-primary-0833/initial-api-and-fetch.json'
runs=[x for x in walk(load(initial)) if x.get('id')==43831885807 and 'head_sha' in x]
assert runs and all(x['head_sha']==HEAD and x['run_attempt']==1 and x['event']=='pull_request' for x in runs)
artpath=ROOT/'ci-72e6ec/official-host-artifacts-0929.json'; arts=load(artpath)['structuredContent']['artifacts']
assert not any('taskboard' in x['name'] for x in arts)
ls=plain(raw); assert 'node: v24.21.0' in ls
assert any('No files were found with the provided path:' in l for l in ls)
assert any('Lockfile is up to date, resolution step is skipped' in l for l in ls)
assert 'Done in 36.6s using pnpm v11.22.0' in ls
assert '✔ Rebuild Complete' in ls
command=next(l for l in ls if l.startswith('node --test scripts/legacy-agent-host/desktop-backend-observations.test.ts'))
argv=command.split(); assert argv[:2]==['node','--test'] and len(argv)==10
assert len(set(argv[2:]))==8
counts,rows,summary_line=first_report(raw)
assert counts=={'tests':123,'suites':0,'pass':120,'fail':3,'cancelled':0,'skipped':0,'todo':0,'duration_ms':9107.032314}
assert len(rows)==123 and collections.Counter(x['outcome'] for x in rows)=={'PASS':120,'FAIL':3}
control='P11 actual poll retains timely acceptance, original cadence, currentness and read-error identity'
failed=[x for x in rows if x['outcome']=='FAIL']; assert len(failed)==3
assert [x['name'] for x in failed]==['P11 keeps the original 90-second cutoff for '+x for x in ['first result at the exact cutoff','first result after the cutoff','polled result after the cutoff']]
assert next(x for x in rows if x['name']==control)['outcome']=='PASS'
assert sum('Missing expected rejection.' in l for l in ls)==3
assert sum('desktop-team-ui-smoke.test.ts:1937:3)' in l for l in ls)==3
oldraw=ROOT/'ci-57885c/taskboard/job.log'; oldmcp=ROOT/'ci-57885c/taskboard/job-original-response.json'
assert load(oldmcp)['structuredContent']['content'].encode()==oldraw.read_bytes()
oldcounts,oldrows,_=first_report(oldraw.read_bytes()); assert oldcounts['tests']==oldcounts['pass']==119 and oldcounts['fail']==oldcounts['skipped']==0
assert collections.Counter(x['name'] for x in rows if x['outcome']=='PASS' and x['name']!=control)==collections.Counter(x['name'] for x in oldrows)
paths=argv[2:]+['scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts','scripts/legacy-agent-host/desktop-ui-controls.ts','.github/workflows/host-emulated-acceptance.yml','scripts/ci/install-dependencies-with-retry.mjs','scripts/ensure-electron-install.cjs','scripts/build/buildLinuxNodeExec.mjs','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','.node-version','packages/legacy-agent-host/package.json','packages/legacy-agent-host/tsconfig.json','packages/task-change-ledger/package.json','packages/task-change-ledger/tsconfig.json','agent-teams-controller/package.json','agent-teams-controller/scripts/build.mjs','mcp-server/package.json','mcp-server/tsup.config.ts','vendor/provider-migration/host-logs-thinking-9423f600/agent-teams-provider-implementations-0.0.0.tgz','vendor/provider-migration/host-logs-thinking-9423f600/agent-teams-provider-session-contracts-0.0.0.tgz']
contents={}; source=[]
for p in paths:
 b=git('show',HEAD+':'+p); contents[p]=b
 source.append({'path':p,**ident(b),'equals578':git('rev-parse',OLD+':'+p).decode().strip()==ident(b)['blob']})
test=contents['scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts']; pre=git('show',OLD+':scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts')
assert test.startswith(pre) and len(test.splitlines())-len(pre.splitlines())==62
assert ident(test)['blob']=='3c2548f7ede3f799a6426c81bb178e4895c790c2'
driver=contents['scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts']; assert ident(driver)['blob']=='bd8bc728808eda00a45b300fd328d49e4e919bc2'
assert driver==git('show',OLD+':scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts')
assert command in contents['.github/workflows/host-emulated-acceptance.yml'].decode()
assert "const installArgs = ['install', '--frozen-lockfile', ...options];" in contents['scripts/ci/install-dependencies-with-retry.mjs'].decode()
for p in argv[2:]:
 if p!='scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts': assert contents[p]==git('show',OLD+':'+p)
tree=git('ls-tree','-r','-z',HEAD,'--','packages/legacy-agent-host/src'); host=[]
for line in filter(None,tree.split(b'\0')):
 mode,typ,tail=line.split(b' ',2); oid,p=tail.split(b'\t',1)
 if p.endswith(b'.ts'):
  assert mode==b'100644' and typ==b'blob';host.append((p.decode(),oid.decode()))
assert len(host)==619
data=subprocess.run(['git','cat-file','--batch'],cwd=REPO,input=''.join(oid+'\n' for _,oid in host).encode(),capture_output=True,check=True).stdout
offset=0;h=hashlib.sha256();hostrows=[]
for p,oid in host:
 end=data.index(b'\n',offset); got,typ,n=data[offset:end].split();n=int(n);b=data[end+1:end+1+n];assert got.decode()==oid and typ==b'blob' and data[end+1+n:end+2+n]==b'\n';offset=end+2+n
 assert ident(b)['blob']==oid;h.update(p.removeprefix('packages/legacy-agent-host/src/').encode()+b'\0'+b+b'\0');hostrows.append({'path':p,**ident(b)})
assert offset==len(data)
assert tree==git('ls-tree','-r','-z',OLD,'--','packages/legacy-agent-host/src')
extract_begin='  const poll = async <T>(';extract_end="  const workspace = join(fixture.root, 'workspace');"
s=driver.decode();assert s.count(extract_begin)==s.count(extract_end)==1
actual=s[s.index(extract_begin):s.index(extract_end)]
evidence=[{'line':i+1,'text':l} for i,l in enumerate(ls) if any(x in l for x in ['node: v24.21.0','HEAD is now at 72e6ec0','HOST_EMULATED_SOURCE_HEAD:','HOST_EMULATED_LANE:','HOST_EMULATED_PLATFORM:','Lockfile is up to date','Done in 36.6s using pnpm','✔ Rebuild Complete','$ pnpm --filter @agent-teams/task-change-ledger build','$ node node_modules/@typescript/native/bin/tsc -p tsconfig.json','$ node ./scripts/build.mjs','$ tsup','DTS Build success','ESM Build success','No files were found','##[error]Process completed with exit code 1.'])]
proof={'kind':'E3_TASKBOARD_ORIGINAL_P11_RED_AUTHOR_BYTE_SOURCE_PROOF','createdAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':HEAD,'sourceTree':git('rev-parse',HEAD+'^{tree}').decode().strip(),'runId':43831885807,'jobId':job['id'],'references':[fi(D/'job.log'),fi(D/'job-original-response.json'),fi(snapshot),fi(artpath),fi(initial)],'originalMcpRawExact':True,'runIdentity':runs[0],'job':job,'literalCommand':command,'argv':argv,'cwdFromRaw':'/home/runner/work/agent-teams-ai/agent-teams-ai','counts':counts,'all123CaseRows':rows,'summaryLine':summary_line,'original119NameComparison':{'raw':fi(oldraw),'response':fi(oldmcp),'same119NameMultiset':True,'qualificationTransfer':False},'sourceLeaves':source,'p11Source':{'fullOldTestPrefixPreserved':True,'newLines':62,'actualExtractedPoll':actual,'actualDriverBlob':ident(driver)['blob'],'testSuffix':test[len(pre):].decode()},'hostGitOnlyCensus':{'files':619,'digest':h.hexdigest(),'rows':hostrows,'sameGitBodiesAs578':True,'limit':'Immutable Git source only. This failed prerequisite lane did not reach capture/receipt/output-digest steps; no archived Host dist or complete installed payload inventory is inferred.'},'originalSetupBuildEvidence':evidence,'noTaskboardArtifactInRetainedOfficialResponse':True,'noProjectExecutionByReader':True}
f=D/'p11-byte-source-proof.json';assert not f.exists();f.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
audit={'kind':'AUTHOR_E3_ORIGINAL_WHOLE_EIGHT_P11_SEMANTIC_RED','createdAtUTC':proof['createdAtUTC'],'sourceHead':HEAD,'runId':43831885807,'jobId':job['id'],'proof':fi(f),'originals':proof['references'],'outcome':{'job':'FAILURE','step':8,'commandExit':1,'tests':123,'pass':120,'fail':3,'skip':0,'cancelled':0,'originalOldCasesPassed':119,'newDeadlineCasesFailed':3,'newControlPassed':1},'command':{'literal':command,'argv':argv,'focusFilter':None,'concurrencyFlagAdded':False,'originalMatrixLane':'taskboard','nodeVersion':'24.21.0','pnpmVersion':'11.22.0','elapsedReporterMs':counts['duration_ms']},'failures':[dict(x,assertion='Missing expected rejection.',location='scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts:1937:3',laterChecksExecuted=False) for x in failed],'meaning':'Each failure occurs at assert.rejects after the actual extracted original poll resolved on a late true observation. The source extractor/setup succeeded; the post-assertion per-case read/trace/delay checks were not reached. This is a finite source-closure semantic counterexample, not an actual 90-second wall-clock Desktop run.','positiveControl':{'passed':True,'cases':['first true at89999ms','false then timely true with100ms cadence','same original read Error object','same currentness Error object','first false at cutoff rejects'],'scope':'All straight-line assertions in this one successful original control case completed.'},'source':{'test':next(x for x in source if x['path'].endswith('/desktop-team-ui-smoke.test.ts')),'driver':next(x for x in source if x['path'].endswith('/desktop-live-membership-ui-smoke.ts')),'full578TestPrefixExact':True,'allSevenOtherHelperFilesExact578':True,'current72Only':True,'followupBfcGeometryCopyNotQualified':True},'setupAndBuild':{'checkoutAndTupleStep5':'SUCCESS','frozenWorkspaceElectronStep7':'SUCCESS','originalLinuxExecHostLedgerControllerMcpCommandsReachedBeforeTests':True,'sameStepBuildCommandsReturnedUnderSetE':True,'warningsRetained':['pnpm v10 layout warning','two pre-build missing legacy-agent-host dist/cli.js bin warnings','native-addon deprecation/cast warnings','experimental TypeScript strip warning'],'limits':'Original CI build output is retained; this is not an independent rebuild, binary hash qualification or installed payload census. Both pre-build bin warnings precede the successful Host build and the actual test run.'},'downstream':{'installerHelper7':'NOT RUN after set-e stopped at whole8','teamWhole10_179AndStderr24':'NOT RUN; lane=taskboard and step9 SKIPPED','workspaceBackendTypesFast93TypedScopes':'NOT RUN; step10 SKIPPED','inputCaptureDesktopTaskboardNativeUI':'NOT RUN; steps11 through30 SKIPPED','archive':'No Taskboard artifact in retained official response; original upload step31 reports no files. No receipt, PNG, action or cleanup witness is invented.'},'limits':['No Team/static/renderer/native/Desktop/P11 end-to-end PASS is inferred.','No future PhaseB/C or ModelsA selection/application is made.','Source head72 remains distinct from unpublished-to-primary followup geometry/copy bytes.','All observations are original CI; evidence reader only reads stored bytes and Git and performs no local project/test/provider/install/CI operation.']}
f=D/'p11-semantic-red-audit.json';assert not f.exists();f.write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'proof':fi(D/'p11-byte-source-proof.json'),'audit':fi(f),'sourceLeaves':len(source),'hostSourceFiles':len(hostrows),'hostDigest':h.hexdigest()},indent=2))
