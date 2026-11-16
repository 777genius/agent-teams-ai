from pathlib import Path, PurePosixPath
import datetime, hashlib, json, re, stat, struct, subprocess, zipfile

ROOT=Path('/workspace/scratch/82d3f9ba6b85')
B=ROOT/'ci-72e6ec/creation-ubuntu'; REPO=ROOT/'agent-teams-e2e'
H='72e6ec04444969d343d73834c70bc4e261100fc9'; E2='57885c055a18b27c180c304762643eac632513ad'
def bid(b): return {'bytes':len(b),'blob':hashlib.sha1(b'blob '+str(len(b)).encode()+bytes([0])+b).hexdigest(),'sha256':hashlib.sha256(b).hexdigest()}
def ident(p): return {'path':str(p.relative_to(ROOT)),**bid(p.read_bytes())}
def read(p): return json.loads(p.read_bytes())
def put(p,v):
 data=v if isinstance(v,str) else json.dumps(v,ensure_ascii=False,indent=2)+'\n'
 with p.open('x',encoding='utf-8',newline='') as f:f.write(data)
 return ident(p)
def git(p): return subprocess.check_output(['git','show',H+':'+p],cwd=REPO)

terminalPath=B.parent/'owned-jobs-0901.json'; terminal=read(terminalPath)
job=next(j for r in terminal['reads'] if r['lane']=='creation' for j in r['response']['structuredContent']['jobs'] if j['id']==133178910281)
officialPath=B.parent/'official-creation-artifacts-0902.json'
artifact=next(a for a in read(officialPath)['structuredContent']['artifacts'] if a['id']==14209850260)
assert job['run_id']==43831885626 and job['status']=='completed' and job['conclusion']=='success'
assert artifact['workflow_run']['id']==43831885626 and artifact['workflow_run']['head_sha']==H
rawPath=B/'job.log'; responsePath=B/'job-original-response.json'; raw=rawPath.read_bytes()
assert read(responsePath)['structuredContent']['content'].encode('utf-8')==raw
log=raw.decode(); lines=log.splitlines()
zp=B/'artifact-14209850260.zip'; archive=ident(zp)
assert artifact['size_in_bytes']==archive['bytes']==2867814 and artifact['digest']=='sha256:'+archive['sha256']
assert 'Artifact ID 14209850260' in log and 'Final size is 2867814 bytes' in log
checkout=[{'line':i+1,'text':s} for i,s in enumerate(lines) if re.search(r'Z '+H+r'$',s)]
assert checkout
entries=[]
with zipfile.ZipFile(zp) as z:
 assert len(z.infolist())==len(set(z.namelist()))==41 and z.testzip() is None
 for zi in z.infolist():
  n=PurePosixPath(zi.filename);assert not n.is_absolute() and '..' not in n.parts and '\\' not in zi.filename and not stat.S_ISLNK(zi.external_attr>>16)
  b=z.read(zi.filename);assert b==(B/'extracted'/zi.filename).read_bytes()
  row={'path':zi.filename,**bid(b),'crc32':f'{zi.CRC:08x}'}
  if zi.filename.endswith('.png'):
   assert b[:8]==b'\x89PNG\r\n\x1a\n';row['dimensions']=struct.unpack('>II',b[16:24])
  entries.append(row)
assert sum(x['path'].endswith('.png') for x in entries)==40
retention=read(B/'archive-retention.json')
for row in retention['members']:
 actual=next(x for x in entries if x['path']==row['path'])
 assert row['bytes']==actual['bytes'] and row['gitBlob']==actual['blob'] and row['sha256']==actual['sha256'] and row['crc']==int(actual['crc32'],16)
resultPath=B/'extracted/teams-create-page-result.json'; result=read(resultPath)
clean='\n'.join(re.sub(r'^\d{4}-\d{2}-\d{2}T[^ ]+Z ','',s) for s in lines)
start=clean.index('{\n  "success": true,'); printed,_=json.JSONDecoder().raw_decode(clean[start:])
assert printed==result and result['success']
flags={k:v for k,v in result.items() if isinstance(v,bool) and k!='success'}
assert len(flags)==25 and all(flags.values())
markers=[]
for i,s in enumerate(lines):
 m=re.match(r'([^ ]+) STEP: (.*)$',s)
 if m:markers.append({'line':i+1,'timestamp':m[1],'step':m[2]})
previous=read(ROOT/'ci-57885c/creation-all-platforms/audit.json')
priorWindows=next(p for p in previous['platforms'] if p['platform']=='ubuntu')
assert len(markers)==32 and [x['step'] for x in markers]==[x['step'] for x in priorWindows['originalActionMarkers']]
counts={k:[float(x) if k=='duration_ms' else int(x) for x in re.findall(r'ℹ '+k+r' ([0-9.]+)',log)] for k in ['tests','pass','fail','cancelled','skipped','duration_ms']}
assert counts['tests']==counts['pass']==[3] and counts['fail']==counts['cancelled']==counts['skipped']==[0]
assert 'node --test scripts/e2e/teams-create-page-owned-processes.test.mjs' in log and 'node: v26.12.1' in log and '11.22.0' in log
assert result['macInputSelectionFallbackCount']==0 and result['scheduleUiEvidence']['createdAndDeleted']
assert result['zhTwMcpUiEvidence']['locale']=='zh-TW' and result['zhTwMcpUiEvidence']['parsedServerNames']==['github','sentry'] and result['zhTwMcpUiEvidence']['taskDetailUiEvidence']['nativeTaskTabVisible']
cleanup=result['cleanup']
assert cleanup['processGroupAbsent'] and cleanup['temporaryProfileRemoved']
assert all(cleanup[k] is None for k in ['windowsTaskkillExitedZero','windowsExactOwnedProcessesAbsent','windowsTeardowns'])
sources=[];texts={}
for known in previous['sourceFiles']:
 path=known['path'];data=git(path);assert data==subprocess.check_output(['git','show',E2+':'+path],cwd=REPO)
 assert bid(data)['sha256']==known['sha256']
 sources.append({'path':path,**bid(data),'byteExactE2Comparison':True,'lines':len(data.splitlines())});texts[path]=data.decode()
tree=subprocess.check_output(['git','rev-parse',H+'^{tree}'],cwd=REPO).decode().strip();assert tree=='de80fbfbffb3fe4daabf6cc9be258cc8df534524'
script=texts['scripts/e2e/teams-create-page-desktop.mjs'].splitlines();bindings=[]
for first,last,label in [(568,607,'Unix process-group ESRCH observation and forced cleanup'),(669,681,'temporary profile removal'),(1620,1668,'real restart and loaded modal closed without provider launch'),(1787,1817,'copied editor exact name and retained changes'),(2028,2099,'complete result after cleanup with error precedence')]:
 bindings.append({'sourcePath':'scripts/e2e/teams-create-page-desktop.mjs','firstLine':first,'lastLine':last,'label':label,'text':'\n'.join(script[first-1:last])+'\n'})
proof={'kind':'E3_UBUNTU_CREATION_FOUR_CURRENT_SOURCE_BODIES','sourceHead':H,'sourceTree':tree,'files':sources,'bindings':bindings,'limit':'Four fresh Git bodies and original checkout/build records; no1757 Desktop census, complete built payload inventory or independent rebuild.'}
sourceId=put(B/'source-proof.json',proof)
notes={
 'teams-create-restarted.png':'The original restarted Create Team editor shows create-page-e2e-b207a842, lead Opus4.8, checked Run command after create, collapsed Optional launch settings and an empty Tasks sidebar. Anthropic Checking and disabled Create are visible; this frame is not provider readiness proof.',
 'teams-create-copy-resumed-edits.png':'The resumed copied editor shows exact copy-edited-e2e-3c62a3aa, Lead prompt and Description chips, checked Run command after create and the original draft tab. Anthropic Checking remains visible. Collapsed prompt/description body values are not independently visible.',
 'teams-create-launch-controls-loaded.png':'The loaded Launch Team modal shows sandbox-project/OpenCode/test-model, Needs attention and the fresh project-scoped provider catalog diagnostic, with Launch team disabled. The source closes this modal without launching the deny-all runtime.'
}
views=[{**next(x for x in entries if x['path']==name),'actuallyViewed':True,'viewMethod':'Original PNG opened singly via view_image; full1280x900 frame inspected','scope':note} for name,note in notes.items()]
assert all(x['dimensions']==(1280,900) for x in views)
commands=[{'line':i+1,'text':s} for i,s in enumerate(lines) if any(t in s for t in ['install-dependencies-with-retry.mjs','pnpm --filter @agent-teams/legacy-agent-host build','stage-terminal-platform-runtime.mjs --ensure','ensure-electron-install.cjs --strict','node --test scripts/e2e/teams-create-page-owned-processes.test.mjs','node scripts/e2e/teams-create-page-desktop.mjs'])]
audit={'kind':'AUTHOR_ORIGINAL_E3_UBUNTU_CREATION_AUDIT','auditedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':H,'sourceTree':tree,'runId':43831885626,'jobId':133178910281,'status':'PASS',
 'originalLog':ident(rawPath),'originalLogResponse':ident(responsePath),'rawUtf8ExactMcpContent':True,'rawCRLFCount':raw.count(b'\r\n'),'originalZip':archive,'officialArtifact':artifact,'officialArtifactsResponse':ident(officialPath),'terminalJob':job,'terminalJobsResponse':ident(terminalPath),'archiveRetention':ident(B/'archive-retention.json'),'archiveMembers':entries,'allSafeUniqueNonSymlinkCrcAndExtractedBytes':True,
 'sourceProof':sourceId,'sourceFiles':sources,'checkoutRows':checkout,'sourceQualification':proof['limit'],'originalCommands':commands,'originalToolchain':{'node':'26.12.1','pnpm':'11.22.0'},'originalPrerequisite':{'argv':'node --test scripts/e2e/teams-create-page-owned-processes.test.mjs','counts':counts},
 'result':ident(resultPath),'printedResultEqualsArchivedObject':True,'resultObject':result,'behaviorFlags':flags,'originalActionMarkers':markers,'sameOrdered32MarkersAsE2':True,'visualReview':views,'totalPngBytesAndCrcChecked':40,'totalPngActuallyViewed':3,
 'scopeOfFlags':'Original Create/editor persistence, config-only save/rejection, modal loading, template/copy/organization, theme/zoom, schedule presentation and Traditional Chinese task/MCP controls. Source closes Launch without starting deny-all runtime.',
 'cleanupQualification':{'result':cleanup,'forcedDisposableUnixProcessGroupCleanup':True,'sourceRequiresEsrchNotEperm':True,'originalObservationMs':4000,'originalCadenceMs':50,'nativeProviderCustodyQualified':False,'naturalExitQualified':False,'productStopQualified':False,'limit':'Source sends SIGKILL to the captured disposable process group, with existing child fallback, then accepts only ESRCH absence; EPERM refuses. Final result follows successful cleanup/profile removal. No raw PID/group census, per-process exit codes or captured Host custody certificate is archived.'},
 'comparison':{'priorE2Source':E2,'fourSourceBodiesEqual':True,'priorResultsNotTransferred':True,'sameCohortMacFailureSeparate':True},
 'qualification':{'originalUbuntuCreation':True,'whole18Desktop':False,'currentTeamOrP11':False,'allFourFrontend':False,'providerRuntimeLaunch':False,'realVendor':False,'naturalShutdown':False,'packagedNativeOrRelease':False},
 'limits':['Only3 named PNGs actually viewed;37 other PNGs byte/CRC checked.','Actual original3helperPASS; no Team/P11 full8 or typed/static execution qualification.','Launch screenshot is Needs attention with disabled Launch; no real provider readiness or launch.','Source-bound forced disposable Unix cleanup only; raw full process identities/natural exit codes unavailable.','Mac saved-prompt failure remains separate; WindowsChecking versus UbuntuNeedsattention is not a causal comparison.','No project/native/provider/CI execution, source/ref changes or retries by auditor.']}
auditId=put(B/'audit.json',audit)
appendix=f"""### Original E3 Ubuntu Creation: completed editor flow, forced disposable-group cleanup

Original Ubuntu job **133178910281**, run **43831885626**, at **{H}** completed SUCCESS. Its full raw job log equals the retained original MCP content; its printed final result equals the JSON in official artifact **14209850260**. The **2,867,814-byte** ZIP has SHA-256 **{archive['sha256']}** and41 safe, unique CRC-checked members: the final JSON and40 PNGs. No log or artifact was fetched again for this review.

The original Node26.12.1/pnpm11.22.0 lane passed its existing three owned-process helper cases, then completed32 original Creation action markers and25 true behavior flags. The recorded scope covers editor navigation/pane/restart persistence; advanced CLI/default/validation controls; the loaded Launch modal; config-only save and rejected-save draft retention; copy/template/organization behavior; theme/zoom; schedule presentation; and Traditional Chinese Task/MCP controls. The original schedule **8720d85d-1cbd-41df-9feb-62c01bfec4f8** is recorded created and deleted. These are Creation assertions; the current Team/P11 command and typed/static gates did not run in this lane.

Fresh source reads bind the current workflow, driver, owned-process helper and its test to exact72e6. All four equal the previously reviewed E2 bodies; the result is still established by this original job, without historical success transfer. This source closure does not claim the1757-source Desktop census, a full compiled payload census or an independent rebuild.

Exactly three PNGs were opened singly. The restarted editor shows **create-page-e2e-b207a842**, lead Opus4.8, checked Run command after create and an empty Tasks sidebar. The copied editor retains **copy-edited-e2e-3c62a3aa**, Lead prompt and Description chips; the collapsed body values are not visually exposed. Both editor frames retain Anthropic Checking. The loaded Launch modal shows sandbox-project/OpenCode/test-model with **Needs attention**, the fresh project-scoped catalog diagnostic and disabled Launch. The driver closes this dialog without starting the deny-all runtime. The other37 PNGs are byte/CRC checked only.

The final result records disposable process-group absence and temporary profile removal. The current Unix cleanup sends SIGKILL to the captured group, keeps its existing child fallback and observes absence for the original4000ms/50ms cadence. Only ESRCH authorizes success; EPERM does not. This is source-bound forced fixture cleanup, without an archived raw process census, original Host custody certificate, per-child exit codes or natural-shutdown qualification.

The result remains separate from E3 macOS's saved-prompt failure and Windows's Checking modal frame. It does not qualify all frontend shards, the current P11 semantic RED, Team/static gates, all Desktop/provider paths, packaged/native workflows or release. No source, project/native/provider execution, replay or CI action was performed by the auditor.
"""
appendixId=put(B/'Plan29-appendix.md',appendix)
paths=[rawPath,responsePath,zp,B/'archive-retention.json',officialPath,terminalPath,B/'source-proof.json',B/'audit.json',B/'Plan29-appendix.md']
for path in paths:
 if path.suffix!='.zip':assert re.search(rb'https?://[^\s"<>]*(?:[?&](?:sig|X-Amz-Signature|skoid)=)',path.read_bytes(),re.I) is None
checkpoint=put(B/'checkpoint.json',{'kind':'FROZEN_ORIGINAL_E3_UBUNTU_CREATION_AUTHOR_PACKET','sourceHead':H,'runId':43831885626,'jobId':133178910281,'status':'PASS_WITH_FORCED_DISPOSABLE_GROUP_CLEANUP','authorAudit':auditId,'appendix':appendixId,'sourceProof':sourceId,'payloads':[ident(p) for p in paths],'payloadCount':len(paths),'payloadBytes':sum(p.stat().st_size for p in paths),'officialZipMembers':41,'pngBytesChecked':40,'pngActuallyViewed':3,'independentReviewPending':True,'noProjectExecution':True})
print(json.dumps({'audit':auditId,'appendix':appendixId,'sourceProof':sourceId,'checkpoint':checkpoint},indent=2))
