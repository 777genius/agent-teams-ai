from pathlib import Path
import datetime,gzip,hashlib,io,json,subprocess,sys,zipfile

S=Path('/workspace/scratch/82d3f9ba6b85');O=Path(__file__).parent;R=S/'agent-teams-e2e'
M=json.loads((O/'upload-manifest.json').read_bytes())
KIND,COMMIT=sys.argv[1:3]
assert KIND in ('docs','source')and len(COMMIT)==40
PLAN='docs/plans/provider-migration/frontend-parity-2026-11-12/29-reconciled-acceptance-and-custody-followups-2026-11-15.md'

def git(*args):return subprocess.check_output(['git',*args],cwd=R)
def identity(b):return dict(bytes=len(b),blob=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest(),sha256=hashlib.sha256(b).hexdigest())
def decode(r):
    d=r.get('structuredContent',r)
    return json.loads(d['content'])if isinstance(d.get('content'),str)else d
def read(p):return git('show',COMMIT+':'+p)

DOCS=decode(json.loads((O/'created-docs-commit-response.json').read_bytes()))['sha']
expected_parents=[M['base']]if KIND=='docs'else[DOCS]
expected_tree=M['expectedTree']if KIND=='docs'else M['sourceOnlyTree']
raw_commit=git('cat-file','commit',COMMIT)
assert hashlib.sha1(b'commit '+str(len(raw_commit)).encode()+b'\0'+raw_commit).hexdigest()==COMMIT
header=raw_commit.split(b'\n\n',1)[0].splitlines()
tree=next(l[5:].decode()for l in header if l.startswith(b'tree '));parents=[l[7:].decode()for l in header if l.startswith(b'parent ')]
assert tree==expected_tree and parents==expected_parents
api=decode(json.loads((O/('created-'+KIND+'-commit-immutable-readback.json')).read_bytes()))
assert api['sha']==COMMIT and api['tree']['sha']==tree and [p['sha']for p in api['parents']]==parents
assert decode(json.loads((O/('ordinary-'+KIND+'-push-response.json')).read_bytes()))['success']is True
expected=json.loads((O/('full-'+KIND+'-tree.json')).read_bytes()); leaves,dirs,sizes={}, {'':tree},{}
for row in git('ls-tree','-r','-t','-z','-l',COMMIT).split(b'\0'):
    if not row:continue
    raw,path=row.split(b'\t',1);mode,kind,sha,size=raw.decode().split();p=path.decode()
    if kind=='tree':assert mode=='040000'and size=='-';dirs[p]=sha
    else:leaves[p]=dict(mode=mode,type=kind,sha=sha);sizes[p]=None if size=='-'else int(size)
assert leaves==expected['tree']and dirs==expected['directories']and len(leaves)==11573 and len(dirs)==1748
payloads=[];seen={}
for row in M['files']:
    b=read(row['path']); assert b==Path(row['scratchPath']).read_bytes()
    assert identity(b)=={k:row[k]for k in ('bytes','blob','sha256')}and sizes[row['path']]==len(b)
    seen[row['path']]=identity(b);payloads.append(dict(path=row['path'],**identity(b),completePublishedBodyEqual=True))
assert len(payloads)==43 and sum(r['bytes']for r in payloads)==9309338
refs=[]
for inherited,groups in [(False,M['groups']),(True,M['inheritedPreviousGroups'])]:
    for group in groups:
        for row in group['files']:
            found=seen.setdefault(row['path'],identity(read(row['path'])))
            assert found=={k:row[k]for k in ('bytes','blob','sha256')}
            refs.append(dict(path=row['path'],inherited=inherited,**found))
assert len(refs)==474 and sum(r['inherited']for r in refs)==403
plan=read(PLAN);base_plan=git('show',M['base']+':'+PLAN);prefix=plan[:M['fullPlanPrefix']['bytes']]
assert prefix.startswith(base_plan)and identity(prefix)==M['fullPlanPrefix']and identity(base_plan)==M['fullPlanPrefix']
cursor=len(prefix)
for row in M['planSegments']:
    b=read(row['repositoryPath']);assert identity(b)=={k:row[k]for k in ('bytes','blob','sha256')}
    assert row['separatorOffset']==cursor and row['contentOffset']==cursor+2 and plan[cursor:cursor+2]==b'\n\n'
    assert plan[cursor+2:cursor+2+len(b)]==b;cursor+=2+len(b)
assert cursor==len(plan)==2130841 and identity(plan)==M['fullPlanResult']
old=json.loads((S/'e3-preinput-copy-publication/upload-manifest.json').read_bytes())
for row in old['files']:
    if row['path']!=PLAN:assert read(row['path'])==Path(row['scratchPath']).read_bytes()
archives=[]
for row in M['archives']:
    b=read(row['repositoryPaths'][0]);assert identity(b)=={k:row[k]for k in ('bytes','blob','sha256')}
    with zipfile.ZipFile(io.BytesIO(b))as z:
        assert z.testzip()is None
        members=[dict(path=i.filename,**identity(z.read(i.filename)),crc32=f'{i.CRC:08x}')for i in z.infolist()]
    assert members==row['members'];archives.append(dict(path=row['repositoryPaths'][0],**identity(b),members=len(members)))
assert len(archives)==18 and sum(r['members']for r in archives)==180
for row in M['losslessOriginalTreeResponses']+M['inheritedLosslessOriginalTreeResponses']:
    b=read(row['repositoryPath']);assert identity(b)==row['compressed']and identity(gzip.decompress(b))==row['decodedRaw']
    assert gzip.decompress(b)==Path(row['originalScratchPath']).read_bytes()
source_bodies=[]
for row in M['sourceChanges']:
    b=read(row['path']);assert identity(b)==row['preimage'if KIND=='docs'else'candidate']
    source_bodies.append(dict(path=row['path'],**identity(b)))
source_rows=[dict(path=p,**r)for p,r in sorted(leaves.items())if not p.startswith('docs/')]
digest=hashlib.sha256(json.dumps(source_rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
assert len(source_rows)==8798 and digest==M['nonDocumentationMapSha256'if KIND=='docs'else'sourceOnlyNonDocumentationMapSha256']
if KIND=='source':
    docrows=json.loads((O/'full-docs-tree.json').read_bytes())['tree']
    assert {p for p in leaves if leaves[p]!=docrows[p]}=={r['path']for r in M['sourceChanges']}
    assert all(leaves[p]==r for p,r in docrows.items()if p.startswith('docs/'))
    suffix=git('show',M['originalPrimary']+':scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts')[-4264:]
    assert read('scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts')[-4264:]==suffix and identity(suffix)['blob']=='08699c4890b2ef83bcbda53094c450c6a9c3b366'
for move in M['preservedExactMoves']:
    assert move['from']not in leaves and leaves[move['to']]==dict(mode=move['mode'],type='blob',sha=move['blob'])
assert max(map(len,leaves))==216
post=json.loads((O/('post-'+KIND+'-push-readback.json')).read_bytes());refs_api={}
for row in post['readbacks']:
    assert row['status']=='fulfilled';refs_api[row['value']['name']]=decode(row['value']['result'])
assert refs_api['followup']['object']['sha']==COMMIT and refs_api['primary']['object']['sha']==M['originalPrimary']
pr=refs_api['pr'];assert pr['head']['sha']==M['originalPrimary']and pr['state']=='open'and pr['draft']is True and pr['base']['sha']=='def734338f13bcc3209e78079a0cedbc48f05a5b'
report=dict(schema='root-models-a-publication-actual-'+KIND+'-readback/v1',atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),verdict='ACTUAL complete immutable Git bytes/tree/history and ordinary ref publication verified',
            manifest=identity((O/'upload-manifest.json').read_bytes()),commit=COMMIT,tree=tree,orderedParents=parents,immutableApiAndGitAgree=True,rawCommitSHA256=hashlib.sha256(raw_commit).hexdigest(),
            fullLeafCount=len(leaves),directoryCount=len(dirs),allLeavesAndDirectoriesEqual=True,payloads=payloads,payloadBytes=9309338,referenceMappings=refs,
            plan=identity(plan),prefix=identity(prefix),actualBasePlan=identity(base_plan),soleCurrentR1AppendedExact=True,all262PriorNonPlanPayloadsExact=True,
            archives=archives,soleFullTestSourceBody=source_bodies,sourceMap=digest,nonDocLeaves=8798,sourceDeltaCount=0 if KIND=='docs' else 1,
            wholeCurrentP11GeometryPreserved=True,P11BCSelected=False,ModelsATestApplied=KIND=='source',ModelsBSelected=False,primaryAdvanced=False,all40MovesExact=True,maximumPathCharacters=216,
            postPushObservedAtUTC=post['observedAtUTC'],postPushRefs=dict(followup=COMMIT,primary=M['originalPrimary'],prOpenDraft=True,base=pr['base']['sha']),
            noProjectOrNativeExecution=True,sourceResultClaimed=False,independentActualReadbackRequired=True)
out=O/('root-actual-'+KIND+'-readback.json')
with out.open('xb')as f:f.write((json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode())
print(json.dumps(dict(report=str(out),**identity(out.read_bytes()),commit=COMMIT,parents=parents,tree=tree)))
