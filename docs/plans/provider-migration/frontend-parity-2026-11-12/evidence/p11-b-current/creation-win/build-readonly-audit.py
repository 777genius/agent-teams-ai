from pathlib import Path, PurePosixPath
import datetime, hashlib, json, re, stat, struct, subprocess, zipfile

ROOT=Path('/workspace/scratch/82d3f9ba6b85')
B=ROOT/'ci-72e6ec/creation-windows'; REPO=ROOT/'agent-teams-e2e'
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
job=next(j for r in terminal['reads'] if r['lane']=='creation' for j in r['response']['structuredContent']['jobs'] if j['id']==133178909857)
officialPath=B.parent/'official-creation-artifacts-0902.json'
artifact=next(a for a in read(officialPath)['structuredContent']['artifacts'] if a['id']==14210737149)
assert job['run_id']==43831885626 and job['status']=='completed' and job['conclusion']=='success'
assert artifact['workflow_run']['id']==43831885626 and artifact['workflow_run']['head_sha']==H
rawPath=B/'job.log'; responsePath=B/'job-original-response.json'; raw=rawPath.read_bytes()
assert read(responsePath)['structuredContent']['content'].encode('utf-8')==raw
log=raw.decode(); lines=log.splitlines()
zp=B/'artifact-14210737149.zip'; archive=ident(zp)
assert artifact['size_in_bytes']==archive['bytes']==1855760 and artifact['digest']=='sha256:'+archive['sha256']
assert 'Artifact ID 14210737149' in log and 'Final size is 1855760 bytes' in log
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
 actual=next(x for x in entries if x['path']==row['name'])
 assert all(row[k]==actual[k] for k in ['bytes','blob','sha256','crc32'])
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
priorWindows=next(p for p in previous['platforms'] if p['platform']=='windows')
assert len(markers)==32 and [x['step'] for x in markers]==[x['step'] for x in priorWindows['originalActionMarkers']]
counts={k:[float(x) if k=='duration_ms' else int(x) for x in re.findall(r'ℹ '+k+r' ([0-9.]+)',log)] for k in ['tests','pass','fail','cancelled','skipped','duration_ms']}
assert counts['tests']==counts['pass']==[3] and counts['fail']==counts['cancelled']==counts['skipped']==[0]
assert 'node --test scripts/e2e/teams-create-page-owned-processes.test.mjs' in log and 'node: v26.12.1' in log and '11.22.0' in log
assert result['macInputSelectionFallbackCount']==0 and result['scheduleUiEvidence']['createdAndDeleted']
assert result['zhTwMcpUiEvidence']['locale']=='zh-TW' and result['zhTwMcpUiEvidence']['parsedServerNames']==['github','sentry'] and result['zhTwMcpUiEvidence']['taskDetailUiEvidence']['nativeTaskTabVisible']
cleanup=result['cleanup'];assert cleanup['temporaryProfileRemoved'] and cleanup['processGroupAbsent'] is None and cleanup['windowsTaskkillExitedZero'] and cleanup['windowsExactOwnedProcessesAbsent']
assert [x['launcherPid'] for x in cleanup['windowsTeardowns']]==[8116,2092,860]
assert [x['observedIdentityCount'] for x in cleanup['windowsTeardowns']]==[17,17,17]
assert all(x['taskkillAttempted'] and x['taskkillExitCode']==0 and x['exactOwnedProcessesAbsent'] and x['cdpPortAbsent'] for x in cleanup['windowsTeardowns'])
sources=[];texts={}
for known in previous['sourceFiles']:
 path=known['path'];data=git(path);assert data==subprocess.check_output(['git','show',E2+':'+path],cwd=REPO)
 assert bid(data)['sha256']==known['sha256']
 sources.append({'path':path,**bid(data),'byteExactE2Comparison':True,'lines':len(data.splitlines())});texts[path]=data.decode()
tree=subprocess.check_output(['git','rev-parse',H+'^{tree}'],cwd=REPO).decode().strip();assert tree=='de80fbfbffb3fe4daabf6cc9be258cc8df534524'
script=texts['scripts/e2e/teams-create-page-desktop.mjs'].splitlines()
bindings=[]
for first,last,label in [(590,681,'forced disposable Windows cleanup and temporary profile removal'),(1620,1668,'real restart and loaded modal, closed without provider launch'),(1787,1817,'copied editor exact name and retained changes'),(2028,2099,'complete result after scenario and cleanup with error precedence')]:
 bindings.append({'sourcePath':'scripts/e2e/teams-create-page-desktop.mjs','firstLine':first,'lastLine':last,'label':label,'text':'\n'.join(script[first-1:last])+'\n'})
sourceProof={'kind':'E3_WINDOWS_CREATION_FOUR_CURRENT_SOURCE_BODIES','sourceHead':H,'sourceTree':tree,'files':sources,'bindings':bindings,'ownedProcessHelper':texts['scripts/e2e/teams-create-page-owned-processes.mjs'],'ownedProcessHelperTest':texts['scripts/e2e/teams-create-page-owned-processes.test.mjs'],'limit':'Four fresh exact Git bodies and original checkout/build records. No 1757 Desktop census, full built payload inventory or independent rebuild.'}
sourceId=put(B/'source-proof.json',sourceProof)
notes={
 'teams-create-restarted.png':'The original restarted Create Team editor shows create-page-e2e-7eb118de, lead Opus4.8, checked Run command after create, collapsed Optional launch settings and an empty Tasks sidebar. The project selector reports no projects; this frame does not prove provider readiness.',
 'teams-create-copy-resumed-edits.png':'The resumed copied editor shows the exact edited name copy-edited-e2e-b5d2cb19, Lead prompt and Description chips, checked Run command after create and the original draft tab. The collapsed prompt/description body values are not visible in this frame.',
 'teams-create-launch-controls-loaded.png':'The loaded Launch Team modal shows sandbox-project, OpenCode and test-model, with provider Checking and a disabled Launch team control. It is an observation of the loaded modal, not a runtime launch or readiness success.'
}
views=[{**next(x for x in entries if x['path']==name),'actuallyViewed':True,'viewMethod':'Original PNG opened singly via view_image; full1024x720 frame inspected','scope':note} for name,note in notes.items()]
assert all(x['dimensions']==(1024,720) for x in views)
commands=[{'line':i+1,'text':s} for i,s in enumerate(lines) if any(t in s for t in ['install-dependencies-with-retry.mjs','pnpm --filter @agent-teams/legacy-agent-host build','stage-terminal-platform-runtime.mjs --ensure','ensure-electron-install.cjs --strict','node --test scripts/e2e/teams-create-page-owned-processes.test.mjs','node scripts/e2e/teams-create-page-desktop.mjs'])]
audit={
 'kind':'AUTHOR_ORIGINAL_E3_WINDOWS_CREATION_AUDIT','auditedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':H,'sourceTree':tree,'runId':43831885626,'jobId':133178909857,'status':'PASS',
 'originalLog':ident(rawPath),'originalLogResponse':ident(responsePath),'rawUtf8ExactMcpContent':True,'rawCRLFCount':raw.count(b'\r\n'),'rawRetentionCorrection':ident(B/'raw-serialization-correction.json'),
 'originalZip':archive,'officialArtifact':artifact,'officialArtifactsResponse':ident(officialPath),'terminalJob':job,'terminalJobsResponse':ident(terminalPath),'archiveRetention':ident(B/'archive-retention.json'),'archiveMembers':entries,'allSafeUniqueNonSymlinkCrcAndExtractedBytes':True,
 'sourceProof':sourceId,'sourceFiles':sources,'checkoutRows':checkout,'sourceQualification':sourceProof['limit'],
 'originalCommands':commands,'originalToolchain':{'node':'26.12.1','pnpm':'11.22.0'},'originalPrerequisite':{'argv':'node --test scripts/e2e/teams-create-page-owned-processes.test.mjs','counts':counts},
 'result':ident(resultPath),'printedResultEqualsArchivedObject':True,'resultObject':result,'behaviorFlags':flags,'originalActionMarkers':markers,'sameOrdered32MarkersAsE2':True,
 'scopeOfFlags':'Original Create/editor persistence, config-only save/rejection, modal loading, template/copy/organization, theme/zoom, schedule presentation and Traditional Chinese task/MCP controls. The original driver closes Launch modal without starting the deny-all runtime.',
 'visualReview':views,'totalPngBytesAndCrcChecked':40,'totalPngActuallyViewed':3,
 'cleanupQualification':{'threeTeardowns':cleanup['windowsTeardowns'],'exactProcessAndCdpAbsenceRequiredTogether':True,'birthIdentityGuarded':True,'observedIdentityCountIsPerTeardownNotGlobalDistinct':True,'forceTermination':True,'naturalExitQualified':False,'productStopQualified':False,'nativeProviderCustodyQualified':False,'limits':'Each of the three original disposable launchers receives forced taskkill after birth/ownership checks. Exact retained owned-process identities and the CDP endpoint are then absent. No per-process exit codes or globally unique51-process census is archived; original temporary profile removal is source-bound.'},
 'comparison':{'priorE2Source':E2,'fourSourceBodiesEqual':True,'priorResultsNotTransferred':True,'sameCohortMacCreationFailureSeparate':True},
 'qualification':{'originalWindowsCreation':True,'whole18Desktop':False,'currentTeamOrP11':False,'allFourFrontend':False,'providerRuntimeLaunch':False,'realVendor':False,'naturalShutdown':False,'packagedNativeOrRelease':False},
 'limits':['Only3 named PNGs actually viewed;37 others verified as exact safe CRC members with original hashes/dimensions.','Three original helper cases passed; this job does not run the current P11 whole8 command or Team/static validation.','SUCCESS25flags/32markers does not qualify native provider launch; actual Launch screenshot remains Checking and disabled.','Cleanup is forced disposable Windows tree cleanup, not natural or product Stop/provider custody.','No current E3 macOS failure or other platform is overwritten by this Windows result.','No project execution, source/ref/CI change, retry or original action replay by author.']
}
auditId=put(B/'audit.json',audit)
appendix=f"""### Original E3 Windows Creation: complete editor acceptance, scoped forced cleanup

This is the original Windows Creation job **133178909857**, run **43831885626**, at source **{H}**, not a rerun. The terminal API reports SUCCESS. Its full original job output is retained byte-for-byte from the original MCP response; the final printed result equals the JSON inside official artifact **14210737149**. The 1,855,760-byte ZIP has SHA-256 **{archive['sha256']}**, 41 safe, unique CRC-checked members: the final JSON and40 PNGs. Earlier LF-normalized scratch serialization was corrected from the retained original response, with a separate provenance record; the original endpoint was not fetched again.

The original Node26.12.1/pnpm11.22.0 lane executed the existing three-case owned-process helper suite with **3 PASS,0 FAIL,0 SKIP**, then the original Creation driver. The full driver completed all32 ordered action markers and retained all25 true behavior flags. These cover draft persistence across navigation, panes and real process restart; original advanced-CLI/default/validation behavior; the loaded Launch modal; config-only creation and rejected-save draft retention; copied-editor and template behavior; organization placement; duplicate-name recovery; themes/zoom; and the original schedule and Traditional Chinese MCP/task controls. The schedule record reports created-and-deleted schedule **834b392b-042f-4fcc-8df9-66845a146c93**. The Traditional Chinese task dialog/tab and strict MCP allowlist observations remain the original source assertions. This is not execution of the current Team/P11 commands.

All four relevant source bodies were read freshly at this exact head: Creation workflow, original driver, owned-process helper and its existing test file. Their bytes equal the previously audited E2 bodies. That equality is a source comparison; this packet's result comes from its own raw execution. It does not claim the1757-source Desktop artifact census, a complete compiled payload inventory or an independent build.

Exactly three original PNGs were actually opened singly and inspected; the other37 were byte/CRC checked only. The restarted editor shows **create-page-e2e-7eb118de**, lead Opus4.8, checked Run command after create and an empty Tasks sidebar. The resumed copy shows **copy-edited-e2e-b5d2cb19** with Lead prompt/Description chips; their collapsed body values are not visible. The loaded Launch modal shows sandbox-project/OpenCode/test-model with **Checking** and a disabled Launch control. The original driver closes this modal without starting the deny-all runtime, so neither the screenshot nor the flags establish provider readiness or a real provider launch.

The final result records three original forced Windows teardowns for launchers8116,2092 and860. Each recorded17 observed identities, taskkill exit0, exact owned-process absence and CDP absence. The current helper preserves birth identity, refuses reused-parent authority and requires process absence in addition to the CDP check. These counts are per-teardown observations, not51 globally distinct processes. Temporary profile removal is also retained. There is no archived per-child exit-code ledger, natural shutdown claim, product Stop or native provider custody certificate.

This successful Windows editor lane remains separate from the same-source E3 macOS saved-prompt failure and its missing final JSON. It does not qualify all Desktop lanes, all four frontend shards, the P11 semantic RED, Team/static gates, packaged/native paths, real vendor authentication or release. All originals remain frozen; this author packet adds read-only source/byte/visual analysis only.
"""
appendixId=put(B/'Plan29-appendix.md',appendix)
paths=[rawPath,responsePath,zp,B/'archive-retention.json',B/'raw-serialization-correction.json',officialPath,terminalPath,B/'source-proof.json',B/'audit.json',B/'Plan29-appendix.md']
for path in paths:
 if path.suffix!='.zip':assert re.search(rb'https?://[^\s"<>]*(?:[?&](?:sig|X-Amz-Signature|skoid)=)',path.read_bytes(),re.I) is None
checkpoint=put(B/'checkpoint.json',{'kind':'FROZEN_ORIGINAL_E3_WINDOWS_CREATION_AUTHOR_PACKET','sourceHead':H,'runId':43831885626,'jobId':133178909857,'status':'PASS_WITH_SCOPED_FORCED_CLEANUP','authorAudit':auditId,'appendix':appendixId,'sourceProof':sourceId,'payloads':[ident(p) for p in paths],'payloadCount':len(paths),'payloadBytes':sum(p.stat().st_size for p in paths),'officialZipMembers':41,'pngBytesChecked':40,'pngActuallyViewed':3,'independentReviewPending':True,'noProjectExecution':True})
print(json.dumps({'audit':auditId,'appendix':appendixId,'sourceProof':sourceId,'checkpoint':checkpoint},indent=2))
