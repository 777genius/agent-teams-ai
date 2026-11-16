from pathlib import Path,PurePosixPath
import hashlib,json,re,stat,struct,subprocess,datetime,zipfile
ROOT=Path('/workspace/scratch/82d3f9ba6b85');B=ROOT/'ci-72e6ec';O=B/'creation-macos';R=ROOT/'agent-teams-e2e'
H='72e6ec04444969d343d73834c70bc4e261100fc9';E2='57885c055a18b27c180c304762643eac632513ad'
def bid(b):return dict(bytes=len(b),gitBlob=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest(),sha256=hashlib.sha256(b).hexdigest())
def ident(p):return dict(path=str(p.relative_to(ROOT)),**bid(p.read_bytes()))
def put(name,v):
 p=O/name
 with p.open('x',encoding='utf-8',newline='') as f:f.write(json.dumps(v,indent=2,ensure_ascii=False)+'\n')
 return ident(p)
paths=['.github/workflows/teams-create-page-desktop-e2e.yml','scripts/e2e/teams-create-page-desktop.mjs','scripts/e2e/teams-create-page-owned-processes.mjs','scripts/e2e/teams-create-page-owned-processes.test.mjs','src/renderer/components/team/dialogs/LaunchTeamDialog.tsx','src/renderer/components/team/schedule/HistoricalPromptReview.tsx','src/renderer/components/team/schedule/useSavedPromptReview.ts','src/renderer/components/ui/combobox.tsx']
source=[];texts={}
for p in paths:
 d=subprocess.check_output(['git','show',H+':'+p],cwd=R);e=subprocess.check_output(['git','show',E2+':'+p],cwd=R);assert d==e
 source.append(dict(path=p,**bid(d),byteIdenticalToE2=True));texts[p]=d.decode()
tree=subprocess.check_output(['git','rev-parse',H+'^{tree}'],cwd=R).decode().strip()
ranges={'scripts/e2e/teams-create-page-desktop.mjs':[(437,488),(590,682),(685,700),(833,880),(2029,2103)],'src/renderer/components/team/dialogs/LaunchTeamDialog.tsx':[(262,293),(423,430),(2559,2605),(2636,2639)],'src/renderer/components/team/schedule/useSavedPromptReview.ts':[(1,44)],'src/renderer/components/team/schedule/HistoricalPromptReview.tsx':[(14,39)],'src/renderer/components/ui/combobox.tsx':[(157,182)]}
bindings=[]
for p,rs in ranges.items():
 ls=texts[p].splitlines()
 for first,last in rs:bindings.append(dict(path=p,firstLine=first,lastLine=min(last,len(ls)),text='\n'.join(ls[first-1:last])+'\n'))
logp=O/'job.log';raw=logp.read_bytes();log=raw.decode();lines=log.splitlines();resp=O/'job-original-response.json'
assert json.loads(resp.read_bytes())['structuredContent']['content'].encode()==raw
snapshot=B/'owned-jobs-0843.json';s=json.loads(snapshot.read_bytes())
jobs=next(x['value']['response']['structuredContent']['jobs'] for x in s['results'] if x['status']=='fulfilled' and x['value']['lane']=='creation')
job=next(j for j in jobs if j['id']==133178909700);assert job['conclusion']=='failure' and job['status']=='completed'
assert [x['number'] for x in job['steps'] if x['conclusion']=='failure']==[12]
ap=B/'creation-artifacts-0843.json';official=next(a for a in json.loads(ap.read_bytes())['structuredContent']['artifacts'] if a['id']==14209557495)
assert official['workflow_run']['head_sha']==H and official['workflow_run']['id']==43831885626
zp=O/'artifact-14209557495.zip';zi=ident(zp);assert official['size_in_bytes']==zi['bytes'] and official['digest']=='sha256:'+zi['sha256']
assert f'Artifact ID 14209557495' in log and f'Final size is {zi["bytes"]} bytes' in log
entries=[]
with zipfile.ZipFile(zp) as z:
 assert len(z.namelist())==len(set(z.namelist()))==24 and z.testzip() is None
 for info in z.infolist():
  p=PurePosixPath(info.filename);assert not p.is_absolute() and '..' not in p.parts and '\\' not in info.filename and not stat.S_ISLNK(info.external_attr>>16)
  d=z.read(info);assert d==(O/'extracted'/info.filename).read_bytes() and info.filename.endswith('.png') and d[:8]==b'\x89PNG\r\n\x1a\n'
  entries.append(dict(path=info.filename,**bid(d),crc32=f'{info.CRC:08x}',dimensions=struct.unpack('>II',d[16:24])))
assert not (O/'extracted/teams-create-page-result.json').exists()
clean='\n'.join(re.sub(r'^\d{4}-\d{2}-\d{2}T[^ ]+Z ','',l) for l in lines)
assert '{\n  "success": true,' not in clean
start=clean.index('{\n  "label": "teams-create-page-failure"')
dump,end=json.JSONDecoder().raw_decode(clean[start:]);assert dump['dialog'] is True and dump['creationPageName'] is None and len(dump['bodyText'])==800
assert 'org-team-e2e-8e8d57e5' in dump['bodyText']
first='Error: Timed out waiting for saved prompt acknowledgement visible before Save'
ix=next(i for i,l in enumerate(lines) if first in l)
assert ':462:11' in lines[ix+1] and ':875:3' in lines[ix+2] and ':2029:32' in lines[ix+3]
assert 'Create Page E2E and cleanup both failed' not in log
markers=[]
for i,l in enumerate(lines):
 m=re.match(r'([^ ]+) STEP: (.*)$',l)
 if m:markers.append(dict(line=i+1,timestamp=m[1],step=m[2]))
e2logp=ROOT/'ci-57885c/creation-macos/job.log';e2log=e2logp.read_text()
e2markers=re.findall(r'^\S+ STEP: (.*)$',e2log,re.M)
assert len(markers)==23 and len(e2markers)==32 and [x['step'] for x in markers]==e2markers[:23]
counts={k:re.findall(r'ℹ '+k+r' ([0-9.]+)',log) for k in ['tests','pass','fail','cancelled','skipped','duration_ms']}
assert counts['tests']==counts['pass']==['3'] and counts['fail']==counts['cancelled']==counts['skipped']==['0']
assert 'node --test scripts/e2e/teams-create-page-owned-processes.test.mjs' in log and 'node: v26.12.1' in log and '11.22.0' in log
checkout=[dict(line=i+1,text=l) for i,l in enumerate(lines) if re.search(r'Z '+H+r'$',l)];assert checkout
views=[
 ('teams-create-launch-controls-loaded.png','Earlier actual Launch frame names intended fixture teams-create-page-e2e-961f3812-d46d-4321-a219-8e7161c753d4. OpenCode/test-model is Needs attention; runtime environment unavailable and fresh catalog diagnostic visible. No provider launch is claimed.'),
 ('teams-create-schedules-pristine-submit-validation.png','Earlier Schedule form is scrolled down and visibly shows Team is required after the original pristine Save attempt. No selected-team identity is visible in this cropped form position.'),
 ('teams-create-failure.png','Failure frame visibly names org-team-e2e-8e8d57e5 in the Schedule description and Team selector, with empty label and default cron0 9 * * 1-5. The frame is scrolled at its top; lower content is not visible. Absence of #schedule-saved-prompt-reviewed is established by the original DOM wait, not by the cropped image alone.')
]
visual=[dict(**next(e for e in entries if e['path']==p),actuallyViewed=True,viewMethod='Original PNG opened singly',scope=t) for p,t in views]
proof=dict(kind='E3_MAC_CREATION_FRESH_SOURCE_BOUNDARY_PROOF',sourceHead=H,sourceTree=tree,files=source,bindings=bindings,comparison=dict(sourceHead=E2,allEightEqual=True,threeScenarioHelpersEqual=True,workflowEqual=True,passedMacLog=ident(e2logp)),scope='Four canonical Creation source inputs and four fresh Git interpretation leaves; not an archived Desktop source census or rebuilt runtime-output inventory.')
proofid=put('source-proof.json',proof)
audit=dict(kind='E3_MAC_CREATION_ORIGINAL_FAILURE_AUDIT',sourceHead=H,sourceTree=tree,runId=43831885626,jobId=133178909700,status='FAIL',originalLog=ident(logp),originalLogResponse=ident(resp),rawMcpContentExact=True,originalZip=zi,archiveMembers=entries,safeUniqueCrcExtractedBytes=True,officialArtifact=official,officialApi=ident(ap),terminalJob=job,terminalApi=ident(snapshot),checkoutRows=checkout,sourceProof=proofid,originalPrerequisite=dict(argv='node --test scripts/e2e/teams-create-page-owned-processes.test.mjs',counts=counts,node='26.12.1',pnpm='11.22.0'),firstFailure=dict(line=ix+1,message=first,stackRows=lines[ix:ix+4],originalWaitMs=45000,originalPollDelayMs=80,cdpCommandTimeoutMs=30000,strictPostReadDeadline=False,limit='The original Creation wait checks wall time before each read; an awaited30s CDP command can outlive the nominal45s loop. No elapsed sampled read count or dispatch timing is retained.'),lastStep=markers[-1],originalActionMarkers=markers,comparisonWithE2=dict(original23MarkerNamesEqualPrefixOfPassed32=True,qualificationTransfer=False),failureRendererDump=dump,visualReview=dict(count=3,actuallyViewed=visual,remaining21='Byte/CRC only'),resultJsonArchived=False,resultJsonPrinted=False,all25BehaviorFlagsAvailable=False,remainingActionsUnexecuted=['saved-prompt acknowledgement accepted','Schedule label/prompt fill and invalid-cron UI checks','actual valid Schedule create/update/delete','zh-TW MCP and Task tab branch','qualified result construction and publication'],sourceInterpretation=dict(intendedFixtureTeamFromEarlierActualImage='teams-create-page-e2e-961f3812-d46d-4321-a219-8e7161c753d4',lastVisibleSelectedTeam='org-team-e2e-8e8d57e5',retainedMismatch=True,actualDispatchedOptionUnknown=True,selectionTransitionHistoryUnknown=True,savedRequestCompletionAndPromptUnknown=True,combobox='Non-disabled onSelect forwards option.value into selectedTeamName; saved-prompt hook never writes team selection.',creationClick='One selected element scroll/geometry observation precedes press/release; the clicked option identity, hit target and interval geometry are not retained.',cause='unknown; no deterministic repair selected'),cleanup=dict(originalFinallyReachedBySourceOrder=True,sourceImpliesCleanupReturnedWithoutException=True,basis='Original primary Error is rethrown only after finally; both-error branch would emit AggregateError. No cleanup error retained.',physicalFinalCensusArchived=False,finalCleanupResultArchived=False,appOrHostExitCodesArchived=False,processGroupIdArchived=False,limits='Source-implied normal return of original forced Unix cleanup is not an independent process-custody/absence certificate or natural-exit proof.'),limits=['24PNG-only archive; no final JSON, schedules receipt or full25flag proof.','Three named actual PNG views,21 other byte/CRC checks only.','Expected finite deny-all/runtime degraded and sqlite-fallback tail lines are not the retained primary error or proven cause.','Creation job runs only its original3-case helper; P11 whole8 or HostTeam/static outcomes are not qualified.','Same source as E2 passed macOS is a comparison, not a causal diagnosis or transfer of success.','No source/test/CI/ref change, replay, timeout change or local project execution.'])
aid=put('audit.json',audit)
print(json.dumps(dict(audit=aid,sourceProof=proofid,sourceTree=tree,markers=len(markers),pngs=len(entries),views=len(visual),lastStep=markers[-1]),indent=2))
