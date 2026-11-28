from pathlib import Path
import datetime
import hashlib
import json
import shutil
import subprocess
import sys
import time

root = Path('/workspace/scratch/82d3f9ba6b85')
repo = root / 'agent-teams-e2e'
out = root / 'stage-j-adoption'
assert sys.argv[1:] == ['J', 'diff']

def ident(raw):
    return {'bytes': len(raw), 'blob': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest(),
            'sha256': hashlib.sha256(raw).hexdigest()}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo)

def scalar(*args):
    return git(*args).decode().strip()

def write_json(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')

manifest_path = out / 'validation-manifest.json'
manifest_raw = manifest_path.read_bytes()
assert ident(manifest_raw)['blob'] == '784dc90ea7ba0f8761c25365eb985784d56515d7'
manifest = json.loads(manifest_raw)
recorder_raw = Path(__file__).read_bytes()
bindings_path = out / 'stage-bindings.json'
bindings_raw = bindings_path.read_bytes()
bindings = json.loads(bindings_raw)
assert bindings['recorder'] == ident(recorder_raw)
assert bindings['manifest'] == ident(manifest_raw)
assert bindings['independentProspectiveReview'] is True
doc = bindings['documentation']
source = bindings['source']
assert doc['independentReadbackExact'] is True and source['independentReadbackExact'] is True
assert source['parents'] == [doc['head'], manifest['incoming']['head']]
argv = [a.replace('${J_DOCS_HEAD}', doc['head']).replace('${J_HEAD}', source['head'])
        for a in manifest['command']['argv']]
assert argv == ['git', 'diff', '--check', doc['head'] + '..' + source['head'], '--', manifest['sourcePath']]
assert manifest['command']['cwd'] == str(repo)
git_executable = Path(shutil.which('git')).resolve()
git_identity = ident(git_executable.read_bytes())

def frozen(spec):
    raw = Path(spec['path']).read_bytes()
    assert ident(raw) == {k: spec[k] for k in ('bytes', 'blob', 'sha256')}, spec['path']
    return raw

def tree(head):
    result = {}
    for line in git('ls-tree', '-r', head).decode().splitlines():
        fields, path = line.split('\t', 1)
        result[path] = tuple(fields.split())
    return result

def state():
    assert manifest_path.read_bytes() == manifest_raw
    assert Path(__file__).read_bytes() == recorder_raw
    assert bindings_path.read_bytes() == bindings_raw
    assert Path(shutil.which('git')).resolve() == git_executable
    assert ident(git_executable.read_bytes()) == git_identity
    assert scalar('rev-parse', 'HEAD') == source['head']
    assert scalar('rev-parse', 'HEAD^{tree}') == source['tree']
    assert scalar('show', '-s', '--format=%P', 'HEAD').split() == source['parents']
    assert scalar('status', '--porcelain') == ''
    prior = manifest['prior']
    assert scalar('rev-parse', prior['head'] + '^{tree}') == prior['tree']
    assert scalar('rev-parse', doc['head'] + '^{tree}') == doc['tree']
    assert scalar('show', '-s', '--format=%P', doc['head']).split() == [prior['head']]
    docs_delta = scalar('diff', '--name-only', prior['head'], doc['head']).splitlines()
    assert docs_delta and all(p.startswith('docs/plans/provider-migration/frontend-parity-2026-11-12/') for p in docs_delta)
    for item in manifest['incomingCommits']:
        assert scalar('rev-parse', item['head'] + '^{tree}') == item['tree']
        assert scalar('show', '-s', '--format=%P', item['head']).split() == item['parents']
    assert scalar('rev-list', '--reverse', manifest['incomingBase'] + '..' + manifest['incoming']['head']).splitlines() == [c['head'] for c in manifest['incomingCommits']]
    expected_incoming = [manifest['planPath']] + [d['path'] for d in manifest['incomingDocuments']] + [manifest['sourcePath']]
    assert scalar('diff', '--name-only', manifest['incomingBase'], manifest['incoming']['head']).splitlines() == expected_incoming
    previous_tree, current_tree = tree(doc['head']), tree(source['head'])
    changed = sorted(p for p in set(previous_tree) | set(current_tree) if previous_tree.get(p) != current_tree.get(p))
    assert changed == [manifest['sourcePath']]
    assert len(previous_tree) == len(current_tree)
    assert previous_tree[manifest['sourcePath']] == ('100644', 'blob', manifest['sourceBefore']['blob'])
    assert current_tree[manifest['sourcePath']] == ('100644', 'blob', manifest['sourceAfter']['blob'])
    canonical = frozen(manifest['canonicalR1'])
    frozen(manifest['history'])
    frozen(manifest['sourcePatch'])
    appendix = frozen(manifest['incomingPlanAppendix'])
    plan = git('show', 'HEAD:' + manifest['planPath'])
    old_plan = git('show', prior['head'] + ':' + manifest['planPath'])
    assert ident(old_plan) == manifest['priorPlan']
    assert plan.startswith(old_plan) and plan.count(canonical) == 1 and plan.count(appendix) == 1
    assert ident(plan)['blob'] == doc['planBlob']
    unchanged = manifest['unchangedPlan30']
    assert current_tree[unchanged['path']] == ('100644', 'blob', unchanged['blob'])
    for item in manifest['incomingDocuments']:
        assert ident(git('show', 'HEAD:' + item['path'])) == {k: item[k] for k in ('bytes', 'blob', 'sha256')}
    selected = []
    for item in manifest['selectedSourceLeaves']:
        path = item['path']
        expected = {k: item[k] for k in ('bytes', 'blob', 'sha256')}
        assert ident((repo / path).read_bytes()) == expected, path
        assert current_tree[path] == ('100644', 'blob', item['blob']), path
        before = manifest['sourceBefore'] if path == manifest['sourcePath'] else expected
        assert ident(git('show', prior['head'] + ':' + path)) == before, path
        selected.append(item)
    assert len(selected) == 76
    host = json.loads(frozen(manifest['hostSourceClosure']))
    assert len(host) == 615
    for item in host:
        expected = {k: item[k] for k in ('bytes', 'blob', 'sha256')}
        assert ident((repo / item['path']).read_bytes()) == expected, item['path']
        assert current_tree[item['path']] == ('100644', 'blob', item['blob']), item['path']
    for proof in manifest['priorIProofFiles']:
        frozen(proof)
    for operation in manifest['priorICommands']:
        metadata = json.loads((root / 'a02-adoption-local' / ('I-' + operation + '-metadata.json')).read_text())
        assert metadata['sourceHead'] == prior['head'] and metadata['sourceTree'] == prior['tree']
        assert metadata['exitCode'] == 0 and metadata['postflightExact'] is True
    return {'head': source['head'], 'tree': source['tree'], 'parents': source['parents'],
            'leafCount': len(current_tree), 'exactChangedPaths': changed, 'unchangedLeafCount': len(current_tree) - 1,
            'selectedSourceLeaves': selected, 'hostSourceCount': len(host), 'hostSourceBytes': sum(x['bytes'] for x in host),
            'hostSourceClosure': manifest['hostSourceClosure'], 'priorIProofFiles': manifest['priorIProofFiles'],
            'gitExecutable': {'path': str(git_executable), **git_identity}, 'manifest': ident(manifest_raw),
            'recorder': ident(recorder_raw), 'bindings': ident(bindings_raw)}

preflight_path = out / 'J-diff-preflight.json'
log_path = out / 'J-diff.log'
metadata_path = out / 'J-diff-metadata.json'
assert not any(p.exists() for p in (preflight_path, log_path, metadata_path))
preflight = state()
write_json(preflight_path, preflight)
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
monotonic = time.monotonic()
with log_path.open('xb') as stream:
    result = subprocess.run(argv, cwd=repo, stdout=stream, stderr=subprocess.STDOUT)
elapsed = time.monotonic() - monotonic
finished = datetime.datetime.now(datetime.timezone.utc).isoformat()
error = None
try:
    assert state() == preflight
except Exception as exc:
    error = repr(exc)
metadata = {'stage': 'J', 'commandName': 'J-diff', 'sourceHead': source['head'], 'sourceTree': source['tree'],
            'parents': source['parents'], 'argv': argv, 'cwd': str(repo), 'startedAtUTC': started,
            'finishedAtUTC': finished, 'elapsedSeconds': elapsed, 'exitCode': result.returncode,
            'log': ident(log_path.read_bytes()), 'preflight': ident(preflight_path.read_bytes()),
            'postflightExact': error is None, 'postflightError': error, 'projectTestsExecuted': False,
            'nodeInvoked': False, 'buildPerformed': False, 'windowsCompileOrRuntimeQualification': False}
write_json(metadata_path, metadata)
print(json.dumps(metadata, indent=2))
sys.exit(result.returncode if result.returncode else (70 if error else 0))
