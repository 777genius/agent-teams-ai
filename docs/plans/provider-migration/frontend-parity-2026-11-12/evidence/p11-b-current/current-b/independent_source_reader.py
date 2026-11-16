import datetime, difflib, hashlib, json, pathlib, re, subprocess

ROOT = pathlib.Path('/workspace/scratch/82d3f9ba6b85')
BASE = ROOT / 'p11-b-current-fc580'
REPO = ROOT / 'agent-teams-e2e'
HEAD = 'fc580db9bafbe7d9f28dc86edd484af3e151de6f'
RED = '72e6ec04444969d343d73834c70bc4e261100fc9'
PATH = 'scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts'
TEST = 'scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts'
PLAN = 'docs/plans/provider-migration/frontend-parity-2026-11-12/29-reconciled-acceptance-and-custody-followups-2026-11-15.md'

def ident(data, path=None):
    out = {'bytes': len(data), 'lines': len(data.splitlines()), 'blob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest(), 'sha256': hashlib.sha256(data).hexdigest()}
    return {'path': str(path.relative_to(ROOT)) if isinstance(path, pathlib.Path) else path, **out} if path is not None else out

def ref(path):
    return ident(path.read_bytes(), path)

def read(path):
    return json.loads(path.read_bytes())

def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO)

def apply_unified(data, patch):
    old, lines = data.decode().splitlines(True), patch.decode().splitlines(True)
    assert lines[0].startswith('--- ') and lines[1].startswith('+++ ')
    cursor, out, index = 0, [], 2
    while index < len(lines):
        match = re.fullmatch(r'@@ -(\d+),(\d+) \+(\d+),(\d+) @@\n', lines[index])
        assert match
        start, old_count, new_start, new_count = map(int, match.groups())
        assert start - 1 >= cursor
        out.extend(old[cursor:start - 1]); cursor = start - 1
        assert len(out) == new_start - 1
        index += 1
        removed = added = 0
        while index < len(lines) and not lines[index].startswith('@@ '):
            operation, text = lines[index][0], lines[index][1:]
            assert operation in ' +-'
            if operation in ' -':
                assert old[cursor] == text
                cursor += 1; removed += 1
            if operation in ' +':
                out.append(text); added += 1
            index += 1
        assert (removed, added) == (old_count, new_count)
    out.extend(old[cursor:])
    return ''.join(out).encode()

def freeze(name, value):
    path = BASE / name
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    with path.open('xb') as stream:
        stream.write(data)
    assert path.read_bytes() == data
    return ref(path)

metadata_path = BASE / 'candidate-metadata.json'
r1_path = BASE / 'R1-current-p11-deadline-fix.md'
meta = read(metadata_path)
assert ref(metadata_path)['blob'] == '14665c362e87082daeefffdb2dab836ee60110da'
assert ref(r1_path)['blob'] == '2b335707039efabbba75f223a7a1bbcf1a12ed34'
assert ident(r1_path.read_bytes()) == meta['R1']
assert meta['base'] == HEAD and meta['primaryAtPreparation'] == RED
inputs = [metadata_path, r1_path, BASE / 'candidate.patch', BASE / 'reverse.patch', BASE / 'unchanged-p11-regression-suffix.txt', BASE / 'preimage' / PATH, BASE / 'candidate' / PATH]
inputs_before = [ref(path) for path in inputs]
for row in meta['references']:
    assert ref(ROOT / row['path']) == row
root_readback = read(ROOT / 'models-a-publication/root-actual-source-readback.json')
independent_readback = read(ROOT / 'models-a-independent-actual-source-readback.json')
assert root_readback['commit'] == HEAD and root_readback['tree'] == meta['baseTree']
assert independent_readback['result'] == 'APPROVE' and independent_readback['tree'] == meta['baseTree']
commit = git('cat-file', 'commit', HEAD)
assert hashlib.sha1(b'commit ' + str(len(commit)).encode() + b'\0' + commit).hexdigest() == HEAD
commit_lines = commit.decode().splitlines()
assert commit_lines[0] == 'tree ' + meta['baseTree']
assert [line[7:] for line in commit_lines if line.startswith('parent ')] == meta['baseParents'] == ['9286c1009a3b6348598a7ded7b93cfc582d18d6d']
tree = {}
for row in git('ls-tree', '-rz', HEAD).split(b'\0'):
    if not row:
        continue
    header, path = row.split(b'\t', 1)
    mode, kind, blob = header.decode().split()
    tree[path.decode()] = {'mode': mode, 'type': kind, 'sha': blob}
assert len([path for path in tree if not path.startswith('docs/')]) == 8798
def map_hash(rows):
    values = [{'path': path, **value} for path, value in sorted(rows.items()) if not path.startswith('docs/')]
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
assert map_hash(tree) == meta['baseNonDocMap'] == '2b7c2c128f6169308531d2bd4797089b8bcac107c78a01e5579d0d9791e954b3'

pins = meta['freshPins']
assert len(pins) == meta['freshPinCount'] == 48 and len({row['path'] for row in pins}) == 48
specifications = [(revision, row['path']) for revision in (HEAD, RED) for row in pins]
batch = subprocess.run(['git', 'cat-file', '--batch'], cwd=REPO, input=('\n'.join(revision + ':' + path for revision, path in specifications) + '\n').encode(), capture_output=True, check=True).stdout
bodies, offset = {}, 0
for revision, path in specifications:
    end = batch.index(b'\n', offset)
    blob, kind, length = batch[offset:end].decode().split(); length = int(length)
    data = batch[end + 1:end + 1 + length]
    assert kind == 'blob' and len(data) == length and batch[end + 1 + length:end + 2 + length] == b'\n'
    assert ident(data)['blob'] == blob
    bodies[revision, path] = data
    offset = end + 2 + length
assert offset == len(batch)
old_proof = read(ROOT / 'ci-72e6ec/taskboard/independent-p11-red-byte-source-proof.json')
old_source = {row['path']: row for row in old_proof['fresh648GitObjects']}
old_author = read(ROOT / 'ci-72e6ec/taskboard/p11-byte-source-proof.json')
old_29 = {row['path'] for row in old_author['sourceLeaves']}
observed = []
changed_original = []
for row in pins:
    path = row['path']; actual, old = bodies[HEAD, path], bodies[RED, path]
    identity = ident(actual)
    assert all(identity[key] == row[key] for key in identity)
    assert tree[path] == {'mode': row['mode'], 'type': 'blob', 'sha': identity['blob']}
    assert ident(old) == row['originalRedSource'] and (actual == old) == row['sameOriginalRedSource']
    assert row['wasIn29OriginalRedPins'] == (path in old_29)
    if path in old_29:
        assert all(ident(old)[key] == old_source[path][key] for key in ('bytes', 'blob', 'sha256'))
        if old != actual:
            changed_original.append(path)
    observed.append({'path': path, 'mode': row['mode'], **identity, 'sameOriginalRedSource': actual == old, 'wasIn29OriginalRedPins': path in old_29})
assert changed_original == meta['changedFromOriginal29RedPins'] == [TEST, 'scripts/legacy-agent-host/desktop-ui-controls.ts']
plan = git('show', HEAD + ':' + PLAN)
assert ident(plan) == meta['planPrefix'] and len(plan) == 2130841

preimage = (BASE / 'preimage' / PATH).read_bytes()
candidate = (BASE / 'candidate' / PATH).read_bytes()
assert preimage == bodies[HEAD, PATH] == bodies[RED, PATH]
assert ident(preimage) == meta['paths'][0]['preimage']
assert ident(candidate) == meta['paths'][0]['candidate']
assert ident(preimage)['blob'] == 'bd8bc728808eda00a45b300fd328d49e4e919bc2'
assert ident(candidate)['blob'] == '5026f0ec6165bb092717ddc989043848a25081dc'
assert candidate == (ROOT / 'p11-v2-live-membership-proposal/conditional-poll-green' / PATH).read_bytes()
patch, reverse = (BASE / 'candidate.patch').read_bytes(), (BASE / 'reverse.patch').read_bytes()
assert ident(patch) == meta['patch'] and ident(reverse) == meta['reversePatch']
assert apply_unified(preimage, patch) == candidate and apply_unified(candidate, reverse) == preimage
assert patch == ''.join(difflib.unified_diff(preimage.decode().splitlines(True), candidate.decode().splitlines(True), fromfile='a/' + PATH, tofile='b/' + PATH)).encode()
adds = [line[1:] for line in patch.splitlines(True) if line.startswith(b'+') and not line.startswith(b'+++')]
assert adds == [b'    assert.ok(Date.now() < cutoff, label);\n', b'      assert.ok(Date.now() < cutoff, label);\n']
assert not [line for line in patch.splitlines(True) if line.startswith(b'-') and not line.startswith(b'---')]
assert len(candidate) - len(preimage) == 88 and len(candidate.splitlines()) == 572
begin, end = b'  const poll = async <T>(', b"  const workspace = join(fixture.root, 'workspace');"
polls = []
for body in (preimage, candidate):
    assert body.count(begin) == body.count(end) == 1
    poll = body[body.index(begin):body.index(end)]
    assert poll.count(b'Date.now() + 90_000') == 1 and poll.count(b'await observe()') == 2 and poll.count(b'setTimeout(resolve, 100)') == 1 and poll.count(b'current();') == 1
    polls.append(poll.decode())
assert polls[0] == old_proof['actualPoll']
assert polls[1].replace(adds[0].decode(), '', 1).replace(adds[1].decode(), '', 1) == polls[0]
test, old_test = bodies[HEAD, TEST], bodies[RED, TEST]
suffix = (BASE / 'unchanged-p11-regression-suffix.txt').read_bytes()
assert test.endswith(suffix) and old_test.endswith(suffix) and ident(suffix) == meta['unchangedP11Suffix']
assert suffix.decode() == old_proof['actual62LineSuffix'] and len(suffix) == 4264 and len(suffix.splitlines()) == 62
assert ident(test) == meta['fullCurrentP11Test']
assert "await assert.rejects(f.run(label), error => error instanceof assert.AssertionError && error.message.includes(label));" in suffix.decode()
assert "assert.equal(f.reads(), scenario.reads); assert.deepEqual(f.trace, scenario.trace); assert.deepEqual(f.delays, scenario.delays);" in suffix.decode()
projected = dict(tree); projected[PATH] = {'mode': tree[PATH]['mode'], 'type': 'blob', 'sha': ident(candidate)['blob']}
assert {path for path in tree if tree[path] != projected[path]} == {PATH}
assert map_hash(projected) == meta['projectedNonDocMap'] == '15486b81750d93df49ccf4e374ba006dadfb21f779b530c8876ea16e7e6fd812'

workflow = bodies[HEAD, '.github/workflows/host-emulated-acceptance.yml'].decode()
command = old_proof['exactCommand']
assert workflow.splitlines()[102].strip() == command
assert workflow.splitlines()[103].strip() == 'node --test test/scripts/installDependenciesWithRetry.test.mjs'
assert "if: matrix.lane == 'team'" in workflow and 'node-version: 24.21.0' in workflow and 'timeout-minutes: 45' in workflow
start = workflow.index('          pnpm lint:fast:files -- \\\n')
end = workflow.index('          pnpm typecheck:workspace', start)
fast = [line.strip().removesuffix('\\').strip() for line in workflow[start:end].splitlines()[1:] if line.strip()]
assert len(fast) == len(set(fast)) == 93 and PATH not in fast
assert 'scripts/legacy-agent-host/**/*.ts' in json.loads(bodies[HEAD, 'tsconfig.legacy-agent-host-scripts.json'])['include']
assert ident(bodies[HEAD, 'src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts'])['blob'] == '1176fd06b70f1b717ba83deb387f87b05b18b45b'
assert ident(bodies[HEAD, 'test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts'])['blob'] == '48bf7f181ae6836a9003ebe687abab0a0ae2db20'
for path, expected in zip(inputs, inputs_before):
    assert ref(path) == expected
for row in meta['references']:
    assert ref(ROOT / row['path']) == row

proof = {
    'kind': 'INDEPENDENT_CURRENT_P11_B_SOURCE_AND_VENUE_PROOF', 'reviewer': '/root/native_failures',
    'createdAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'base': HEAD, 'baseTree': meta['baseTree'],
    'soleParent': meta['baseParents'][0], 'allSevenFrozenCandidateInputs': inputs_before,
    'allNinePublicationAndActualRedReferences': meta['references'], 'all48FreshGitPins': observed,
    'fullOriginalRed48SourceComparisons': [row['originalRedSource'] for row in pins],
    'changedOriginal29Pins': changed_original, 'completePrefixIdentity': ident(plan, PLAN),
    'fullDriverBefore': ident(preimage, PATH), 'fullDriverAfter': ident(candidate, PATH),
    'completeStrictForwardReverse': True, 'actualPollBefore': polls[0], 'selectedPollAfter': polls[1],
    'onlyAddedLines': [value.decode() for value in adds], 'wholeP11Suffix': ident(suffix),
    'wholeCurrentTeamTest': ident(test, TEST), 'fullTreeLeafCount': len(tree), 'nonDocs': 8798,
    'baseNonDocMap': map_hash(tree), 'projectedNonDocMap': map_hash(projected), 'other8797Unchanged': True,
    'wholeOriginalCommand': command, 'fast93Paths': fast, 'driverFastLintIncluded': False,
    'scriptsCompilerWildcard': 'scripts/legacy-agent-host/**/*.ts',
    'allOriginalInputsPostflightUnchanged': True, 'noProjectExecutionSourceRefOrCiActions': True,
}
proof_ref = freeze('independent-byte-source-proof.json', proof)
review = {
    'kind': 'INDEPENDENT_FRESH_CURRENT_P11_B_R1_SOURCE_REVIEW', 'reviewer': '/root/native_failures',
    'reviewedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'verdict': 'APPROVE exact prospective one-driver P11 B source/R1 and current Models A composition; no correction. No source application or future GREEN claim.',
    'R1': ref(r1_path), 'metadata': ref(metadata_path), 'byteProof': proof_ref,
    'base': HEAD, 'baseTree': meta['baseTree'], 'soleParent': meta['baseParents'][0],
    'currentPublishedReadbacks': meta['references'][:2], 'sourcePath': PATH,
    'preimage': ident(preimage), 'candidate': ident(candidate), 'patch': ref(BASE / 'candidate.patch'), 'reverse': ref(BASE / 'reverse.patch'),
    'fullBodyPreservation': {'addedBytes': 88, 'addedLines': 2, 'removedLines': 0, 'forwardAndReverseExact': True, 'entireOld570LinesPreserved': True, 'candidate572Below800Cap': True},
    'semanticReview': [
        'The first successful await observe result is checked against the one original Date.now()+90000 cutoff before acceptance can be evaluated.',
        'Every later successful awaited observation in the loop receives the same strict cutoff check before the next acceptance evaluation. Exactly-at-cutoff is rejected.',
        'No extra observe(), current(), timer, action, cancellation or native request is added. The original100ms timer, currentness position, accepts calls and final acceptance assertion remain byte-identical.',
        'An observe rejection propagates the same original error before the new assertion. A currentness throw occurs in the same place before the timer and next observation. The late false/control/error identities are not replaced by a new wrapper.',
        'The two added Date.now/assertion sites are synchronous extra work paid inside the original budgets. The chosen wall clock is unchanged; this does not provide monotonic, atomic or instantaneous acceptance.',
        'A pending observe can still remain pending beyond90s; the new check rejects its late successful settlement, not interrupt the original operation. Enclosing deadlines and cleanup remain intact.',
    ],
    'actualRedBasis': {
        'Taskboard': meta['actualRed'], 'TeamSupplement': meta['originalTeamSupplement'],
        'actualCurrentDriverEqualsOriginalRed': True, 'exactSuffix': ident(suffix),
        'postAssertionReadTraceDelayChecksPreviouslyUnexecuted': True,
        'controlPreviouslyPassed': 'Timely89999, original100ms cadence, unchanged read/currentness error object identities, false90000 rejection.',
        'futureGreenNeedsAllThreeNowReachableTraceChecks': True,
    },
    'composition': {
        'all48CurrentPinsFreshlyRead': True, 'onlyTwoChangesAmongOriginal29': changed_original,
        'currentFullTeamTest': ident(test), 'publishedGeometryPreserved': True,
        'publishedCredentialCopyPreserved': True, 'publishedModelsATestPreserved': '48bf7f181ae6836a9003ebe687abab0a0ae2db20',
        'ModelsProductionHookUnchanged': '1176fd06b70f1b717ba83deb387f87b05b18b45b',
        'other8797NonDocLeavesUnchanged': True, 'baseNonDocMap': map_hash(tree), 'projectedNonDocMap': map_hash(projected),
    },
    'venueAndSequence': {
        'originalCIOnly': True, 'literalWholeEight': command, 'Node': '24.21.0', 'jobTimeoutMinutes': 45,
        'frozenInstallAndOriginalBuildPrerequisites': 'Unchanged current workflow and source pins; actual baseline raw retained separately.',
        'wholeEight133AllPass': 'Source prediction only: old123 plus net10 geometry cases; complete resulting original raw remains mandatory.',
        'geometryCountReason': 'Final-owner negative loop grows2→4 (+2), and added actual-helper registrations contribute1+2+1+4 (+8).',
        'installerNext': 'Original seven-case command follows whole8 in same set-e block.',
        'Team179Stderr24AndTypes': 'Original team-lane-only downstream steps remain selected only in Team, and require whole8 success before execution.',
        'driverFastLint': 'Absent from unchanged93 operands; no driver-lint claim.',
        'driverCompiler': 'Included by existing scripts/legacy-agent-host/**/*.ts project; future success still requires actual original result.',
        'Models90_84Pass6Fail': 'Separate prediction and original containing frontend venue; actual Models RED not yet available.',
        'BCompositionSelectedForReview': True, 'P11CSelected': False, 'ModelsBSelected': False,
        'publication': 'Current full Plan prefix and R1/docs readbacks first, then separately guarded one-source child; currentness/history guards remain root responsibility.',
    },
    'qualificationLimits': [
        'This source/R1 review does not run the candidate, create a commit, move a ref, poll CI or qualify the resulting source.',
        'Current119-old/4-new original RED results do not establish the current geometry/copy/Models outcomes.',
        'No P11C/live-member route, real provider invocation, Ready/main/release/default activation or complete migration acceptance is selected.',
        'Existing Windows, P08, P09, Creation, I386/full-policy and physical-cleanup obligations remain separate.',
        'Full original raw outcomes, including unrelated failures and all frontend shards, must be retained; source predictions cannot replace actual original GREEN/RED.',
    ],
    'allFrozenInputsPostflightUnchanged': True,
}
print(json.dumps(freeze('independent-current-source-r1-review.json', review), indent=2))
print(json.dumps(proof_ref, indent=2))
