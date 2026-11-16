from pathlib import Path
import datetime,difflib,hashlib,json,re,subprocess

S=Path('/workspace/scratch/82d3f9ba6b85');O=Path(__file__).parent;R=S/'agent-teams-e2e'
BASE='fc580db9bafbe7d9f28dc86edd484af3e151de6f';PRIMARY='72e6ec04444969d343d73834c70bc4e261100fc9'
P='scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts'
TEST='scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts'
PLAN='docs/plans/provider-migration/frontend-parity-2026-11-12/29-reconciled-acceptance-and-custody-followups-2026-11-15.md'
assert not (O/'candidate-metadata.json').exists()
def git(*a):return subprocess.check_output(['git',*a],cwd=R)
def identity(b):return dict(bytes=len(b),lines=len(b.splitlines()),blob=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest(),sha256=hashlib.sha256(b).hexdigest())
def write(p,b):
    p.parent.mkdir(parents=True,exist_ok=True)
    with p.open('xb')as f:f.write(b)
def leaves(ref):
    result={}
    for row in git('ls-tree','-rz',ref).split(b'\0'):
        if not row:continue
        h,p=row.split(b'\t',1);mode,kind,sha=h.decode().split();result[p.decode()]=dict(mode=mode,type=kind,sha=sha)
    return result
def source_hash(rows):
    r=[dict(path=p,**v)for p,v in sorted(rows.items())if not p.startswith('docs/')]
    return hashlib.sha256(json.dumps(r,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def apply(original,patch):
    old=original.decode().splitlines(True);ls=patch.decode().splitlines(True)[2:];out=[];cursor=0;i=0
    while i<len(ls):
        h=re.fullmatch(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\n',ls[i]);assert h
        start=int(h.group(1))-1;assert start>=cursor;out.extend(old[cursor:start]);cursor=start;i+=1;old_count=new_count=0
        while i<len(ls)and not ls[i].startswith('@@ '):
            op,value=ls[i][0],ls[i][1:];assert op in (' ','-','+')
            if op in (' ','-'):assert old[cursor]==value;cursor+=1;old_count+=1
            if op in (' ','+'):out.append(value);new_count+=1
            i+=1
        assert old_count==int(h.group(2)or 1)and new_count==int(h.group(4)or 1)
    out.extend(old[cursor:]);return ''.join(out).encode()

root=json.loads((S/'models-a-publication/root-actual-source-readback.json').read_bytes())
ind=json.loads((S/'models-a-independent-actual-source-readback.json').read_bytes())
assert root['commit']==BASE and root['tree']=='fb5a7bb3cfd8f8bcd48628e1bc93232868a559bd'and ind['result']=='APPROVE'and ind['tree']==root['tree']
before=git('show',BASE+':'+P);red_before=git('show',PRIMARY+':'+P)
after=(S/'p11-v2-live-membership-proposal/conditional-poll-green'/P).read_bytes()
assert before==red_before and identity(before)['blob']=='bd8bc728808eda00a45b300fd328d49e4e919bc2'
assert identity(after)['blob']=='5026f0ec6165bb092717ddc989043848a25081dc'
assert len(before)==45707 and len(after)==45795 and len(before.splitlines())==570 and len(after.splitlines())==572
patch=''.join(difflib.unified_diff(before.decode().splitlines(True),after.decode().splitlines(True),fromfile='a/'+P,tofile='b/'+P)).encode()
reverse=''.join(difflib.unified_diff(after.decode().splitlines(True),before.decode().splitlines(True),fromfile='b/'+P,tofile='a/'+P)).encode()
adds=[l[1:]for l in patch.decode().splitlines(True)if l.startswith('+')and not l.startswith('+++')]
deletes=[l for l in patch.decode().splitlines(True)if l.startswith('-')and not l.startswith('---')]
assert adds==['    assert.ok(Date.now() < cutoff, label);\n','      assert.ok(Date.now() < cutoff, label);\n']and not deletes
assert apply(before,patch)==after and apply(after,reverse)==before
assert after.replace(adds[0].encode(),b'',1).replace(adds[1].encode(),b'',1)==before
assert patch==(S/'p11-v2-live-membership-proposal/conditional-poll-green.patch').read_bytes()
test=git('show',BASE+':'+TEST);old_test=git('show',PRIMARY+':'+TEST);suffix=test[-4264:]
assert identity(test)['blob']=='1b0ad5b15b056857817858d1e85f6dfe81f6e782'
assert suffix==old_test[-4264:]and identity(suffix)['blob']=='08699c4890b2ef83bcbda53094c450c6a9c3b366'
for b in [before,after]:
    assert b.count(b'  const poll = async <T>(')==b.count(b"  const workspace = join(fixture.root, 'workspace');")==1
    poll=b[b.index(b'  const poll = async <T>('):b.index(b"  const workspace = join(fixture.root, 'workspace');")]
    assert poll.count(b'Date.now() + 90_000')==1 and poll.count(b'setTimeout(resolve, 100)')==1 and poll.count(b'await observe()')==2
base=leaves(BASE);projected={**base,P:dict(mode=base[P]['mode'],type='blob',sha=identity(after)['blob'])}
assert len([p for p in base if not p.startswith('docs/')])==8798 and {p for p in base if base[p]!=projected[p]}=={P}
assert source_hash(base)=='2b7c2c128f6169308531d2bd4797089b8bcac107c78a01e5579d0d9791e954b3'
assert source_hash(projected)=='15486b81750d93df49ccf4e374ba006dadfb21f779b530c8876ea16e7e6fd812'
old_proof=json.loads((S/'ci-72e6ec/taskboard/p11-byte-source-proof.json').read_bytes())
old_pins={r['path']:r for r in old_proof['sourceLeaves']};assert len(old_pins)==29
paths=set(old_pins)|{r['path']for r in json.loads((S/'models-phase-a-current-bfc/candidate-metadata.json').read_bytes())['freshPins']}
pins=[];changes_from_red=[]
for p in sorted(paths):
    b=git('show',BASE+':'+p);a=git('show',PRIMARY+':'+p)
    assert identity(b)['blob']==base[p]['sha']
    pins.append(dict(path=p,mode=base[p]['mode'],**identity(b),sameOriginalRedSource=a==b,originalRedSource=identity(a),wasIn29OriginalRedPins=p in old_pins))
    if p in old_pins:
        assert all(identity(a)[k]==old_pins[p][k]for k in ('bytes','blob','sha256'))
        if a!=b:changes_from_red.append(p)
assert sorted(changes_from_red)==sorted([TEST,'scripts/legacy-agent-host/desktop-ui-controls.ts'])
workflow=git('show',BASE+':.github/workflows/host-emulated-acceptance.yml').decode()
start=workflow.index('          pnpm lint:fast:files -- \\\n');end=workflow.index('          pnpm typecheck:workspace',start)
fast=[line.strip().rstrip('\\').strip()for line in workflow[start:end].splitlines()[1:]if line.strip()]
assert len(fast)==93 and P not in fast
compiler=json.loads(git('show',BASE+':tsconfig.legacy-agent-host-scripts.json'))
assert 'scripts/legacy-agent-host/**/*.ts'in compiler['include']
parents=git('show','-s','--format=%P',BASE).decode().strip().split();assert parents==['9286c1009a3b6348598a7ded7b93cfc582d18d6d']
plan=git('show',BASE+':'+PLAN);assert len(plan)==2130841 and identity(plan)['blob']=='237c4b2ed5aac8fdca85da31222b3f95c3c1bb9b'
r1=(O/'R1-current-p11-deadline-fix.md').read_bytes()
references=[]
for p in ['models-a-publication/root-actual-source-readback.json','models-a-independent-actual-source-readback.json',
          'ci-72e6ec/taskboard/checkpoint-p11-red.json','ci-72e6ec/taskboard/p11-semantic-red-audit.json','ci-72e6ec/taskboard/p11-byte-source-proof.json',
          'ci-72e6ec/taskboard/independent-p11-semantic-red-review.json','ci-72e6ec/taskboard/independent-p11-red-byte-source-proof.json',
          'ci-72e6ec/team/checkpoint-p11-red.json','ci-72e6ec/team/independent-p11-team-red-review.json']:
    b=(S/p).read_bytes();references.append(dict(path=p,**identity(b)))
write(O/'preimage'/P,before);write(O/'candidate'/P,after);write(O/'candidate.patch',patch);write(O/'reverse.patch',reverse)
write(O/'unchanged-p11-regression-suffix.txt',suffix)
meta=dict(kind='Fresh actual fc580 P11 one-driver Phase B source and R1 binding',atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),
          base=BASE,baseTree=root['tree'],baseParents=parents,primaryAtPreparation=PRIMARY,planPrefix=identity(plan),
          paths=[dict(path=P,mode=base[P]['mode'],preimage=identity(before),candidate=identity(after),addedLines=2,removedLines=0)],
          patch=identity(patch),reversePatch=identity(reverse),wholeInverseExact=True,wholeSourceEqualOriginalRedDriver=True,exactHistoricalConditionalB=True,
          R1=identity(r1),unchangedP11Suffix=identity(suffix),fullCurrentP11Test=identity(test),freshPins=pins,freshPinCount=len(pins),
          changedFromOriginal29RedPins=changes_from_red,baseNonDocMap=source_hash(base),projectedNonDocMap=source_hash(projected),allOther8797NonDocLeavesUnchanged=True,
          actualRed=dict(source=PRIMARY,runId=43831885807,jobId=133178913159,total=123,passed=120,failed=3,skipped=0,cancelled=0,independentReview='fb7f28180bd65d164a3e22990c76a898fb3d1666',laterTraceAssertionsExecuted=False),
          originalTeamSupplement=dict(jobId=133178913364,total=123,passed=120,failed=3,independentReview='0fff8c06b5aadf10fe91aa6129f52338f3bb613a',downstreamTeamAndStaticExecuted=False),
          references=references,fastLint=dict(pathCount=93,driverIncluded=False,unchanged=True),compilerSourceInclude='scripts/legacy-agent-host/**/*.ts',
          phaseAccounting=dict(P11BSelectedForReview=True,P11CSelected=False,ModelsAAlreadyPublished=True,ModelsBSelected=False,ModelsActualRed=None,P11ResultingSourceActualGreen=None),
          predictionsOnly=dict(nextWholeEightCases=133,expectedWholeEightFailures=0,ModelsFileTotal=90,ModelsExpectedPass=84,ModelsExpectedSemanticFail=6),
          productionModelsHookUnchanged='1176fd06b70f1b717ba83deb387f87b05b18b45b',ModelsTestPreserved='48bf7f181ae6836a9003ebe687abab0a0ae2db20',
          sourceObjectRefMutation=False,projectExecution=False)
write(O/'candidate-metadata.json',(json.dumps(meta,ensure_ascii=False,indent=2)+'\n').encode())
print(json.dumps(dict(metadata=identity((O/'candidate-metadata.json').read_bytes()),R1=identity(r1),pins=len(pins),patch=identity(patch),projectedMap=source_hash(projected))))
