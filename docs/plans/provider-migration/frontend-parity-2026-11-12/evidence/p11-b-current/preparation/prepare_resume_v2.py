from pathlib import Path,PurePosixPath
import datetime,gzip,hashlib,io,json,subprocess,zipfile

S=Path('/workspace/scratch/82d3f9ba6b85');R=S/'agent-teams-e2e';O=Path(__file__).parent
BASE='fc580db9bafbe7d9f28dc86edd484af3e151de6f';PRIMARY='72e6ec04444969d343d73834c70bc4e261100fc9'
PLAN='docs/plans/provider-migration/frontend-parity-2026-11-12/29-reconciled-acceptance-and-custody-followups-2026-11-15.md'
DEST='docs/plans/provider-migration/frontend-parity-2026-11-12/evidence/p11-b-current/'
assert not (O/'upload-manifest.json').exists()  # Previous preparation stopped before freezing.
def meta(b):return dict(bytes=len(b),blob=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest(),sha256=hashlib.sha256(b).hexdigest())
def git(*a):return subprocess.check_output(['git',*a],cwd=R)
def write(p,b):
    p.parent.mkdir(parents=True,exist_ok=True)
    if p.exists():
        assert p.is_file() and p.read_bytes()==b, 'Existing partial preparation bytes changed: '+str(p)
        return
    with p.open('xb')as f:f.write(b)
def leaves(ref):
    out={}
    for row in git('ls-tree','-rz',ref).split(b'\0'):
        if not row:continue
        h,p=row.split(b'\t',1);mode,kind,sha=h.decode().split();out[p.decode()]=dict(mode=mode,type=kind,sha=sha)
    return out
def merkle(rows):
    root={};dirs={}
    for p,r in rows.items():
        n=root;parts=p.split('/')
        for part in parts[:-1]:n=n.setdefault(part,{})
        assert parts[-1]not in n;n[parts[-1]]=(r['mode'],r['sha'])
    def visit(n,p):
        entries=[]
        for name,v in n.items():
            mode,sha=('40000',visit(v,p+'/'+name if p else name))if isinstance(v,dict)else v
            entries.append(((name+('/'if mode=='40000'else'')).encode(),mode.encode()+b' '+name.encode()+b'\0'+bytes.fromhex(sha)))
        b=b''.join(v for _,v in sorted(entries));sha=hashlib.sha1(b'tree '+str(len(b)).encode()+b'\0'+b).hexdigest();dirs[p]=sha;return sha
    return visit(root,''),dirs
def non_docs(rows):return[dict(path=p,**r)for p,r in sorted(rows.items())if not p.startswith('docs/')]
def source_hash(rows):return hashlib.sha256(json.dumps(non_docs(rows),sort_keys=True,separators=(',',':')).encode()).hexdigest()

old=json.loads((S/'models-a-publication/upload-manifest.json').read_bytes())
binding=json.loads((S/'p11-b-current-fc580/candidate-metadata.json').read_bytes())
r2path=S/'p11-b-current-fc580/independent-current-source-r1-review.json'
assert r2path.is_file(),'Require complete independent P11 B current source/R1 review before freezing publication'
review=json.loads(r2path.read_bytes())
assert 'APPROVE'in str(review.get('verdict',review.get('result','')))
base=leaves(BASE);assert merkle(base)[0]==old['sourceOnlyTree']=='fb5a7bb3cfd8f8bcd48628e1bc93232868a559bd'
assert source_hash(base)==binding['baseNonDocMap']=='2b7c2c128f6169308531d2bd4797089b8bcac107c78a01e5579d0d9791e954b3'
assert len(base)==11573 and len(non_docs(base))==8798
files=[];groups=[];refs=[];lossless=[];result=dict(base);by_blob={};known={r['sha']for r in base.values()}
for p,r in sorted(base.items()):
    if p.startswith('docs/')and r['type']=='blob'and r['mode']=='100644':by_blob.setdefault(r['sha'],p)
def retained(p):
    f=O/'files'/p;return f.read_bytes()if f.is_file()else git('show',BASE+':'+p)
def add(p,b,origin=None,kind=None):
    assert p.startswith('docs/')and p not in {r['path']for r in files}and len(p)<=216
    assert '..'not in PurePosixPath(p).parts and (p==PLAN or p not in base)
    target=O/'files'/p;write(target,b);m=meta(b)
    row=dict(path=p,scratchPath=str(target),mode='100644',**m,knownRemoteObject=m['blob']in known)
    if origin is not None:row['originalPath']=str(origin)
    if kind:row['preservationKind']=kind
    files.append(row);result[p]=dict(mode='100644',type='blob',sha=m['blob']);by_blob.setdefault(m['blob'],p);return row
def preserve(group,source,name=None):
    p=Path(source);p=p if p.is_absolute()else S/p;b=p.read_bytes();m=meta(b);prior=by_blob.get(m['blob'])
    if prior:
        assert retained(prior)==b;row=dict(path=prior,originalPath=str(p),mode='100644',**m,reuseExactPayload=True)
    else:row=add(DEST+group+'/'+(name or p.name),b,p)
    refs.append(row);return row
def group(name,scope,rows):groups.append(dict(name=name,scope=scope,files=rows))
def files_top(directory,extensions=None):
    return[p for p in sorted((S/directory).iterdir())if p.is_file()and(extensions is None or p.suffix in extensions)]
def checkpoint_payloads(path):
    d=json.loads((S/path).read_bytes());out=[]
    for row in d['payloads']:
        p=S/row['path'];b=p.read_bytes();m=meta(b)
        assert m['bytes']==row['bytes']and m['blob']==row.get('blob',row.get('gitBlob'))and m['sha256']==row['sha256']
        out.append(p)
    return out

previous=[]
for name in ['upload-manifest.json','root-prepublication-byte-review.json','root-remote-tree-review.json','root-actual-docs-readback.json','root-actual-source-readback.json',
             'created-docs-tree-response.json','created-source-tree-response.json','created-docs-commit-response.json','created-source-commit-response.json',
             'created-docs-commit-immutable-readback.json','created-source-commit-immutable-readback.json','ordinary-docs-push-response.json','ordinary-source-push-response.json',
             'fresh-pre-staging-guards.json','fresh-docs-precommit-guards.json','fresh-source-precommit-guards.json','post-docs-push-readback.json','post-source-push-readback.json',
             'actual-docs-git-fetch.json','actual-source-git-fetch.json','blob-upload-receipts.json','root-actual-docs-reader-schema-correction.json',
             'verify_actual_publication.py','verify_actual_publication_v2.py']:
    previous.append(preserve('models-publication','models-a-publication/'+name))
for name in ['models-a-independent-prepublication-review.json','models-a-independent-byte-tree-proof.json','models-a-independent-remote-tree-review.json',
             'models-a-independent-actual-docs-readback.json','models-a-independent-actual-source-readback.json']:
    previous.append(preserve('models-publication',name))
for name in ['remote-docs-tree-response.json','remote-source-tree-response.json']:
    p=S/'models-a-publication'/name;raw=p.read_bytes();b=gzip.compress(raw,compresslevel=9,mtime=0);assert gzip.decompress(b)==raw
    row=add(DEST+'models-publication/'+name+'.gz',b,p,'lossless full original response');previous.append(row);refs.append(row)
    lossless.append(dict(repositoryPath=row['path'],compressed=meta(b),decodedRaw=meta(raw),originalScratchPath=str(p),exactFullRawEquality=True))
group('Completed Models A publication custody','Actual9286 documentation andfc580 one-test publication, full original responses and independent readbacks. Original reader and additive schema correction retained; no runtime result implied.',previous)

packets=[
 ('taskboard-red','ci-72e6ec/taskboard','ci-72e6ec/taskboard/checkpoint-p11-red.json','Original72e full8 actual123/120PASS/3semanticFAIL/0SKIP, full author and independent R2. Later trace assertions unexecuted; Taskboard downstream absent, Team/static matrix-excluded.'),
 ('team-red','ci-72e6ec/team','ci-72e6ec/team/checkpoint-p11-red.json','Separate original72e Team full8 actual123/120PASS/3semanticFAIL/0SKIP. Independent R2; selected Team179/static/downstream blocked, no UI coverage.'),
 ('frontend','ci-72e6ec/frontend-all-shards','ci-72e6ec/frontend-all-shards/checkpoint-all-shards.json','All four original72e frontend shards and independent R2:25832PASS38SKIP0FAIL/2162files. Models80 only on old6c311/hook1176/formatter907f. No current Models90 or sourcefc580 qualification.'),
 ('creation-mac','ci-72e6ec/creation-macos','ci-72e6ec/creation-macos/checkpoint.json','Original macOS Creation FAIL waiting saved acknowledgement with wrong selected team; full R2, source and24PNG ZIP. Actual selection recipient/cause unknown; no final resultJSON or cleanup certificate.'),
 ('creation-win','ci-72e6ec/creation-windows','ci-72e6ec/creation-windows/checkpoint.json','Original Windows Creation SUCCESS, full R2/41member ZIP/32markers25flags. Separate forced cleanup observations, no nativeLaunch or natural-exit qualification; raw CRLF correction retained.'),
 ('creation-linux','ci-72e6ec/creation-ubuntu','ci-72e6ec/creation-ubuntu/checkpoint.json','Original Ubuntu Creation SUCCESS, full R2/41member ZIP/32markers25flags. Forced cleanup remains distinct from native/original-process qualification.'),
]
for key,directory,checkpoint,scope in packets:
    paths=set(files_top(directory))|set(checkpoint_payloads(checkpoint));rows=[]
    for p in sorted(paths):
        relative=p.relative_to(S);name=p.name if p.parent==S/directory else relative.parent.name+'-'+p.name
        rows.append(preserve(key,p,name))
    group(key,scope,rows)

for key,directory,scope in [
 ('win-process-x64','ci-72e6ec/native/process-windows-x64','Original72e Windows x64 Process FAIL at OpenCode, independently reviewed. Root6912 captured/unresumed, witness conjunction fails before wait; scenario cleanupfalse versus outertrue. Earlier Node/Electron scoped successes remain distinct.'),
 ('win-process-arm','ci-72e6ec/native/process-windows-arm64','Original72e Windows ARM Process FAIL at Codex readiness, independently reviewed. Pending Main resume spans firstClose/Stop; later unknown has no standalone earlier-cause implication. Root4048 captured/unresumed, witness wait unreached; scenariofalse/outertrue.'),
 ('win-v2-x64','ci-72e6ec/native/v2-windows-x64','Original72e Windows x64 V2 original declared flow SUCCESS, independently reviewed; nativecoord/full policy/P09 qualification flags remain false. Truncated254row epoch1 traces and original process boundaries preserved.'),
]:
    group(key,scope,[preserve(key,p)for p in files_top(directory)])

selection_rows=[]
for p in ['ci-72e6ec/creation-macos-selector-assessment/source-assessment.json','ci-72e6ec/creation-macos-selector-assessment/independent-current-caller-review.json']:
    selection_rows.append(preserve('creation-source-assessment',p))
group('Creation source assessment only','Original global substring choice weakness in standalone Creation callsite is source-supported. Actual failed recipient/cause unknown. No candidate or repair selected by this publication.',selection_rows)

raw_rows=[]
for path in ['ci-72e6ec/terminal-raw-retention-0935.json','ci-72e6ec/terminal-raw-retention-0943.json','ci-72e6ec/all18-desktop-p11-original-correlation.json']:
    raw_rows.append(preserve('desktop-raw',path))
    d=json.loads((S/path).read_bytes())
    def paths_in(value):
        if isinstance(value,dict):
            for k,v in value.items():
                if k in ('path','logPath','responsePath','rawPath')and isinstance(v,str):
                    p=Path(v);p=p if p.is_absolute()else S/p
                    if p.is_file()and p.suffix in ('.log','.json')and p.name in ('job.log','job-original-response.json'):yield p
                yield from paths_in(v)
        elif isinstance(value,list):
            for v in value:yield from paths_in(v)
    for p in sorted(set(paths_in(d))):raw_rows.append(preserve('desktop-raw',p,p.parent.name+'-'+p.name))
for p in files_top('ci-72e6ec/general-plan'):
    raw_rows.append(preserve('general-plan',p))
raw_rows.append(preserve('general-plan','ci-72e6ec/general-jobs-0945.json'))
for p in ['ci-72e6ec/official-host-artifacts-0935.json','ci-72e6ec/owned-jobs-0934.json','ci-72e6ec/owned-jobs-0942.json',
          'ci-72e6ec/official-host-artifacts-0943.json','ci-72e6ec/official-packaged-artifacts-0943.json']:
    raw_rows.append(preserve('desktop-raw',p))
for p in ['ci-72e6ec/packaged-mac-arm/archive-retention.json','ci-72e6ec/packaged-mac-arm/artifact-14213456571.zip']:
    raw_rows.append(preserve('packaged-mac-raw',p))
group('Additional original raw retention only','Other completed72e Desktop logs and metadata retained without extending the full case-level Taskboard/Team R2. Mac Installer reports119PASS/3FAIL/1 originalSKIP. The packaged macARM full raw and original9-member ZIP are retained only; semantic audit remains pending at this cut. General plan SUCCESS is classifier execution only; downstream queued or skipped does not imply qualification.',raw_rows)

authority=[]
for p in sorted((S/'p11-b-current-fc580').rglob('*')):
    if not p.is_file():continue
    rel=p.relative_to(S/'p11-b-current-fc580');name=rel.name if len(rel.parts)==1 else rel.parts[0]+'-'+rel.name+'.txt'
    authority.append(preserve('current-b',p,name))
group('Current P11 B authority and complete source','Actual independent original RED enables current one-driver2assertions B. Full preimage/candidate/patches/suffix48freshpins and independent source/R1 R2. Current Models A preserved; Models B/P11 C not selected.',authority)

group('Preparation storage recovery','First inert writer stopped before manifest/commit on ENOSPC. Additive resume compares every existing partial payload exactly; verified duplicate storage deduplication preserves all paths, bodies and modes. No source or result changed.',[preserve('preparation',p)for p in ['p11-b-publication/prepare.py','p11-b-publication/prepare_resume_v2.py','p11-b-publication/preparation-enospc-provenance.json','workspace-duplicate-storage-recovery-20261116-0952.json']])

prefix=git('show',BASE+':'+PLAN);assert meta(prefix)==old['fullPlanResult']and len(prefix)==2130841
segments=[];plan=prefix
for label,p in [
 ('Original72e all four frontend shards','ci-72e6ec/frontend-all-shards/Plan29-all-frontend-shards-appendix.md'),
 ('First actual original P11 semantic RED','ci-72e6ec/taskboard/Plan29-p11-first-original-red-appendix.md'),
 ('Separate original Team semantic RED','ci-72e6ec/team/Plan29-p11-team-original-red-appendix.md'),
 ('Original72e macOS Creation failure','ci-72e6ec/creation-macos/Plan29-appendix.md'),
 ('Original72e Windows Creation result','ci-72e6ec/creation-windows/Plan29-appendix.md'),
 ('Original72e Ubuntu Creation result','ci-72e6ec/creation-ubuntu/Plan29-appendix.md'),
 ('Current P11 B source/R1 governs last','p11-b-current-fc580/R1-current-p11-deadline-fix.md'),
]:
    b=(S/p).read_bytes();m=meta(b);assert m['blob']in by_blob
    segments.append(dict(label=label,repositoryPath=by_blob[m['blob']],**m,separatorOffset=len(plan),contentOffset=len(plan)+2));plan+=b'\n\n'+b
assert meta((S/'p11-b-current-fc580/R1-current-p11-deadline-fix.md').read_bytes())['blob']==binding['R1']['blob']
add(PLAN,plan)
source_changes=[]
for row in binding['paths']:
    p=row['path'];a=git('show',BASE+':'+p);b=(S/'p11-b-current-fc580/candidate'/p).read_bytes()
    assert meta(a)=={k:row['preimage'][k]for k in ('bytes','blob','sha256')}and meta(b)=={k:row['candidate'][k]for k in ('bytes','blob','sha256')}
    source_changes.append(dict(path=p,mode=row['mode'],preimage=meta(a),candidate=meta(b),candidateScratchPath=str(S/'p11-b-current-fc580/candidate'/p),addedLines=2,removedLines=0))
assert len(source_changes)==1
for row in binding['freshPins']:assert meta(git('show',BASE+':'+row['path']))=={k:row[k]for k in ('bytes','blob','sha256')}
inherited=old['groups']+old['inheritedPreviousGroups'];assert sum(len(g['files'])for g in inherited)==474
for g in inherited:
    for row in g['files']:assert meta(retained(row['path']))=={k:row[k]for k in ('bytes','blob','sha256')}
for row in old['files']:
    if row['path']!=PLAN:assert retained(row['path'])==Path(row['scratchPath']).read_bytes()
for move in old['preservedExactMoves']:assert move['from']not in result and result[move['to']]==dict(mode=move['mode'],type='blob',sha=move['blob'])
assert non_docs(result)==non_docs(base)and all(result[p]==r for p,r in base.items()if p!=PLAN)
assert max(map(len,result))==216
archives=json.loads(json.dumps(old['archives']));archive_by_blob={a['blob']:a for a in archives}
for row in refs:
    if not row['path'].endswith('.zip'):continue
    b=retained(row['path']);m=meta(b)
    if m['blob']in archive_by_blob:
        olda=archive_by_blob[m['blob']]
        if row['path']not in olda['repositoryPaths']:olda['repositoryPaths'].append(row['path'])
        continue
    with zipfile.ZipFile(io.BytesIO(b))as z:
        assert z.testzip()is None;members=[]
        for info in z.infolist():
            assert not PurePosixPath(info.filename).is_absolute()and '..'not in PurePosixPath(info.filename).parts
            members.append(dict(path=info.filename,**meta(z.read(info.filename)),crc32=f'{info.CRC:08x}'))
    a=dict(**m,repositoryPaths=[row['path']],members=members);archives.append(a);archive_by_blob[m['blob']]=a
assert len(archives)==29 and sum(len(a['members'])for a in archives)==339
inherited_gzip=old['losslessOriginalTreeResponses']+old['inheritedLosslessOriginalTreeResponses'];assert len(inherited_gzip)==6
index=dict(schema='current-p11-b-and-original-e3-index/v1',base=BASE,primaryAtPreparation=PRIMARY,groups=groups,inheritedPreviousGroups=inherited,
           previousManifest=meta((S/'models-a-publication/upload-manifest.json').read_bytes()),sourceChanges=source_changes,fullPlanPrefix=meta(prefix),planSegments=segments,
           planResult=meta(plan),freshPins=binding['freshPins'],sourceR2=meta(r2path.read_bytes()),archives=archives,losslessOriginalTreeResponses=lossless,
           inheritedLosslessOriginalTreeResponses=inherited_gzip,P11BSelected=True,P11CSelected=False,ModelsAAlreadyPublished=True,ModelsBSelected=False,
           actualP11SemanticRedAvailable=True,P11ResultingGreenAvailable=False,ModelsActualRedAvailable=False,primaryAdvanced=False,candidateExecuted=False)
index_row=add(DEST+'publication-index.json',(json.dumps(index,ensure_ascii=False,indent=2)+'\n').encode())
docs_sha,docs_dirs=merkle(result);overrides={r['path']:dict(mode=r['mode'],type='blob',sha=r['candidate']['blob'])for r in source_changes}
source={**result,**overrides};source_sha,source_dirs=merkle(source)
assert source_hash(source)==binding['projectedNonDocMap']=='15486b81750d93df49ccf4e374ba006dadfb21f779b530c8876ea16e7e6fd812'
assert {p for p in source if source[p]!=result[p]}==set(overrides)
manifest=dict(schema='current-p11-b-docs-then-one-driver-manifest/v1',createdAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),base=BASE,baseTree=old['sourceOnlyTree'],originalPrimary=PRIMARY,
              expectedTree=docs_sha,sourceOnlyTree=source_sha,sourceCommitParents=['EXACT_VERIFIED_DOCUMENTATION_CHILD'],files=files,fileCount=len(files),newPayloadBytes=sum(r['bytes']for r in files),
              groups=groups,allPreservedPayloadReferenceCount=len(refs),inheritedPreviousGroups=inherited,inheritedReferenceCount=474,unchangedPriorNonPlanPayloadCount=len(old['files'])-1,
              previousManifest=meta((S/'models-a-publication/upload-manifest.json').read_bytes()),archives=archives,uniqueArchiveCount=len(archives),archiveMemberCount=sum(len(a['members'])for a in archives),
              losslessOriginalTreeResponses=lossless,inheritedLosslessOriginalTreeResponses=inherited_gzip,fullLeafCount=len(result),unchangedOriginalLeaves=len(base)-1,nonDocumentationLeafCount=8798,
              nonDocumentationMapSha256=source_hash(result),sourceOnlyNonDocumentationMapSha256=source_hash(source),sourceChanges=source_changes,sourceOnlyTreeElements=[dict(path=p,**r)for p,r in overrides.items()],
              freshSourcePins=binding['freshPins'],preservedExactMoves=old['preservedExactMoves'],maximumRelativePathCharacters=216,fullPlanPrefix=meta(prefix),fullPlanResult=meta(plan),planSegments=segments,
              publicationIndex={k:index_row[k]for k in ('path','bytes','blob','sha256')},sourceR2=meta(r2path.read_bytes()),documentationDirectoryCountIncludingRoot=len(docs_dirs),sourceDirectoryCountIncludingRoot=len(source_dirs),
              sourceChangeInDocumentationCommit=False,P11BSelected=True,P11CSelected=False,ModelsAAlreadyPublished=True,ModelsBSelected=False,primaryAdvanced=False,candidateExecutionClaimed=False,
              treeElements=[dict(path=r['path'],mode=r['mode'],type='blob',sha=r['blob'])for r in files])
for name,value in [('full-docs-tree.json',dict(tree=result,directories=docs_dirs)),('full-source-tree.json',dict(tree=source,directories=source_dirs)),('upload-manifest.json',manifest)]:write(O/name,(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode())
print(json.dumps(dict(manifest=meta((O/'upload-manifest.json').read_bytes()),files=len(files),payloadBytes=manifest['newPayloadBytes'],refs=len(refs),inheritedRefs=474,
                     docsTree=docs_sha,sourceTree=source_sha,leaves=len(result),directories=len(docs_dirs),plan=meta(plan),newBlobs=len({r['blob']for r in files if not r['knownRemoteObject']}))))
