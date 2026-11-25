from pathlib import Path, PurePosixPath
import datetime
import hashlib
import json
import shutil
import stat
import subprocess
import sys
import time
import zipfile


root = Path('/workspace/scratch/82d3f9ba6b85')
repo = root / 'agent-teams-e2e'
out = root / 'stage-k-adoption/validation'
assert len(sys.argv) == 3 and sys.argv[1] == 'K'
name = sys.argv[2]


def ident(raw):
    return {'bytes': len(raw),
            'blob': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest(),
            'sha256': hashlib.sha256(raw).hexdigest()}


def expected(spec):
    return {key: spec[key] for key in ('bytes', 'blob', 'sha256')}


def frozen(spec):
    path = Path(spec['path'])
    assert path.is_file() and not path.is_symlink(), str(path)
    raw = path.read_bytes()
    assert ident(raw) == expected(spec), str(path)
    return raw


def reference(path):
    return {'path': str(path), **ident(path.read_bytes())}


def write_json(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo)


def scalar(*args):
    return git(*args).decode().strip()


def tree(head):
    result = {}
    for row in git('ls-tree', '-rz', head).split(b'\0'):
        if row:
            fields, path = row.decode().split('\t', 1)
            result[path] = tuple(fields.split())
    return result


manifest_path = out / 'validation-manifest.json'
manifest_raw = manifest_path.read_bytes()
assert ident(manifest_raw)['blob'] == '9ee92856321b14011122258e39e638ec1ca862b1'
manifest = json.loads(manifest_raw)
recorder_path = Path(__file__).resolve()
recorder_raw = recorder_path.read_bytes()
bindings_path = out / 'stage-bindings.json'
bindings_raw = bindings_path.read_bytes()
bindings = json.loads(bindings_raw)
assert bindings['manifest'] == ident(manifest_raw)
assert bindings['recorder'] == ident(recorder_raw)
assert bindings['stage'] == 'K'
doc, source = bindings['documentation'], bindings['source']
assert isinstance(doc, dict) and isinstance(source, dict)
assert doc['parents'] == [manifest['prior']['head']]
assert source['parents'] == [doc['head'], manifest['incoming']['head']]
review_raw = frozen(bindings['independentValidationReview'])
review = json.loads(review_raw)
assert review['result'] == 'APPROVE'
for key, value in [('manifest', ident(manifest_raw)), ('recorder', ident(recorder_raw)),
                   ('canonicalR1', expected(manifest['canonicalR1'])),
                   ('sourceContract', expected(manifest['sourceContract']))]:
    assert review[key] == value, key
commands = {item['name']: item for item in manifest['commands']}
assert len(commands) == manifest['commandCount'] == 12 and name in commands
operation = commands[name]
names = list(commands)
assert operation['requires'] == names[:names.index(name)]


def resolved_argv(item):
    return [value.replace('${K_DOCS_HEAD}', doc['head']).replace('${K_HEAD}', source['head'])
            for value in item['argv']]


argv = resolved_argv(operation)
cwd = operation['cwd']
assert cwd in (str(repo), str(repo / 'packages/legacy-agent-host'))
assert operation['expectedExitCode'] == 0
git_executable = Path(shutil.which('git')).resolve()
git_identity = ident(git_executable.read_bytes())
policy = manifest['oldDOutputCustody']
old_outputs = json.loads(frozen(policy['originalInventory']))
assert len(old_outputs) == policy['oldCount'] == 1446
ledger_prefix = 'packages/task-change-ledger/dist/'
old_ledger = [row for row in old_outputs if row['path'].startswith(ledger_prefix)]
assert len(old_ledger) == policy['ledgerCount'] == 216
host_closure = json.loads(frozen(manifest['hostSourceClosure']))
ledger_closure = json.loads(frozen(manifest['ledgerTrackedClosure']))
assert len(host_closure) == manifest['hostSourceClosure']['count'] == 618
assert len(ledger_closure) == manifest['ledgerTrackedClosure']['count'] == 119


def readback(spec, commit):
    value = json.loads(frozen(spec))
    assert value['result'] == 'APPROVE' and value['independentReadbackExact'] is True
    for key in ('head', 'tree', 'parents'):
        assert value[key] == commit[key], key
    return value


def source_leaf(item, current_tree):
    path = item['path']
    local = repo / path
    assert local.is_file() and not local.is_symlink(), path
    assert ident(local.read_bytes()) == expected(item), path
    assert current_tree[path] == (item.get('mode', '100644'), 'blob', item['blob']), path


def old_records():
    for item in manifest['oldProofFiles']:
        frozen(item)
    for item in manifest['requiredOldRecords']:
        record = json.loads(frozen(item['metadata']))
        for key in ('sourceHead', 'sourceTree', 'parents', 'cwd', 'argv', 'exitCode'):
            assert record[key] == item[key], (item['name'], key)
        assert record['exitCode'] == 0 and record['postflightExact'] is True, item['name']
        if 'nodeVersion' in record:
            assert record['nodeVersion'] == manifest['node']['expectedVersion']
            assert record['nodeSHA256'] == manifest['node']['sha256']
        pre_raw, log_raw = frozen(item['preflight']), frozen(item['log'])
        pre = json.loads(pre_raw)
        assert pre.get('sourceHead', pre.get('head')) == item['sourceHead'], item['name']
        assert pre.get('sourceTree', pre.get('tree')) == item['sourceTree'], item['name']
        if 'log' in record:
            assert record['log'] == ident(log_raw) and record['preflight'] == ident(pre_raw)
        else:
            assert record['logSHA256'] == ident(log_raw)['sha256']
            assert record['logBytes'] == len(log_raw)
            assert record['preflightMetadataSHA256'] == ident(pre_raw)['sha256']
    assert len(manifest['requiredOldRecords']) == 13


def state():
    assert manifest_path.read_bytes() == manifest_raw
    assert recorder_path.read_bytes() == recorder_raw
    assert bindings_path.read_bytes() == bindings_raw
    assert frozen(bindings['independentValidationReview']) == review_raw
    assert Path(shutil.which('git')).resolve() == git_executable
    assert ident(git_executable.read_bytes()) == git_identity
    assert scalar('rev-parse', 'HEAD') == source['head']
    assert scalar('rev-parse', 'HEAD^{tree}') == source['tree']
    assert scalar('show', '-s', '--format=%P', 'HEAD').split() == source['parents']
    assert scalar('status', '--porcelain') == ''
    for commit in [manifest['prior'], manifest['incoming'], doc, *manifest['incomingCommits']]:
        assert scalar('rev-parse', commit['head'] + '^{tree}') == commit['tree']
        if 'parents' in commit:
            assert scalar('show', '-s', '--format=%P', commit['head']).split() == commit['parents']
    assert scalar('rev-list', '--reverse', manifest['incomingCommits'][0]['parents'][0] + '..' + manifest['incoming']['head']).splitlines() == [row['head'] for row in manifest['incomingCommits']]
    prior_tree, doc_tree, current_tree = tree(manifest['prior']['head']), tree(doc['head']), tree(source['head'])
    docs_delta = sorted(path for path in set(prior_tree) | set(doc_tree) if prior_tree.get(path) != doc_tree.get(path))
    assert docs_delta and all(path.startswith('docs/plans/provider-migration/frontend-parity-2026-11-12/') for path in docs_delta)
    assert all(path in doc_tree and doc_tree[path][0:2] == ('100644', 'blob') for path in docs_delta)
    changed = sorted(path for path in set(doc_tree) | set(current_tree) if doc_tree.get(path) != current_tree.get(path))
    assert changed == sorted(item['path'] for item in manifest['integrationLeaves'])
    assert len(changed) == manifest['integrationLeafCount'] == 46
    for item in manifest['integrationLeaves']:
        path = item['path']
        before = None if item['before'] is None else ('100644', 'blob', item['before']['blob'])
        assert prior_tree.get(path) == doc_tree.get(path) == before, path
        assert current_tree[path] == ('100644', 'blob', item['selected']['blob']), path
        assert ident(git('show', source['head'] + ':' + path)) == expected(item['selected']), path
    canonical = frozen(manifest['canonicalR1'])
    for key in ('sourceContract', 'sourcePatch', 'correctionContract', 'hostSourceClosure', 'ledgerTrackedClosure'):
        frozen(manifest[key])
    plan_path = manifest['documentation']['planPath']
    old_plan = git('show', manifest['prior']['head'] + ':' + plan_path)
    plan = git('show', doc['head'] + ':' + plan_path)
    assert ident(old_plan)['blob'] == manifest['documentation']['prefixBlob']
    assert plan.startswith(old_plan) and plan.count(canonical) == 1
    assert ident(plan)['blob'] == doc['planBlob']
    unchanged = manifest['documentation']['unchangedPlan30']
    assert current_tree[unchanged['path']] == ('100644', 'blob', unchanged['blob'])
    for item in manifest['documentation']['incomingDocuments']:
        assert ident(git('show', doc['head'] + ':' + item['path'])) == expected(item['selected'])
    readback(doc['readback'], doc)
    source_readback = readback(source['readback'], source)
    assert source_readback['exactChangedPaths'] == changed
    published = doc['validationPaths']
    published_refs = {'manifest': ident(manifest_raw), 'recorder': ident(recorder_raw),
                      'hostSourceClosure': expected(manifest['hostSourceClosure']),
                      'ledgerTrackedClosure': expected(manifest['ledgerTrackedClosure'])}
    for key, identity in published_refs.items():
        path = published[key]
        assert path.startswith('docs/plans/provider-migration/frontend-parity-2026-11-12/')
        assert ident(git('show', doc['head'] + ':' + path)) == identity, key
    for item in manifest['selectedSourceLeaves']:
        source_leaf(item, current_tree)
    assert len(manifest['selectedSourceLeaves']) == manifest['selectedSourceCount'] == 136
    for closure, prefix in [(host_closure, 'packages/legacy-agent-host/src/'),
                            (ledger_closure, 'packages/task-change-ledger/')]:
        assert sorted(path for path in current_tree if path.startswith(prefix)) == sorted(row['path'] for row in closure)
        for item in closure:
            source_leaf(item, current_tree)
    original_d_tree = tree(policy['referenceSource']['head'])
    assert scalar('rev-parse', policy['referenceSource']['head'] + '^{tree}') == policy['referenceSource']['tree']
    assert sorted(path for path in original_d_tree if path.startswith('packages/task-change-ledger/')) == sorted(row['path'] for row in ledger_closure)
    for item in ledger_closure:
        assert original_d_tree[item['path']] == prior_tree[item['path']] == current_tree[item['path']]
    for item in manifest['selectedDependencyInputs']:
        path = repo / item['path']
        assert str(path.resolve()) == item['realpath'], item['path']
        raw = path.read_bytes()
        assert len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256'], item['path']
    assert len(manifest['selectedDependencyInputs']) == manifest['selectedDependencyCount'] == 175
    node = Path(manifest['node']['path'])
    assert hashlib.sha256(node.read_bytes()).hexdigest() == manifest['node']['sha256']
    assert (repo / 'packages/legacy-agent-host/node_modules/@agent-teams/task-change-ledger').resolve() == repo / 'packages/task-change-ledger'
    for dirname in policy['ownedDirectories']:
        path = repo / dirname
        assert path.is_dir() and not path.is_symlink() and path.resolve() == path
    for key in ('archive', 'checkpoint', 'independentReview', 'originalInventory'):
        frozen(policy[key])
    assert json.loads(frozen(policy['independentReview']))['result'] == 'APPROVE'
    old_records()
    return {'sourceHead': source['head'], 'sourceTree': source['tree'], 'parents': source['parents'],
            'clean': True, 'documentationHead': doc['head'], 'documentationTree': doc['tree'],
            'documentationChangedPaths': docs_delta, 'exactChangedPaths': changed,
            'leafCount': len(current_tree), 'unchangedLeafCount': len(doc_tree) - sum(item['before'] is not None for item in manifest['integrationLeaves']),
            'manifest': ident(manifest_raw), 'recorder': ident(recorder_raw), 'bindings': ident(bindings_raw),
            'independentValidationReview': bindings['independentValidationReview'],
            'documentationReadback': doc['readback'], 'sourceReadback': source['readback'],
            'selectedSourceLeaves': manifest['selectedSourceLeaves'], 'hostSourceClosure': manifest['hostSourceClosure'],
            'ledgerTrackedClosure': manifest['ledgerTrackedClosure'], 'selectedDependencyInputs': manifest['selectedDependencyInputs'],
            'oldProofFiles': manifest['oldProofFiles'], 'oldDOutputCustody': policy,
            'gitExecutable': {'path': str(git_executable), **git_identity},
            'node': manifest['node'], 'dependencyLimit': manifest['dependencyLimit']}


def outputs():
    rows = []
    for dirname in policy['ownedDirectories']:
        directory = repo / dirname
        assert directory.is_dir() and directory.resolve() == directory
        for path in sorted(directory.rglob('*')):
            assert not path.is_symlink(), str(path)
            if path.is_file():
                raw = path.read_bytes()
                rows.append({'path': str(path.relative_to(repo)), 'bytes': len(raw),
                             'sha256': hashlib.sha256(raw).hexdigest()})
            else:
                assert path.is_dir(), str(path)
    return sorted(rows, key=lambda row: row['path'])


def verify_archive():
    saved = {row['path']: row for row in old_outputs}
    with zipfile.ZipFile(policy['archive']['path']) as archive:
        members = archive.infolist()
        assert len(members) == len(saved) and len({row.filename for row in members}) == len(members)
        assert {row.filename for row in members} == set(saved)
        for member in members:
            path = PurePosixPath(member.filename)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in member.filename
            assert not member.is_dir() and not stat.S_ISLNK(member.external_attr >> 16)
            raw = archive.read(member)
            assert len(raw) == saved[member.filename]['bytes']
            assert hashlib.sha256(raw).hexdigest() == saved[member.filename]['sha256']


def previous_records():
    proof_refs = []
    last_finished = None
    for previous in operation['requires']:
        paths = {kind: out / ('K-' + previous + suffix) for kind, suffix in
                 [('metadata', '-metadata.json'), ('preflight', '-preflight.json'), ('log', '.log')]}
        raw = {kind: path.read_bytes() for kind, path in paths.items()}
        record = json.loads(raw['metadata'])
        pre = json.loads(raw['preflight'])
        assert record['sourceHead'] == source['head'] and record['sourceTree'] == source['tree']
        assert record['parents'] == source['parents']
        assert record['commandName'] == 'K-' + previous and record['stage'] == 'K'
        assert record['argv'] == resolved_argv(commands[previous]) and record['cwd'] == commands[previous]['cwd']
        assert record['manifest'] == ident(manifest_raw) and record['recorder'] == ident(recorder_raw)
        assert record['bindings'] == ident(bindings_raw)
        assert record['log'] == ident(raw['log']) and record['preflight'] == ident(raw['preflight'])
        assert record['exitCode'] == 0 and record['launchError'] is None and record['postflightExact'] is True
        assert pre['state']['manifest'] == ident(manifest_raw) and pre['state']['recorder'] == ident(recorder_raw)
        assert pre['state']['bindings'] == ident(bindings_raw)
        start, finish = [datetime.datetime.fromisoformat(record[key]) for key in ('startedAtUTC', 'finishedAtUTC')]
        assert start <= finish and (last_finished is None or last_finished <= start)
        last_finished = finish
        for kind, path in paths.items():
            proof_refs.append({'path': str(path), **ident(raw[kind])})
    return proof_refs, last_finished


preflight_path = out / ('K-' + name + '-preflight.json')
log_path = out / ('K-' + name + '.log')
metadata_path = out / ('K-' + name + '-metadata.json')
before_path = out / 'K-host-build-outputs-before.json'
after_path = out / 'K-host-build-outputs-after.json'
assert not any(path.exists() for path in (preflight_path, log_path, metadata_path))
if name == 'host-build':
    assert not before_path.exists() and not after_path.exists()
snapshot = state()
prior_proofs, last_finished = previous_records()
before_outputs = outputs()
assert [row for row in before_outputs if row['path'].startswith(ledger_prefix)] == old_ledger
if name == 'host-build':
    assert before_outputs == old_outputs
    verify_archive()
    write_json(before_path, before_outputs)
    build_inventory = reference(before_path)
else:
    host_record = json.loads((out / 'K-host-build-metadata.json').read_text())
    assert host_record['outputInventoryAfter'] == reference(after_path)
    assert before_outputs == json.loads(after_path.read_text())
    build_inventory = reference(after_path)
preflight = {'stage': 'K', 'commandName': 'K-' + name, 'cwd': cwd, 'argv': argv,
             'state': snapshot, 'priorCommands': prior_proofs, 'outputInventoryBefore': build_inventory,
             'builtOutputsCountBefore': len(before_outputs), 'selectedSourceCount': 136,
             'hostSourceCount': 618, 'ledgerTrackedCount': 119, 'selectedDependencyCount': 175,
             'newHostBuild': name == 'host-build', 'ledgerReusedFromDOnly': True,
             'nodeVersionEvidence': manifest['node']['versionEvidence']}
write_json(preflight_path, preflight)
preflight_raw = preflight_path.read_bytes()
preflight_identity = ident(preflight_raw)
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
assert last_finished is None or last_finished <= datetime.datetime.fromisoformat(started)
monotonic = time.monotonic()
exit_code, launch_error = None, None
with log_path.open('xb') as stream:
    try:
        completed = subprocess.run(argv, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT)
        exit_code = completed.returncode
    except Exception as error:
        launch_error = repr(error)
elapsed = time.monotonic() - monotonic
finished = datetime.datetime.now(datetime.timezone.utc).isoformat()
postflight_errors = []
actual_outputs, output_inventory_after, log_identity = None, None, None
try:
    log_identity = ident(log_path.read_bytes())
except Exception as error:
    postflight_errors.append('Log capture: ' + repr(error))
try:
    actual_outputs = outputs()
    if name == 'host-build':
        write_json(after_path, actual_outputs)
    output_inventory_after = reference(after_path)
    assert [row for row in actual_outputs if row['path'].startswith(ledger_prefix)] == old_ledger
    if name != 'host-build':
        assert actual_outputs == before_outputs
        assert output_inventory_after == build_inventory
    if name == 'host-build':
        assert reference(before_path) == build_inventory
    for proof in prior_proofs:
        frozen(proof)
    assert state() == snapshot
    assert preflight_path.read_bytes() == preflight_raw
    assert ident(log_path.read_bytes()) == log_identity
    assert reference(after_path) == output_inventory_after
except Exception as error:
    postflight_errors.append('Postflight: ' + repr(error))
postflight_error = '; '.join(postflight_errors) if postflight_errors else None
metadata = {'stage': 'K', 'commandName': 'K-' + name, 'sourceHead': source['head'],
            'sourceTree': source['tree'], 'parents': source['parents'], 'cwd': cwd, 'argv': argv,
            'startedAtUTC': started, 'finishedAtUTC': finished, 'elapsedSeconds': elapsed,
            'exitCode': exit_code, 'launchError': launch_error,
            'log': log_identity, 'preflight': preflight_identity,
            'manifest': ident(manifest_raw), 'recorder': ident(recorder_raw), 'bindings': ident(bindings_raw),
            'postflightExact': postflight_error is None, 'postflightError': postflight_error,
            'selectedSourceCount': 136, 'hostSourceCount': 618, 'ledgerTrackedCount': 119,
            'selectedDependencyCount': 175, 'newHostBuildPerformed': name == 'host-build' and launch_error is None,
            'ledgerBuildPerformed': False, 'ledgerReusedFromDOnly': True,
            'nonBuildOutputBytesPreserved': name != 'host-build' and postflight_error is None,
            'outputInventoryBefore': build_inventory,
            'outputInventoryAfter': output_inventory_after,
            'builtOutputsCountAfter': None if actual_outputs is None else len(actual_outputs),
            'nodeVersion': manifest['node']['expectedVersion'], 'nodeSHA256': manifest['node']['sha256'],
            'nodeVersionEvidence': manifest['node']['versionEvidence'],
            'nativeOrGraphicalQualification': False, 'providerAcceptanceQualification': False}
write_json(metadata_path, metadata)
print(json.dumps(metadata, indent=2))
sys.exit(exit_code if exit_code else (70 if launch_error or postflight_error else 0))
