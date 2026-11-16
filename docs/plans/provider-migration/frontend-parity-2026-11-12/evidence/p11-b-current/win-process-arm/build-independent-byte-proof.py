from pathlib import Path,PurePosixPath
import json,hashlib,subprocess,zipfile,stat,re,collections,datetime
ROOT=Path('/workspace/scratch/82d3f9ba6b85'); REPO=ROOT/'agent-teams-e2e'; D=ROOT/'ci-72e6ec/native/process-windows-arm64'
HEAD='72e6ec04444969d343d73834c70bc4e261100fc9'; OLD='57885c055a18b27c180c304762643eac632513ad'
def ident(b):return {'bytes':len(b),'blob':hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest(),'sha256':hashlib.sha256(b).hexdigest()}
def fi(p):return {'path':str(p.relative_to(ROOT)),**ident(p.read_bytes())}
def load(p):return json.loads(p.read_text())
def git(*args):return subprocess.check_output(['git',*args],cwd=REPO)
def checkref(x):
 i=fi(ROOT/x['path']);assert all(i[k]==x[k] for k in ['bytes','blob','sha256']),x['path'];return i
def walk(x):
 if isinstance(x,dict):
  yield x
  for v in x.values():yield from walk(v)
 elif isinstance(x,list):
  for v in x:yield from walk(v)
 elif isinstance(x,str) and x[:1] in ('{','['):
  try: decoded=json.loads(x)
  except (ValueError,TypeError):return
  yield from walk(decoded)
def normalized(b,ansi=False,timestamp=False):
 ls=b.decode('utf-8-sig').splitlines()
 if timestamp:ls=[re.sub(r'^\d{4}-\d\d-\d\dT\S+Z ','',l) for l in ls]
 if ansi:ls=[re.sub(r'\x1b\[[0-9;]*m','',l) for l in ls]
 return ls
def jsonlines(b):
 out=[]
 for i,l in enumerate(normalized(b,ansi=True),1):
  try:x=json.loads(l)
  except ValueError:continue
  if isinstance(x,dict):out.append({'line':i,'row':x})
 return out
audit=load(D/'original-windows-process-failure-audit.json'); assert fi(D/'original-windows-process-failure-audit.json')['blob']=='c98da825d0140ec8695a2376b9ffb30ec798ed13'
assessment_path=ROOT/'ci-72e6ec/native/windows-first-refusal-source-assessment.json'; assessment=load(assessment_path)
refs=[fi(D/'original-windows-process-failure-audit.json'),fi(assessment_path),fi(D/'archive-retention.json'),checkref(audit['hostSourceCensus'])]
inputs=audit['originalInputs']
for k in ['jobAPI','artifactAPI','fullResponse','fullRawLog','archive']:refs.append(checkref(inputs[k]))
initial=ROOT/'external-primary-0833/initial-api-and-fetch.json';refs.append(fi(initial))
run=next(x for x in walk(load(initial)) if x.get('id')==43831885690 and 'head_sha' in x)
assert run['head_sha']==HEAD and run['event']=='pull_request' and run['run_attempt']==1
job=next(x for x in load(ROOT/inputs['jobAPI']['path'])['structuredContent']['jobs'] if x['id']==133178915394)
assert job==audit['job'] and job['status']=='completed' and job['conclusion']=='failure' and job['run_id']==43831885690
artifact=next(x for x in load(ROOT/inputs['artifactAPI']['path'])['structuredContent']['artifacts'] if x['id']==14209389308)
assert artifact==inputs['artifactMetadata'] and artifact['workflow_run']['head_sha']==HEAD and artifact['workflow_run']['id']==43831885690
raw=(D/'job-133178915394.log').read_bytes(); assert load(D/'original-job-log-response.json')['structuredContent']['content'].encode()==raw
archive=D/'artifact-14209389308.zip';assert archive.stat().st_size==artifact['size_in_bytes'] and 'sha256:'+hashlib.sha256(archive.read_bytes()).hexdigest()==artifact['digest']
members=[];ret=load(D/'archive-retention.json')
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None and len(z.namelist())==len(set(z.namelist()))==14
 for f in z.infolist():
  p=PurePosixPath(f.filename);assert not p.is_absolute() and '..' not in p.parts and '\\' not in f.filename and ':' not in f.filename and '\0' not in f.filename and not f.is_dir() and not stat.S_ISLNK(f.external_attr>>16)
  b=z.read(f.filename);assert b==(D/'extracted'/f.filename).read_bytes();x={'member':f.filename,'crc32':f'{f.CRC:08x}',**ident(b)}
  a=next(y for y in inputs['members'] if y['member']==f.filename);assert x==a
  r=next(y for y in ret['members'] if y['name']==f.filename);assert all(x[k]==r[k] for k in ['bytes','sha256','crc32']) and x['blob']==r['gitBlobSha'];members.append(x)
assert (D/'extracted/agent-teams-ai/agent-teams-ai/process-acceptance-evidence/source-head.txt').read_text().strip()==HEAD
full=normalized(raw,ansi=True,timestamp=True);teejoins=[]
for rec in audit['originalTeeJoins']:
 checkref(rec);b=(ROOT/rec['path']).read_bytes();ls=normalized(b,ansi=True)
 hits=[i for i in range(len(full)-len(ls)+1) if full[i:i+len(ls)]==ls];assert len(hits)==1,(rec['path'],hits)
 assert len(ls)==rec['lines'];teejoins.append({'file':fi(ROOT/rec['path']),'lines':len(ls),'fullRawStartLine':hits[0]+1,'fullContiguousJoin':True,'normalization':'UTF-8 BOM, original line endings, ISO prefix on job log and ANSI SGR on both sides only; all original files retained byte-exact.'})
assert len(teejoins)==7
tree=git('ls-tree','-r','-z',HEAD,'--','packages/legacy-agent-host/src');host=[]
for l in filter(None,tree.split(b'\0')):
 mode,typ,tail=l.split(b' ',2);oid,p=tail.split(b'\t',1)
 if p.endswith(b'.ts'):assert mode==b'100644' and typ==b'blob';host.append((p.decode(),oid.decode()))
assert len(host)==619
requested=dict(host)
for x in audit['selectedGitSources']+assessment['sources']:requested[x['path']]=x['blob']
extra=['src/features/agent-backend/main/infrastructure/CapturedHostClient.ts','src/features/agent-backend/main/infrastructure/CapturedWindowsCustody.ts','packages/legacy-agent-host/src/owned-process/RetainedWindowsCustody.ts','packages/legacy-agent-host/src/owned-process/windowsBroker.ts','packages/legacy-agent-host/src/owned-process/hostCustody.ts']
for p in extra:requested[p]=git('rev-parse',HEAD+':'+p).decode().strip()
bulk=subprocess.run(['git','cat-file','--batch'],cwd=REPO,input=''.join(v+'\n' for v in requested.values()).encode(),capture_output=True,check=True).stdout
offset=0;contents={}
for p,oid in requested.items():
 e=bulk.index(b'\n',offset);got,typ,n=bulk[offset:e].split();n=int(n);b=bulk[e+1:e+1+n];assert got.decode()==oid and typ==b'blob' and bulk[e+1+n:e+2+n]==b'\n';offset=e+2+n;assert ident(b)['blob']==oid;contents[p]=b
assert offset==len(bulk)
author_host=load(ROOT/audit['hostSourceCensus']['path']);lf=hashlib.sha256();crlf=hashlib.sha256();hostrows=[]
for p,oid in host:
 b=contents[p];assert b'\r\n' not in b;win=b.replace(b'\n',b'\r\n');key=p.removeprefix('packages/legacy-agent-host/src/').encode();lf.update(key+b'\0'+b+b'\0');crlf.update(key+b'\0'+win+b'\0')
 row={'path':p,**ident(b),'crlfSha256':hashlib.sha256(win).hexdigest()};assert row==next(x for x in author_host['rows'] if x['path']==p);hostrows.append(row)
assert lf.hexdigest()==author_host['LF'] and crlf.hexdigest()==author_host['CRLF']
assert tree==git('ls-tree','-r','-z',OLD,'--','packages/legacy-agent-host/src')
source=[]
for p,oid in requested.items():
 b=contents[p];assert git('rev-parse',OLD+':'+p).decode().strip()==oid
 source.append({'path':p,**ident(b),'sameGitBytesAs578':True})
for x in audit['selectedGitSources']+assessment['sources']:
 assert all(ident(contents[x['path']])[k]==x[k] for k in ['bytes','blob','sha256'])
bindings=[]
for x in assessment['freshSourceBindings']:
 b=contents[x['path']].decode().splitlines(keepends=True);actual=''.join(b[x['firstLine']-1:x['lastLine']]);assert actual==x['text'];bindings.append(x)
pinjoins=[]
for rec in audit['capturedSourcePinOccurrences']:
 b=contents[rec['relative']];i=ident(b);assert i==rec['git'];assert hashlib.sha256(b.replace(b'\n',b'\r\n')).hexdigest()==rec['recordedSha256'];pinjoins.append(rec)
assert len(pinjoins)==14
P=D/'extracted/agent-teams-ai/agent-teams-ai/process-acceptance-evidence';native=[]
for a in audit['originalNativeNodeAndElectron']:
 b=(ROOT/a['file']['path']).read_bytes();rows=jsonlines(b);byline={x['line']:x['row'] for x in rows}
 gate=next(x['row'] for x in rows if x['row'].get('gate')=='owned-process-native-scenarios-only');assert gate==a['gate'] and gate['platform']=='win32' and gate['arch']=='arm64' and len(gate['results'])==25
 phases=[x['row']['nativePhase'] for x in rows if x['row'].get('nativePhase',{}).get('phase')=='complete'];assert phases==a['completedPhases'] and len(phases)==31
 for k in ['i386','pendingCreate','cleanupBefore','cleanupAfter','controller']:
  x=a[k];assert byline[x['line']]==x['row']
 for x in a['negativeCases']:assert byline[x['line']]==x['row']
 before=a['cleanupBefore']['row'];after=a['cleanupAfter']['row'];assert before['helperCount']==after['helperCount']==64 and before['retainedCount']==after['retainedCount']==9
 assert all(x['closed'] and x['stdoutEnded'] and x['stderrEnded'] for x in after['helpers'])
 exits=collections.Counter((x['exit']['code'],x['exit']['signal']) for x in after['helpers']);assert exits=={(0,None):56,(74,None):1,(70,None):2,(75,None):3,(None,'SIGTERM'):2}
 assert all(x['diagnostics']['writeCompleted'] is True for x in after['retainedCapabilities']);assert collections.Counter(x['diagnostics']['brokerExit']['code'] for x in after['retainedCapabilities'])=={0:8,70:1}
 i386=a['i386']['row']['nativeI386ChildObservation'];assert i386['status']=='observed' and i386['directI386RootLateHandler']=='unqualified' and len(i386['observations'])==6
 assert a['controller']['row']=={'gateController':'drained','rootExitCode':0,'activeProcesses':0}
 native.append({'file':checkref(a['file']),'gate':gate,'completedPhases':phases,'i386':a['i386'],'pendingCreate':a['pendingCreate'],'negativeCases':a['negativeCases'],'cleanupBefore':before,'cleanupAfter':after,'controller':a['controller']})
provider=load(P/'windows-emulated-provider-receipt.json');receipt=load(P/'windows-source-codex-receipt.json');scenario=receipt['sourceScenarios'][0]
assert provider['status']=='PASS' and provider['cleanup'] is True and receipt['status']=='INCOMPLETE' and receipt['cleanup'] is True
assert receipt['sourceHead']==provider['sourceHead']==HEAD and receipt['platform']==provider['platform']=='win32-arm64'
assert len(receipt['sourceScenarios'])==1 and scenario['provider']=='codex' and scenario['stage']=='Team-A' and scenario['cleanup'] is False
for r in audit['receipts']:
 original=load(ROOT/r['file']['path']);checkref(r['file']);assert all(original.get(k)==r[k] for k in ['kind','provider','status','cleanup'])
 assert original.get('sourceScenarios',[])==r['sourceScenarios']
 assert all(original.get(k)==v for k,v in r['otherTopLevelFields'].items())
assert scenario['lastLaunchReadiness']==audit['firstFailure']['readiness'] and scenario['runtimeProjection']==audit['firstFailure']['runtimeProjection'] and scenario['firstRefusal']==audit['firstFailure']['firstRefusal']
assert scenario['epochs']==audit['cleanup']['epochs'];epochs=scenario['epochs'];assert len(epochs)==1 and len(epochs[0]['jobs'])==7
assert all(all(j[k] for k in ['resumed','stopped','drained','released','originalHandleAbsent']) for j in epochs[0]['jobs'][:6])
last=epochs[0]['jobs'][6];assert last['root']=={'pid':4048,'birth':'01dd75a7a27aa0ba'} and last['resumed'] is False and last['originalHandleAbsent'] is False and all(last[k] for k in ['stopped','drained','released']);assert last['entryStart']==last['entryEnd']==6
for x in audit['cleanup']['passiveBeforeWaitRows']+[audit['cleanup']['controller']]+audit['cleanup']['sourceController']:
 assert json.loads(full[x['line']-1])==x['row']
assert audit['cleanup']['controller']['row']=={'gateController':'drained','rootExitCode':1,'activeProcesses':0}
assert audit['cleanup']['sourceController'][0]['row']['exitCode']==104
for x in audit['firstFailure']['errorLines']:assert full[x['line']-1]==x['text']
assert any('nativeEmulatedSourceScenario.ts:64:12)' in l for l in full)
for x in audit['originalRunCommandHeaders']:assert full[x['line']-1]==x['command']
host=normalized((P/'host-contracts.log').read_bytes(),ansi=True);end=next(i for i,l in enumerate(host) if l=='ℹ tests 167');counts={}
for l in host[end:end+7]:
 m=re.fullmatch(r'ℹ (\S+) (\d+)',l);assert m;counts[m[1]]=int(m[2])
assert all(counts[k]==v for k,v in audit['prerequisites']['originalWholeCommands']['host-contracts.log'].items()) and counts['suites']==0;assert sum(l.startswith('✔ ') for l in host)==164 and sum('# SKIP' in l for l in host)==3
vitest=[]
for n,files,total in [('protocol.log',3,54),('retained-main.log',8,81)]:
 t=normalized((P/n).read_bytes(),ansi=True);filecounts=[]
 for l in t:
  m=re.search(r'✓ (\S+\.test\.\S+) \((\d+) tests\)',l)
  if m:filecounts.append({'path':m[1],'tests':int(m[2])})
 assert len(filecounts)==files and sum(x['tests'] for x in filecounts)==total
 assert any(re.search(r'Test Files\s+'+str(files)+r' passed',l) for l in t) and any(re.search(r'Tests\s+'+str(total)+r' passed',l) for l in t)
 vitest.append({'file':n,'files':filecounts,'pass':total,'fail':0,'skip':0})
arm=assessment['arm64'];assert arm['originalFirstFailure']==audit['firstFailure'] and arm['lastMainCleanupObservation']==audit['cleanup']['passiveBeforeWaitRows'][-1]['row']
t=arm['lastMainCleanupObservation'];ct=t['custodyTimings'];resume=ct['resume'];stop=ct['stop']
assert (resume['calls'],resume['settled'],resume['returned'])==(1,1,0)
assert resume['firstStartMs']<t['firstCloseEntryMs']<stop['firstStartMs']<stop['lastEndMs']<resume['lastEndMs']
assert abs(resume['lastEndMs']-resume['firstStartMs']-resume['totalMs'])<1e-8
proof={'kind':'INDEPENDENT_E3_WINDOWS_ARM_PROCESS_BYTE_SOURCE_PROOF','createdAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':HEAD,'sourceTree':git('rev-parse',HEAD+'^{tree}').decode().strip(),'runId':43831885690,'jobId':133178915394,'references':refs,'job':job,'runIdentity':run,'artifact':artifact,'rawMcpUTF8Exact':True,'all14ZipMembersSafeCrcExactExtracted':True,'members':members,'allSevenTeeJoins':teejoins,'freshGitSources':source,'host619GitCensus':{'files':619,'LF':lf.hexdigest(),'CRLF':crlf.hexdigest(),'rows':hostrows,'limit':'Git source census; source artifact pins cover selected14 occurrences, not a whole619 source-bundle receipt or compiled payload proof.'},'allAuthor36InterpretationLeavesExact':len(audit['selectedGitSources'])==36,'capturedSourcePins':pinjoins,'retainedNonGitDigestOccurrences':audit['nonGitDigestOccurrences'],'exactSourceBindings':bindings,'prerequisites':{'hostContracts':counts,'vitest':vitest,'pass':299,'skip':3},'nativeNodeAndElectron':native,'originalProviderReceipt':provider,'originalCodexSourceReceipt':receipt,'primaryAndCleanupFailure':audit['firstFailure'],'passiveCleanupRows':audit['cleanup']['passiveBeforeWaitRows'],'armAssessmentVerified':arm,'noProjectExecutionOrNetworkOrOriginalReplay':True}
f=D/'independent-byte-source-proof.json';assert not f.exists();f.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'proof':fi(f),'freshUniqueGitFiles':len(source),'host619':len(hostrows),'zipMembers':len(members)},indent=2))
