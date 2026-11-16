import base64
import datetime
import re
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import pathlib
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse

ROOT = pathlib.Path('/workspace/scratch/c714-fresh-20261116')
REPO = ROOT / 'source'
OUTROOT = pathlib.Path('/tmp/c714-combined139-85-evidence')
OUT = TASK_TMP = None
SOURCE_COMMIT = 'c5ff4fc283e58d486c58147b4dfb00144ca10d34'
SOURCE_TREE = '3239e6e6c8182f3d8e45ee671efc9108500b5137'
R1 = 'cf6547aa79cc903a5833fa950a2de3178194c429'
R1_BLOB = 'd52bf425109d265914631ddea62f2d67e979cff5'
WORKSPACES = ['', 'agent-teams-controller', 'mcp-server', 'landing',
              'packages/agent-graph', 'packages/legacy-agent-host', 'packages/task-change-ledger']
FIXED_PATHS = [
    "scripts/legacy-agent-host/desktop-ui-controls.ts",
    "scripts/legacy-agent-host/desktop-emulated-selection-ui.ts",
    "scripts/legacy-agent-host/desktop-task-comment-input-target.ts",
    "scripts/legacy-agent-host/desktop-task-board-ui-smoke.ts"
]
PRODUCER_PATHS = [
    "scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts",
    "scripts/legacy-agent-host/desktop-task-review-cycle-ui-smoke.ts",
    "src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts"
]
TEST_PATHS = [
    "scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts",
    "test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts"
]
OVERLAY_PATHS = [
    "scripts/legacy-agent-host/desktop-ui-controls.ts",
    "scripts/legacy-agent-host/desktop-emulated-selection-ui.ts",
    "scripts/legacy-agent-host/desktop-task-comment-input-target.ts",
    "scripts/legacy-agent-host/desktop-task-board-ui-smoke.ts",
    "src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts",
    "scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts",
    "scripts/legacy-agent-host/desktop-task-review-cycle-ui-smoke.ts",
    "scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts",
    "test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts"
]
TEST_IDENTITIES = {
    "node": {
        "bytes": 164965,
        "sha256": "852bedb85c83dbc4b488dffb4a9ffebbe398adc53e85f5a3cea8ca36b146cbf7",
        "gitBlob": "896c587e077da56a98a314a175fb3cba0353d6ee"
    },
    "renderer": {
        "bytes": 187890,
        "sha256": "b6f11896e60014aac785968d42390afde38716d47de9bba9562522235db048c9",
        "gitBlob": "76495189c992fcda47cd7a43a0c697190b5acbb3"
    }
}
INPUT_PATHS = {
    'setupBinding': pathlib.Path('/tmp/c714-fresh-bootstrap-review/binding.json'),
    'sourceFull': ROOT / 'evidence/source-restore-source-after.json',
    'sourceNonDoc': ROOT / 'evidence/host-build-source-after.json',
    'dependencies': ROOT / 'evidence/host-build-dependencies-after.json',
    'compiled': ROOT / 'evidence/host-build-compiled-after.json',
    'pnpm': ROOT / 'evidence/pnpm-inventory.json',
    'currentBoundary': pathlib.Path('/tmp/c714-bootstrap-data-review/fresh-current-input-boundary.json'),
    'providers': pathlib.Path('/tmp/c714-bootstrap-data-review/provider-archives-fresh-review.json'),
}


def identity(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'gitBlob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def write_new(name, value):
    data = (json.dumps(value, indent=2) + '\n').encode()
    path = OUT / name
    with path.open('xb') as handle:
        handle.write(data)
    return {'path': str(path), **identity(data)}

def process_rows():
    rows = []
    for item in pathlib.Path('/proc').iterdir():
        if not item.name.isdigit():
            continue
        try:
            raw = (item / 'stat').read_text()
            close = raw.rfind(')')
            tail = raw[close + 2:].split()
            rows.append({'pid': int(item.name), 'name': raw[raw.index('(') + 1:close],
                         'state': tail[0], 'ppid': int(tail[1]), 'pgid': int(tail[2]),
                         'session': int(tail[3]), 'startTicks': int(tail[19])})
        except FileNotFoundError:
            continue
    return sorted(rows, key=lambda row: row['pid'])

def package_values(environment):
    return {key: value for key, value in environment.items()
            if key.lower().startswith(('npm_config_', 'pnpm_config_'))}

def transport_values(environment):
    return {key: value for key, value in environment.items()
            if key.lower() in ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'proxy']}

def admit_environment(original):
    package = package_values(original)
    network = transport_values(original)
    admission = amendment['admission']
    assert set(package) == set(admission['exactPackageConfigKeys']), 'package config key drift'
    assert set(network) == set(admission['exactOrdinaryProxyKeys']), 'network key drift'
    assert not any(key.upper().startswith('PNPM_') for key in original), 'unreviewed PNPM environment'
    normalized = {}
    for key, value in {**package, **network}.items():
        lower = key.lower()
        assert lower not in normalized or normalized[lower] == value, 'case alias conflict'
        normalized[lower] = value
    for pin in admission['fixedNormalizedPackageValues']:
        data = normalized[pin['key']].encode()
        assert len(data) == pin['bytes'] and hashlib.sha256(data).hexdigest() == pin['sha256']
    for name in ['httpProxyGroup', 'allProxyGroup']:
        group = admission[name]
        values = [normalized[key] for key in group['normalizedKeys']]
        assert len(set(values)) == 1, 'proxy group conflict'
        value = values[0]
        parsed = urllib.parse.urlsplit(value)
        assert parsed.scheme == group['scheme'] and parsed.hostname == group['hostname']
        assert parsed.username is None and parsed.password is None
        assert parsed.path == parsed.query == parsed.fragment == ''
        assert parsed.port is not None and group['port']['min'] <= parsed.port <= group['port']['max']
        assert value == group['scheme'] + '://127.0.0.1:' + str(parsed.port), 'noncanonical proxy'
    assert normalized['no_proxy'] == normalized['npm_config_noproxy']
    selected = {**package, **network}
    result = original.copy()
    for key in list(result):
        if key.lower().startswith(('npm_config_', 'pnpm_config_')):
            del result[key]
        elif key in r1['environment']['unset'] + r1['environment']['additionalUnset']:
            del result[key]
        elif any(key.startswith(prefix) for prefix in r1['environment']['unsetPrefixes']):
            del result[key]
    for key in r1['environment']['inheritedPackageConfigKeys']:
        result[key] = normalized[key]
    result.update(r1['environment']['assignments'])
    return result, selected

def environment_check():
    current = {**package_values(os.environ), **transport_values(os.environ)}
    assert current == captured_transport, 'captured environment changed'
    assert os.environ.get('HOME') == '/home/agent' and env.get('HOME') == '/home/agent'
    assert env.get('CODEX_HOME') == original_environment.get('CODEX_HOME')
    assert env.get('XDG_CONFIG_HOME') == str(ROOT / 'config')
    assert all(not (pathlib.Path(path).exists() or pathlib.Path(path).is_symlink())
               for path in absent_configs), 'new user/global config'
    for name in ['config.yaml', 'auth.ini', 'pnpmfile.cjs', 'pnpmfile.mjs', '.pnpmfile.cjs']:
        assert not (ROOT / 'config' / 'pnpm' / name).exists(), 'new task pnpm config'
    assert pathlib.Path(normalized_prefix) / 'etc/npmrc' == pathlib.Path(absent_configs[-1])
    renderer_environment = renderer_environment_check()
    return {'rendererEnvironment': renderer_environment, 'capturedTransportCanonicalSha256': hashlib.sha256(canonical(captured_transport)).hexdigest(),
            'values': [{'key': key, 'bytes': len(value.encode()),
                        'sha256': hashlib.sha256(value.encode()).hexdigest()}
                       for key, value in sorted(captured_transport.items())],
            'explicitAssignments': {key: env.get(key) for key in [*r1['environment']['assignments'],
                                    'AGENT_BACKEND_TEST_NODE', 'NODE_DISABLE_COMPILE_CACHE']},
            'homePreserved': True, 'codexHomePreserved': True, 'absentConfigs': absent_configs}

def tooling():
    rows = []
    for name in ['node', 'git', 'python', 'scriptShell']:
        pin = r1['tools'][name]
        path = pathlib.Path(pin['path'])
        value = identity(path.read_bytes())
        assert value['bytes'] == pin['bytes'] and value['sha256'] == pin['sha256'], name
        if pin.get('realPath'):
            assert str(path.resolve()) == pin['realPath'], name + ' resolved path'
        rows.append({'tool': name, 'path': str(path), 'realPath': str(path.resolve()), **value})
    assert str(pathlib.Path(sys.executable).resolve()) == r1['tools']['python']['realPath']
    assert shutil.which('node', path=env['PATH']) == r1['tools']['node']['path']
    return rows

def file_row(path, relative):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        data, mode = os.readlink(path).encode(), '120000'
    else:
        assert stat.S_ISREG(info.st_mode), 'special file: ' + relative
        data = path.read_bytes()
        mode = '100755' if info.st_mode & stat.S_IXUSR else '100644'
    return {'path': relative, 'mode': mode, **identity(data)}

def directory_manifest_entry(path):
    info = path.lstat()
    if stat.S_ISDIR(info.st_mode):
        return None
    relative = path.relative_to(REPO).as_posix()
    row = file_row(path, relative)
    if stat.S_ISLNK(info.st_mode):
        assert path.resolve().is_relative_to(REPO), 'dependency link escapes source'
        row['target'] = os.readlink(path)
    return row

def directory_manifest(roots):
    global cleaning
    rows, pending = [], []
    executor = None
    first_error = None
    previous_cleaning = cleaning
    cleaning = True
    try:
        try:
            executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix='c714-input-reader')
            for base in roots:
                if phase_signals:
                    first_error = InterruptedError('supervisor signal during input manifest')
                    raise first_error
                if not base.exists():
                    continue
                assert base.is_dir() and not base.is_symlink(), 'unexpected root link: ' + str(base)
                for folder, directories, files in os.walk(base, followlinks=False):
                    for name in sorted(directories + files):
                        if len(pending) == 32:
                            try:
                                row = pending[0].result()
                                if row is not None:
                                    rows.append(row)
                                pending.pop(0)
                            except BaseException as error:
                                first_error = error
                                raise
                        if phase_signals:
                            first_error = InterruptedError('supervisor signal during input manifest')
                            raise first_error
                        pending.append(executor.submit(directory_manifest_entry, pathlib.Path(folder) / name))
        except BaseException as error:
            if first_error is None:
                first_error = error
        while pending:
            try:
                row = pending[0].result()
                if row is not None:
                    rows.append(row)
            except BaseException as error:
                if first_error is None:
                    first_error = error
            finally:
                pending.pop(0)
    except BaseException as error:
        if first_error is None:
            first_error = error
    finally:
        if executor is not None:
            while True:
                try:
                    executor.shutdown(wait=True, cancel_futures=True)
                    assert not any(thread.is_alive() for thread in executor._threads)
                    break
                except BaseException as error:
                    if first_error is None:
                        first_error = error
            for future in pending:
                try:
                    assert future.done(), 'input reader future not terminal after joined shutdown'
                    future.result()
                except BaseException as error:
                    if first_error is None:
                        first_error = error
        cleaning = previous_cleaning
    if first_error is not None:
        raise first_error
    if phase_signals:
        raise InterruptedError('supervisor signal during input manifest')
    return sorted(rows, key=lambda row: row['path'])

def dependencies():
    return directory_manifest([REPO / relative / 'node_modules' for relative in WORKSPACES])

def compiled():
    return directory_manifest([REPO / 'packages/legacy-agent-host/dist',
                               REPO / 'packages/task-change-ledger/dist'])

def toolchain_inventory():
    rows = []
    for folder, directories, files in os.walk(ROOT / 'toolchain', followlinks=False):
        for name in sorted(directories + files):
            path = pathlib.Path(folder) / name
            if stat.S_ISDIR(path.lstat().st_mode):
                continue
            rows.append(file_row(path, path.relative_to(ROOT / 'toolchain').as_posix()))
    return sorted(rows, key=lambda row: row['path'])

def verify_pnpm():
    assert sorted(path.name for path in (ROOT / 'bin').iterdir()) == ([] if pnpm_inventory is None else ['pnpm'])
    for relative in WORKSPACES:
        for name in ['node', 'pnpm']:
            shadow = REPO / relative / 'node_modules/.bin' / name
            assert not (shadow.exists() or shadow.is_symlink()), 'unreviewed package-script tool shadow'
    if pnpm_inventory is None:
        return toolchain_inventory()
    expected = [*pnpm_inventory['members'],
                {'path': 'pnpm-11.22.0.tgz', 'mode': '100644',
                 **{key: pnpm_inventory['archive'][key] for key in ['bytes', 'sha256', 'gitBlob']}}]
    actual = toolchain_inventory()
    assert actual == sorted(expected, key=lambda row: row['path']), 'complete staged pnpm inventory changed'
    assert pathlib.Path(r1['tools']['pnpm']['launcher']).is_symlink()
    assert os.readlink(r1['tools']['pnpm']['launcher']) == r1['tools']['pnpm']['executable']
    assert pathlib.Path(r1['tools']['pnpm']['launcher']).resolve() == pathlib.Path(r1['tools']['pnpm']['executable'])
    return actual

def group_members(pid):
    return [row for row in process_rows() if row['session'] == pid or row['pgid'] == pid]

def interrupt(signum, _frame):
    phase_signals.append(signum)
    if cleaning or finalizing or launching:
        return
    raise InterruptedError('supervisor signal ' + str(signum))

def terminate_captured(child, record, reason):
    global cleaning
    cleaning = True
    cleanup_started = time.monotonic()
    cleanup = {'reason': reason, 'capturedPid': child.pid, 'reaped': False}
    record.setdefault('abnormalCleanup', []).append(cleanup)
    try:
        live = child.poll() is None
        members = [] if live else group_members(child.pid)
        cleanup['leaderWasLive'] = live
        cleanup['membersAfterLeaderExit'] = members
        if live or members:
            try:
                os.killpg(child.pid, signal.SIGKILL)
                cleanup['signal'] = 'SIGKILL to captured group'
            except ProcessLookupError:
                cleanup['alreadyAbsent'] = True
        child.wait(timeout=3)
        cleanup['reaped'] = True
    except BaseException as error:
        cleanup['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        cleanup['durationSeconds'] = time.monotonic() - cleanup_started
        cleaning = False

def run_child(stage, index, argv, deadline, metadata=False):
    global launching, finalizing
    name = stage['id'] + '-' + str(index)
    record = {'argv': argv, 'cwd': stage['cwd'], 'startedAt': utc(), 'timedOut': False,
              'exitCode': None, 'exitSignal': None, 'capturedPid': None, 'metadataOnly': metadata,
              'sourceVectorIdentity': active_source_vector,
              'effectiveEnvironmentIdentity': identity(canonical(env)),
              'bindingIdentity': identity(binding_bytes)}
    tracker = None
    if not metadata:
        tracker = {'id': name, 'invocationReached': True, 'spawnAttempted': False,
                   'capturedPid': None, 'finalReceiptPersisted': False, 'record': record}
        primary_invocations.append(tracker)
    write_new(name + '-start.json', record)
    raw, errors = OUT / (name + '.log'), OUT / (name + '.stderr')
    child, pointer = None, None
    started = time.monotonic()
    try:
        with raw.open('xb') as output:
            error_stream = errors.open('xb') if metadata else None
            try:
                assert deadline > time.monotonic() and not phase_signals, 'deadline/interruption before spawn'
                launching = True
                try:
                    if tracker is not None:
                        tracker['spawnAttempted'] = True
                    child = subprocess.Popen(argv, cwd=stage['cwd'], env=env, stdout=output,
                                             stderr=error_stream if metadata else subprocess.STDOUT,
                                             start_new_session=True)
                finally:
                    launching = False
                record['capturedPid'] = child.pid
                if tracker is not None:
                    tracker['capturedPid'] = child.pid
                if phase_signals:
                    raise InterruptedError('signal during captured launch: ' + repr(phase_signals))
                try:
                    child.wait(timeout=max(0, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    record['timedOut'] = True
                    terminate_captured(child, record, 'absolute command/stage deadline')
            finally:
                if error_stream is not None:
                    error_stream.close()
    except BaseException as error:
        record['executionError'] = type(error).__name__ + ': ' + str(error)
    finally:
        previous_finalizing, finalizing = finalizing, True
        try:
            try:
                if child is not None:
                    record['capturedPid'] = child.pid
                    if tracker is not None:
                        tracker['capturedPid'] = child.pid
                    if child.poll() is None or record.get('executionError'):
                        terminate_captured(child, record, 'abnormal or live command at finalization')
                    remaining = group_members(child.pid)
                    record['remainingBeforeCleanup'] = remaining
                    if remaining:
                        terminate_captured(child, record, 'captured descendants after leader exit')
                    record['remainingCapturedSession'] = group_members(child.pid)
                    record['exitCode'] = child.returncode if child.returncode is not None and child.returncode >= 0 else None
                    record['exitSignal'] = -child.returncode if child.returncode is not None and child.returncode < 0 else None
                else:
                    record['remainingCapturedSession'] = []
                assert not record['remainingCapturedSession'], 'captured command not quiescent'
                for path, key in [(raw, 'raw'), (errors, 'rawStderr')]:
                    if path.exists():
                        record[key] = {'path': str(path), **identity(path.read_bytes())}
            except BaseException as error:
                record['finalizationError'] = type(error).__name__ + ': ' + str(error)
                if child is not None:
                    terminate_captured(child, record, 'failed protected finalization')
            finally:
                record['finishedAt'] = utc()
                record['durationSeconds'] = time.monotonic() - started
                record['interruptions'] = list(phase_signals)
                record['cleanupSeconds'] = sum(row['durationSeconds'] for row in record.get('abnormalCleanup', []))
                record['deadlineExceeded'] = time.monotonic() >= deadline
                record['successful'] = bool(child is not None and record['exitCode'] == 0
                                            and not record['timedOut'] and not record.get('executionError')
                                            and not record.get('finalizationError') and not record.get('abnormalCleanup')
                                            and not record['interruptions'] and not record['deadlineExceeded'])
                pointer = write_new(name + '-receipt.json', record)
                if tracker is not None:
                    tracker['finalReceiptPersisted'] = True
                    tracker['finalReceipt'] = pointer
        finally:
            finalizing = previous_finalizing
    return pointer, record

def git_read(*arguments):
    global metadata_counter
    metadata_counter += 1
    stage = {'id': prefix + '-' + boundary + '-metadata', 'cwd': str(REPO)}
    pointer, record = run_child(stage, metadata_counter, [r1['tools']['git']['path'], *arguments],
                                time.monotonic() + 30, metadata=True)
    assert record['successful'], 'Git metadata failed; retained ' + pointer['path']
    data = pathlib.Path(record['raw']['path']).read_bytes()
    assert identity(data) == {key: record['raw'][key] for key in ['bytes', 'sha256', 'gitBlob']}
    return data


def source_snapshot(overlays):
    global active_source_vector
    active_source_vector = vector_identity(overlays)
    assert git_read('rev-parse', 'HEAD').decode().strip() == SOURCE_COMMIT
    assert git_read('rev-parse', 'HEAD^{tree}').decode().strip() == SOURCE_TREE
    leaves = []
    for raw in git_read('ls-tree', '-rz', '--full-tree', 'HEAD').split(b'\0'):
        if raw:
            metadata, path = raw.split(b'\t', 1)
            mode, kind, blob = metadata.decode().split()
            leaves.append({'path': path.decode(), 'mode': mode, 'type': kind, 'gitBlob': blob})
    expected_leaves = [{key: row[key] for key in ['path', 'mode', 'type', 'gitBlob']}
                       for row in setup['sourceTreeRows']]
    assert sorted(leaves, key=lambda row: row['path']) == sorted(expected_leaves, key=lambda row: row['path'])
    assert len(leaves) == 11567, 'complete source tree changed'
    assert git_read('diff', '--cached', '--name-only', '-z') == b'', 'staged changes'
    assert git_read('ls-files', '--others', '--exclude-standard', '-z') == b'', 'untracked files'
    base = {row['path']: row for row in inputs['sourceNonDoc']['rows']}
    index = {}
    for raw in git_read('ls-files', '--stage', '-z').split(b'\0'):
        if raw:
            metadata, path = raw.split(b'\t', 1)
            mode, blob, stage = metadata.decode().split()
            assert stage == '0', 'unmerged index'
            index[path.decode()] = {'mode': mode, 'gitBlob': blob}
    assert index == {row['path']: {key: row[key] for key in ['mode', 'gitBlob']}
                     for row in expected_leaves}, 'complete stage0 index changed'
    expected = dict(base)
    for row in overlays:
        assert row['path'] in OVERLAY_PATHS and row['mode'] == '100644'
        assert identity(row['content'].encode()) == {key: row[key] for key in ['bytes', 'sha256', 'gitBlob']}
        expected[row['path']] = {key: row[key] for key in ['path', 'mode', 'bytes', 'sha256', 'gitBlob']}
    assert len(base) == len(expected) == 8798 and len({x['path'] for x in overlays}) == len(overlays)
    changed = {path for path in expected if expected[path] != base[path]}
    actual_changed = {p.decode() for p in git_read('diff', '--name-only', '-z', 'HEAD').split(b'\0') if p}
    assert actual_changed == changed, 'tracked source change set differs'
    rows = [file_row(REPO / path, path) for path in sorted(expected)]
    actual = {'actualLocalHead': SOURCE_COMMIT, 'tree': SOURCE_TREE, 'rows': rows,
              'changedTrackedPaths': sorted(changed), 'allTreeLeaves': len(leaves),
              'workflowLeaves': sum(x['path'].startswith('.github/workflows/') for x in leaves),
              'localGitConfig': identity((REPO / '.git/config').read_bytes())}
    pointer = write_new(prefix + '-' + boundary + '-source.json', actual)
    assert rows == [expected[path] for path in sorted(expected)], 'source bytes differ; ' + pointer['path']
    assert actual['localGitConfig'] == inputs['sourceFull']['localGitConfig'], 'local Git configuration changed'
    assert actual['workflowLeaves'] == 42
    return pointer


def provider_archives():
    values = []
    for pin in inputs['providers']['providers']:
        archive = REPO / pin['archivePath']
        assert identity(archive.read_bytes()) == pin['archiveIdentity']
        installed = REPO / pin['installedRoot']
        assert installed.is_dir() and not installed.is_symlink()
        rows, seen = [], set()
        with tarfile.open(archive, 'r:gz') as handle:
            for member in handle.getmembers():
                path = pathlib.PurePosixPath(member.name)
                assert not path.is_absolute() and '..' not in path.parts and path.parts[0] == 'package'
                assert member.name not in seen
                seen.add(member.name)
                if member.isdir():
                    continue
                assert member.isfile(), 'provider archive special/link member'
                relative = path.relative_to('package').as_posix()
                data = handle.extractfile(member).read()
                actual = file_row(installed / relative, relative)
                mode = '100755' if member.mode & stat.S_IXUSR else '100644'
                assert actual == {'path': relative, 'mode': mode, **identity(data)}
                rows.append({'path': relative, 'archiveMode': oct(member.mode), 'mode': mode,
                             **identity(data), 'installedMatch': True})
        assert rows == pin['regularMembers'], 'provider archive member census changed'
        values.append({'name': pin['name'], 'archive': pin['archiveIdentity'],
                       'regularMembers': len(rows), 'allRegularMembersEqual': True})
    return values


def control_snapshot():
    rows = []
    for path, pin in control_pins:
        assert path.is_file() and not path.is_symlink(), 'control path alias'
        actual = identity(path.read_bytes())
        assert actual == pin, 'exact admission control changed: ' + str(path)
        rows.append({'path': str(path), **actual})
    return rows


def source_metadata_snapshot(overlays):
    result = {'source': source_snapshot(overlays), 'tools': tooling(),
              'environment': environment_check(), 'controls': control_snapshot(),
              'fullRuntimeInputsInspected': False, 'dependencies': 'UNINSPECTED',
              'compiled': 'UNINSPECTED', 'providers': 'UNINSPECTED', 'bootstrapCache': 'UNINSPECTED',
              'pnpm': identity((json.dumps(verify_pnpm(), indent=2) + '\n').encode())}
    assert env['AGENT_BACKEND_TEST_NODE'] == r1['tools']['node']['path']
    assert env['TMPDIR'] == str(TASK_TMP) and env['NODE_DISABLE_COMPILE_CACHE'] == '1'
    assert all(key not in env for key in ['NODE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_PORTABLE'])
    result['processCensus'] = process_rows()
    result['testTemps'] = sorted([{'name': path.name, 'device': path.lstat().st_dev,
                                  'inode': path.lstat().st_ino, 'mode': stat.S_IFMT(path.lstat().st_mode)}
                                 for path in TASK_TMP.iterdir() if path.name.startswith('TEST-')],
                                key=lambda row: row['name'])
    result['taskTmpTopEntries'] = sorted(path.name for path in TASK_TMP.iterdir())
    return result


def input_snapshot(overlays):
    result = {'source': source_snapshot(overlays), 'controls': control_snapshot(),
              'fullRuntimeInputsInspected': True}
    checks = [('dependencies', dependencies, inputs['dependencies']),
              ('compiled', compiled, inputs['compiled'])]
    for name, read, expected in checks:
        actual = read()
        pointer = write_new(prefix + '-' + boundary + '-' + name + '.json', actual)
        result[name] = pointer
        assert actual == expected, name + ' changed; retained ' + pointer['path']
    result['providers'] = provider_archives()
    result['rendererRuntime'] = renderer_static_check()
    result['tools'] = tooling()
    result['pnpm'] = identity((json.dumps(verify_pnpm(), indent=2) + '\n').encode())
    result['environment'] = environment_check()
    assert env['AGENT_BACKEND_TEST_NODE'] == r1['tools']['node']['path']
    assert env['TMPDIR'] == str(TASK_TMP) and env['NODE_DISABLE_COMPILE_CACHE'] == '1'
    assert all(key not in env for key in ['NODE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_PORTABLE'])
    cache = []
    for folder, directories, files in os.walk(ROOT / 'tmp', followlinks=False):
        for name in sorted(directories + files):
            path = pathlib.Path(folder) / name
            if stat.S_ISDIR(path.lstat().st_mode):
                continue
            cache.append(file_row(path, path.relative_to(ROOT).as_posix()))
    result['bootstrapCache'] = sorted(cache, key=lambda row: row['path'])
    assert result['bootstrapCache'] == inputs['currentBoundary']['taskTempInventory'], 'bootstrap tmp changed'
    result['processCensus'] = process_rows()
    result['testTemps'] = sorted([{'name': path.name, 'device': path.lstat().st_dev,
                                  'inode': path.lstat().st_ino, 'mode': stat.S_IFMT(path.lstat().st_mode)}
                                 for path in TASK_TMP.iterdir() if path.name.startswith('TEST-')],
                                key=lambda row: row['name'])
    result['taskTmpTopEntries'] = sorted(path.name for path in TASK_TMP.iterdir())
    return result


def preserved(before, after, include_source=True):
    pointer_keys = ['dependencies', 'compiled'] + (['source'] if include_source else [])
    return all(before[key]['sha256'] == after[key]['sha256'] for key in pointer_keys) and all(
        before[key] == after[key] for key in ['providers', 'tools', 'pnpm', 'environment', 'bootstrapCache', 'controls', 'rendererRuntime'])


def ordinary_completion(record):
    return bool(record and record['exitCode'] in [0, 1] and record['exitSignal'] is None
                and not record['timedOut'] and not record.get('executionError')
                and not record.get('finalizationError') and not record.get('abnormalCleanup')
                and not record['interruptions'] and not record['deadlineExceeded']
                and record['remainingCapturedSession'] == [])


def primary_cleanup_seconds(trackers):
    values = [row['record'].get('cleanupSeconds', 0 if not row['spawnAttempted'] else None)
              for row in trackers]
    return sum(values) if all(isinstance(value, (int, float)) for value in values) else None


assert len(sys.argv) == 5, 'binding path, binding SHA256, action and command required'


def vector_identity(overlays):
    return identity(canonical(sorted(
        [{key: row[key] for key in ['path', 'mode', 'bytes', 'sha256', 'gitBlob']} for row in overlays],
        key=lambda row: row['path'])))

def same_identity(data, pin):
    return identity(data) == {key: pin[key] for key in ['bytes', 'sha256', 'gitBlob']}

def regular_pointer(path):
    value = path.lstat()
    assert stat.S_ISREG(value.st_mode) and not stat.S_ISLNK(value.st_mode), 'artifact is not regular'
    data = path.read_bytes()
    after = path.lstat()
    assert (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns) == (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'artifact changed during read'
    return {'path': str(path), **identity(data)}

def renderer_environment_check():
    pins = cfg['rendererRawEnvironment']
    prefix = ('NODE_', 'VITE', 'DENO_', 'AGENT_TEAMS_VITEST_', 'MEMBER_WORK_SYNC_RECOVERY_')
    actual_extra = {key for key in os.environ if key.startswith(prefix)}
    expected_extra = {key for key, pin in pins.items() if pin is not None and key.startswith(prefix)}
    assert actual_extra == expected_extra, 'unreviewed renderer environment key'
    for key, pin in pins.items():
        if pin is None:
            assert key not in os.environ, 'raw renderer environment drift: ' + key
        else:
            assert key in os.environ and same_identity(os.environ[key].encode(), pin), 'raw renderer value drift: ' + key
    absent = cfg['rendererEffectiveAbsentKeys']
    assert all(key not in env for key in absent), 'renderer effective option override'
    assert not any(key.startswith(('VITE', 'DENO_', 'AGENT_TEAMS_VITEST_', 'MEMBER_WORK_SYNC_RECOVERY_'))
                   for key in env), 'renderer inherited prefix override'
    assert env['CI'] == 'true' and env['NODE_DISABLE_COMPILE_CACHE'] == '1'
    assert env['TMPDIR'] == str(TASK_TMP)
    assert env['HOME'] == original_environment['HOME'] == '/home/agent'
    assert env.get('CODEX_HOME') == original_environment.get('CODEX_HOME')
    return {'rawSensitiveValues': pins, 'effectiveAbsentKeys': absent,
            'completeEffectiveValueIdentities': [
                {'key': key, **identity(value.encode())} for key, value in sorted(env.items())],
            'effectiveCanonicalIdentity': identity(canonical(env)),
            'ci': 'true', 'taskTmp': str(TASK_TMP), 'supervisorHomeUnchanged': True,
            'supervisorCodexHomeUnchanged': True}

def renderer_static_check():
    for relative in cfg['rendererAbsentPaths']:
        assert not os.path.lexists(REPO / relative), 'unapproved renderer path: ' + relative
    pins = []
    for pin in cfg['rendererStaticPins']:
        path = REPO / pin['path']
        assert not path.is_symlink() and path.is_file(), 'renderer static input alias'
        actual = file_row(path, pin['path'])
        assert actual == pin, 'renderer static input mismatch: ' + pin['path']
        pins.append(actual)
    links = []
    for route in cfg['rendererStaticLinks']:
        pin = route['pin']
        path = REPO / pin['path']
        assert path.is_symlink(), 'renderer route no longer a link'
        assert file_row(path, pin['path']) == {key: pin[key] for key in ['path', 'mode', 'bytes', 'sha256', 'gitBlob']}
        assert os.readlink(path) == pin['target'] and str(path.resolve()) == route['resolved']
        links.append(route)
    entry = REPO / cfg['rendererEntryRelative']
    assert (REPO / 'node_modules/vitest').resolve() == entry.parent
    assert entry.is_file() and not entry.is_symlink()
    selected = [path for path in base_source if path.startswith(('test/', 'src/'))
                and path.endswith(('.test.ts', '.test.tsx')) and TEST_PATHS[1].lower() in path.lower()]
    assert selected == [TEST_PATHS[1]], 'positional renderer selector is not unique'
    return {'pins': pins, 'links': links, 'absentPaths': cfg['rendererAbsentPaths'],
            'canonicalEntry': str(entry), 'uniqueSelectedFile': str(REPO / TEST_PATHS[1]),
            'fixedConfig': cfg['rendererDerivedConfig'], 'nativeRouteNotEvaluatedByThisStaticRead': True}

def directory_owner(path):
    value = path.lstat()
    assert stat.S_ISDIR(value.st_mode) and not stat.S_ISLNK(value.st_mode), 'owned root alias'
    assert value.st_uid == os.getuid(), 'owned root uid'
    return {'path': str(path), 'device': value.st_dev, 'inode': value.st_ino,
            'mode': stat.S_IMODE(value.st_mode), 'uid': value.st_uid, 'gid': value.st_gid}

def same_directory(path, owner):
    assert directory_owner(path) == owner, 'owned directory identity changed: ' + str(path)

def node_tmp_gate():
    same_directory(TASK_TMP, task_tmp_owner)
    entries = sorted(path.name for path in TASK_TMP.iterdir())
    observation = {'path': str(TASK_TMP), 'owner': task_tmp_owner, 'entries': entries,
                   'beforeSupervisorDeletion': True, 'nodeDebtErased': False}
    pointer = write_new(prefix + '-node-tmp-gate.json', observation)
    assert entries == [], 'Node temporary debt retained; renderer is UNREACHED'
    return pointer


def stat_signature(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)

def owner_matches_fd(fd, owner):
    value = os.fstat(fd)
    assert stat.S_ISDIR(value.st_mode)
    assert (value.st_dev, value.st_ino, stat.S_IMODE(value.st_mode), value.st_uid, value.st_gid) == (
        owner['device'], owner['inode'], owner['mode'], owner['uid'], owner['gid'])
    return value

def open_owned_root(path, owner):
    same_directory(path, owner)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        owner_matches_fd(fd, owner)
        same_directory(path, owner)
        return fd
    except BaseException:
        os.close(fd)
        raise

def read_regular_at(parent_fd, name, expected):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        assert stat.S_ISREG(opened.st_mode) and stat_signature(opened) == stat_signature(expected), 'opened transient differs'
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            body = handle.read()
        assert stat_signature(os.fstat(fd)) == stat_signature(expected), 'transient changed during fd read'
        assert stat_signature(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) == stat_signature(expected), 'transient name replaced during fd read'
        return body
    finally:
        os.close(fd)

def walk_error(error):
    raise error

def owned_inventory(path, owner, family):
    root_fd = open_owned_root(path, owner)
    rows, directories_seen, visited = [], {'.': stat_signature(os.fstat(root_fd))}, set()
    try:
        for folder, directories, files, folder_fd in os.fwalk(
                '.', topdown=True, onerror=walk_error, follow_symlinks=False, dir_fd=root_fd):
            relative_folder = pathlib.PurePosixPath(folder).as_posix()
            assert relative_folder in directories_seen, 'unobserved transient ancestry'
            assert relative_folder not in visited, 'duplicate directory traversal'
            visited.add(relative_folder)
            assert stat_signature(os.fstat(folder_fd)) == directories_seen[relative_folder], 'transient ancestry replaced'
            directories.sort()
            names = sorted(directories + files)
            assert len(names) == len(set(names)), 'duplicate transient entry'
            for name in names:
                relative = (pathlib.PurePosixPath(relative_folder) / name).as_posix()
                before = os.stat(name, dir_fd=folder_fd, follow_symlinks=False)
                assert before.st_dev == owner['device'] and before.st_uid == owner['uid'], 'unowned transient'
                kind = 'directory' if stat.S_ISDIR(before.st_mode) else 'link' if stat.S_ISLNK(before.st_mode) else 'file' if stat.S_ISREG(before.st_mode) else 'unknown'
                row = {'path': relative, 'kind': kind, 'device': before.st_dev, 'inode': before.st_ino,
                       'mode': stat.S_IMODE(before.st_mode), 'uid': before.st_uid, 'gid': before.st_gid,
                       'size': before.st_size, 'mtimeNs': before.st_mtime_ns, 'ctimeNs': before.st_ctime_ns}
                if kind == 'link':
                    row['target'] = os.readlink(name, dir_fd=folder_fd)
                elif kind == 'file':
                    body = read_regular_at(folder_fd, name, before)
                    row.update(identity(body))
                    row['contentBase64'] = base64.b64encode(body).decode()
                elif kind == 'directory':
                    directories_seen[relative] = stat_signature(before)
                else:
                    raise AssertionError('special transient retained: ' + relative)
                after = os.stat(name, dir_fd=folder_fd, follow_symlinks=False)
                assert stat_signature(before) == stat_signature(after), 'transient changed during capture'
                rows.append(row)
        assert visited == set(directories_seen), 'incomplete surviving-directory traversal'
        rows.sort(key=lambda row: row['path'])
        owner_matches_fd(root_fd, owner)
        same_directory(path, owner)
        return {'root': owner, 'family': family, 'rows': rows,
                'claim': 'Complete surviving owned entries before supervisor deletion; no history of self-deleted files.'}
    finally:
        os.close(root_fd)

def open_captured_parent(root_fd, parts, captured):
    fd = os.dup(root_fd)
    relative = []
    try:
        for name in parts:
            relative.append(name)
            row = captured['/'.join(relative)]
            assert row['kind'] == 'directory'
            next_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                owner_matches_fd(next_fd, row)
                current = os.stat(name, dir_fd=fd, follow_symlinks=False)
                assert (current.st_dev, current.st_ino) == (row['device'], row['inode'])
            except BaseException:
                os.close(next_fd)
                raise
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise

def expected_renderer_transient(row, family):
    path = row['path']
    parts = path.split('/')
    if family == 'vite-config':
        return row['kind'] == 'file' and len(parts) == 1 and re.fullmatch(
            r'vitest\.config\.ts\.timestamp-\d+-[0-9a-f]*\.mjs', path) is not None
    first = parts[0]
    if re.fullmatch(r'agent-teams-vitest-home-[A-Za-z0-9]{6}', first):
        return row['kind'] == 'directory' if len(parts) == 1 else row['kind'] in ['directory', 'file', 'link']
    if re.fullmatch(r'[A-Za-z0-9_-]{21}', first):
        if len(parts) == 1:
            return row['kind'] == 'directory'
        if parts[1] not in ['web', 'ssr']:
            return False
        if len(parts) == 2:
            return row['kind'] == 'directory'
        return len(parts) == 3 and row['kind'] == 'file' and re.fullmatch(
            r'(?:[0-9a-f]{40}|\.tmp-\d+-[0-9a-z]*)', parts[2]) is not None
    return len(parts) == 1 and row['kind'] == 'file' and re.fullmatch(r'esbuild-[0-9a-f]{64}', first) is not None



def capture_and_remove_owned(path, owner, family):
    first = owned_inventory(path, owner, family)
    pointer = write_new(prefix + '-' + family + '-surviving-transients.json', first)
    assert all(expected_renderer_transient(row, family) for row in first['rows']), 'unattributed transient retained'
    assert first == owned_inventory(path, owner, family), 'transients changed after complete retention'
    captured = {row['path']: row for row in first['rows']}
    root_fd = open_owned_root(path, owner)
    try:
        for row in sorted(first['rows'], key=lambda row: (len(row['path'].split('/')), row['path']), reverse=True):
            parts = row['path'].split('/')
            parent_fd = open_captured_parent(root_fd, parts[:-1], captured)
            try:
                name = parts[-1]
                current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                assert (current.st_dev, current.st_ino, stat.S_IMODE(current.st_mode), current.st_uid, current.st_gid) == (
                    row['device'], row['inode'], row['mode'], row['uid'], row['gid'])
                if row['kind'] == 'directory':
                    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                    try:
                        owner_matches_fd(fd, row)
                        assert os.listdir(fd) == [], 'captured directory acquired new entry'
                        check = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                        assert (check.st_dev, check.st_ino) == (row['device'], row['inode']), 'captured directory name replaced'
                        os.rmdir(name, dir_fd=parent_fd)
                    finally:
                        os.close(fd)
                else:
                    assert (current.st_size, current.st_mtime_ns, current.st_ctime_ns) == (row['size'], row['mtimeNs'], row['ctimeNs'])
                    if row['kind'] == 'link':
                        assert stat.S_ISLNK(current.st_mode) and os.readlink(name, dir_fd=parent_fd) == row['target']
                    else:
                        assert same_identity(read_regular_at(parent_fd, name, current), row)
                    assert stat_signature(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) == stat_signature(current), 'captured name replaced before unlink'
                    os.unlink(name, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
        owner_matches_fd(root_fd, owner)
        same_directory(path, owner)
        assert os.listdir(root_fd) == [], 'owned root has remaining entries'
        if family == 'vite-config':
            parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                check = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
                assert (check.st_dev, check.st_ino, stat.S_IMODE(check.st_mode)) == (
                    owner['device'], owner['inode'], owner['mode'])
                same_directory(path, owner)
                os.rmdir(path.name, dir_fd=parent_fd)
                assert not os.path.lexists(path), 'owned vite directory remains'
                try:
                    os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise AssertionError('owned vite name remains in captured parent')
            finally:
                os.close(parent_fd)
    finally:
        os.close(root_fd)
    return {'survivingCapture': pointer, 'capturedEntries': len(first['rows']),
            'remainingEntries': [], 'removedRoot': family == 'vite-config',
            'source': 'Exact retained entries removed using owned directory descriptors after captured-session quiescence.'}

NATIVE_METADATA_CODE = "'use strict';\nconst os = require('node:os');\nlet reads = 1;\nlet header = process.report.getReport().header;\nconst firstHeaderNullish = header == null;\nif (firstHeaderNullish) {\n  reads++;\n  header = process.report.getReport().header;\n}\nconst finalHeaderFalsy = !header;\nconst glibcVersionRuntime = header && header.glibcVersionRuntime || null;\nprocess.stdout.write(JSON.stringify({\n  platform: process.platform, arch: process.arch, nodeVersion: process.version,\n  endianness: os.endianness(), execPath: process.execPath, cwd: process.cwd(),\n  denoAbsent: typeof process.versions.deno === 'undefined' && typeof globalThis.Deno === 'undefined',\n  pnpAbsent: typeof process.versions.pnp === 'undefined',\n  requireModule: process.features.require_module === true,\n  reportReads: reads, firstHeaderNullish, finalHeaderFalsy, glibcVersionRuntime,\n  selectedRollupGnu: finalHeaderFalsy || Boolean(glibcVersionRuntime)\n}) + '\\n');\n"

def node_semantics(record):
    raw_bytes = pathlib.Path(record['raw']['path']).read_bytes()
    assert same_identity(raw_bytes, record['raw'])
    raw = raw_bytes.decode('utf-8')
    assert '\x1b' not in raw, 'unexpected colored Node output'
    assert raw.count('\nℹ tests ') == 1, 'missing/duplicate Node census'
    cases_text, remainder = raw.split('\nℹ tests ', 1)
    summary_text = 'ℹ tests ' + remainder
    separator = '\n\n✖ failing tests:\n\n'
    assert summary_text.count(separator) <= 1
    summary_text, failure_tail = (summary_text.split(separator, 1) if separator in summary_text
                                  else (summary_text, ''))
    lines = [line for line in summary_text.splitlines() if line]
    assert len(lines) == 8, 'unexpected Node summary output'
    expected = [('tests', 139), ('suites', 0), ('pass', 134 if phase == 'red' else 139),
                ('fail', 5 if phase == 'red' else 0), ('cancelled', 0), ('skipped', 0), ('todo', 0)]
    for line, (name, value) in zip(lines[:7], expected):
        assert line == 'ℹ ' + name + ' ' + str(value), 'Node summary mismatch: ' + line
    duration = re.fullmatch(r'ℹ duration_ms (\d+(?:\.\d+)?)', lines[7])
    assert duration and 0 <= float(duration.group(1)) < 180000
    cases, auxiliary = [], []
    for line in cases_text.splitlines():
        if not line:
            continue
        match = re.fullmatch(r'([✔✖]) (.+) \((\d+(?:\.\d+)?)ms\)', line)
        if match:
            cases.append({'ordinal': len(cases) + 1, 'name': match.group(2),
                          'status': 'passed' if match.group(1) == '✔' else 'failed',
                          'durationMsText': match.group(3)})
        else:
            auxiliary.append(line)
    assert len(cases) == 139 and [row['name'] for row in cases] == cfg['nodeNames']
    assert len({row['name'] for row in cases}) == 139
    assert len(auxiliary) <= 2
    for line in auxiliary:
        assert (re.fullmatch(r'\(node:\d+\) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time', line)
                or re.fullmatch(r'\(Use .*--trace-warnings.* to show where the warning was created\)', line)), 'unknown Node output: ' + line
    failed = [row for row in cases if row['status'] == 'failed']
    assert [row['ordinal'] for row in failed] == ([134, 135, 136, 138, 139] if phase == 'red' else [])
    blocks = []
    if phase == 'red':
        starts = list(re.finditer(r'^test at ' + re.escape(TEST_PATHS[0]) + r':(\d+):(\d+)$', failure_tail, re.MULTILINE))
        assert len(starts) == len(cfg['nodeRedFailureSites']) == 5 and starts[0].start() == 0, 'Node failure detail census'
        for index, (match, case, site) in enumerate(zip(starts, failed, cfg['nodeRedFailureSites'])):
            block = failure_tail[match.start():starts[index + 1].start() if index + 1 < len(starts) else len(failure_tail)]
            assert [int(match.group(1)), int(match.group(2))] == site['registration']
            assert block.splitlines()[1] == '✖ ' + case['name'] + ' (' + case['durationMsText'] + 'ms)'
            assert block.rstrip().endswith('  }'), 'unrecognized trailing Node failure output'
            assert len(re.findall(r'^  AssertionError \[ERR_ASSERTION\]:', block, re.MULTILINE)) == 1
            location = 'file://' + str(REPO / TEST_PATHS[0]) + ':' + ':'.join(map(str, site['assertion']))
            assert re.search(r'at (?:async )?TestContext\.<anonymous> \(' + re.escape(location) + r'\)', block)
            assert "code: 'ERR_ASSERTION'" in block and "operator: '" + site['operator'] + "'" in block
            if site['operator'] == 'rejects':
                assert 'AssertionError [ERR_ASSERTION]: Missing expected rejection.' in block
                assert re.search(r'^\s+actual: undefined,\s*$', block, re.MULTILINE)
            else:
                assert 'AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:' in block
                actual = r"actual:\s*\[\s*'read',\s*'scroll',\s*'focus',\s*'insert',\s*'submit'\s*\]"
                expected_trace = r"expected:\s*\[\s*'read',\s*'read',\s*'scroll',\s*'focus',\s*'insert',\s*'submit'\s*\]"
                assert re.search(actual, block) and re.search(expected_trace, block)
            blocks.append({'ordinal': case['ordinal'], 'site': site, 'fullFailureBlock': block})
    else:
        assert failure_tail == ''
    return write_new(prefix + '-node-semantics.json', {
        'test': TEST_IDENTITIES['node'], 'raw': record['raw'], 'cases': cases,
        'summary': {**dict(expected), 'durationMs': float(duration.group(1))},
        'auxiliaryLines': auxiliary, 'failures': blocks, 'exactSemanticOutcome': True,
        'qualification': 'RED reaches only the first failing assertion in each failed case; GREEN must pass every branch.'})

def renderer_semantics(record):
    raw_bytes = pathlib.Path(record['raw']['path']).read_bytes()
    assert same_identity(raw_bytes, record['raw'])
    raw = raw_bytes.decode('utf-8')
    assert '\x1b' not in raw, 'unexpected colored renderer output'
    forbidden = [
        r'unhandled (?:error|rejection)', r'uncaught (?:exception|error)', r'error during close',
        r'close timed out', r'still running', r'vitest did not exit',
        r'failed to load config', r'failed to resolve', r'cannot find (?:module|package)',
        r'ERR_DLOPEN_FAILED', r'unexpected console\.(?:error|warn) calls',
        r'^\s*(?:stderr|stdout)\s*\|',
        r'^(?:\[[^\]\n]+\]\s*)?(?:WARN(?:ING)?|DeprecationWarning)\b',
        r'^\(node:\d+\)\s+(?:[A-Za-z]+Warning|Warning):',
        r'failed to (?:write|save).*report', r'error writing.*report']
    for pattern in forbidden:
        assert not re.search(pattern, raw, re.IGNORECASE | re.MULTILINE), 'renderer diagnostic: ' + pattern
    result_path = OUT / 'renderer-results.json'
    pointer = regular_pointer(result_path)
    data = result_path.read_bytes()
    assert same_identity(data, pointer)
    result = json.loads(data)
    counters = {'numTotalTests': 85, 'numPassedTests': 82 if phase == 'red' else 85,
                'numFailedTests': 3 if phase == 'red' else 0, 'numPendingTests': 0, 'numTodoTests': 0,
                'numTotalTestSuites': 2, 'numPassedTestSuites': 0 if phase == 'red' else 2,
                'numFailedTestSuites': 2 if phase == 'red' else 0, 'numPendingTestSuites': 0}
    assert all(result.get(key) == value for key, value in counters.items()), 'renderer counters'
    assert result.get('success') is (phase == 'green')
    assert len(result.get('testResults', [])) == 1
    file = result['testResults'][0]
    assert file['name'] == str(REPO / TEST_PATHS[1])
    assert file['status'] == ('failed' if phase == 'red' else 'passed') and file['message'] == ''
    assertions = file['assertionResults']
    assert len(assertions) == 85 and [row['title'] for row in assertions] == cfg['rendererNames']
    assert len({row['fullName'] for row in assertions}) == 85
    for ordinal, row in enumerate(assertions, 1):
        assert row['ancestorTitles'] == ['useRuntimeProviderManagement']
        assert row['fullName'] == 'useRuntimeProviderManagement ' + row['title']
        expected_failure = phase == 'red' and ordinal in [81, 82, 83]
        assert row['status'] == ('failed' if expected_failure else 'passed')
        assert not row.get('pending') and not row.get('todo')
        messages = row['failureMessages']
        if expected_failure:
            assert len(messages) == 1 and isinstance(messages[0], str)
            message = messages[0]
            site = cfg['rendererRedFailureSites'][str(ordinal)]
            assert 'expected true to be false' in message
            assert TEST_PATHS[1] + ':' + ':'.join(map(str, site)) in message
            assert row['title'] in raw and 'expected true to be false' in raw
        else:
            assert messages == []
    assert 'JSON report written to ' + str(result_path) in raw
    snapshots = result.get('snapshot', {})
    for key in ['added', 'updated', 'unchecked', 'unmatched', 'filesAdded', 'filesRemoved', 'filesUnmatched', 'filesUpdated']:
        assert snapshots.get(key, 0) == 0, 'renderer snapshot mutation: ' + key
    assert snapshots.get('failure', False) is False
    return write_new(prefix + '-renderer-semantics.json', {
        'test': TEST_IDENTITIES['renderer'], 'raw': record['raw'], 'result': pointer,
        'summary': counters, 'assertions': assertions, 'snapshot': snapshots,
        'defaultReporterDiagnosticsChecked': True, 'exactSemanticOutcome': True,
        'qualification': 'Exact whole-file result and retained default reporter diagnostics; no broader GUI/native qualification.'})

def native_route_gate():
    global metadata_counter
    metadata_counter += 1
    started = time.monotonic()
    pointer, record = run_child({'id': prefix + '-native-metadata', 'cwd': str(REPO)},
                                metadata_counter, cfg['nativeMetadataArgv'], started + 30, metadata=True)
    assert record['successful'] and ordinary_completion(record) and record['exitCode'] == 0
    raw = pathlib.Path(record['raw']['path']).read_bytes()
    stderr = pathlib.Path(record['rawStderr']['path']).read_bytes()
    assert same_identity(raw, record['raw']) and same_identity(stderr, record['rawStderr']) and stderr == b''
    actual = json.loads(raw)
    fixed = {'platform': 'linux', 'arch': 'x64', 'nodeVersion': 'v24.22.1', 'endianness': 'LE',
             'execPath': NODE, 'cwd': str(REPO), 'denoAbsent': True, 'pnpAbsent': True,
             'requireModule': True, 'selectedRollupGnu': True}
    assert all(actual.get(key) == value for key, value in fixed.items()), 'native route differs'
    assert actual['reportReads'] == (2 if actual['firstHeaderNullish'] else 1)
    assert actual['selectedRollupGnu'] == (actual['finalHeaderFalsy'] or bool(actual['glibcVersionRuntime']))
    assert not os.path.lexists(REPO / cfg['rollupLocalOverride'])
    assert time.monotonic() < started + 30 and not phase_signals
    return write_new(prefix + '-native-route-admission.json', {
        'metadataReceipt': pointer, 'record': record, 'actualBuiltinObservation': actual,
        'nativePins': cfg['rendererNativePins'], 'packageOrNativeCodeEvaluatedByMetadata': False})


binding_path, binding_sha, action, command = sys.argv[1:]
assert action in ['run', 'materialize']
binding_file = pathlib.Path(binding_path)
assert binding_file.is_file() and not binding_file.is_symlink()
binding_bytes = binding_file.read_bytes()
assert hashlib.sha256(binding_bytes).hexdigest() == binding_sha
cfg = json.loads(binding_bytes)
assert pathlib.Path(__file__).resolve() == pathlib.Path(cfg['runnerLocalPath'])
assert binding_file.resolve() == pathlib.Path(cfg['bindingLocalPath'])
assert not pathlib.Path(__file__).is_symlink()
assert identity(pathlib.Path(__file__).read_bytes()) == cfg['runnerIdentity']
assert cfg['publishedR1'] == R1
assert identity(cfg['combinedR1Body'].encode()) == cfg['combinedR1Identity']
assert cfg['combinedR1Identity']['gitBlob'] == R1_BLOB
combined_r1 = json.loads(cfg['combinedR1Body'])
assert cfg['combinedR1ActualReadbackAccepted'] is True
assert cfg['actualPublishedSubjectReadbackAccepted'] is True
assert cfg['combinedInputImportAdmission']['accepted'] is True
assert cfg['combinedInputImportAdmission']['sourceCommit'] == SOURCE_COMMIT
assert cfg['combinedInputImportAdmission']['sourceTree'] == SOURCE_TREE
assert cfg['testIdentities'] == TEST_IDENTITIES
phase = cfg['phase']
assert phase in ['red', 'green']
assert command in (['red'] if phase == 'red' else ['green', 'validation-package'])
assert action != 'materialize' or command == phase
phase_id = ('materialize-tests' if phase == 'red' else 'materialize-producers') if action == 'materialize' else (
    'validation' if command == 'validation-package' else phase)
OUT = OUTROOT / phase_id
TASK_TMP = OUT / 'tmp'
assert cfg['outputRoots'] == {key: str(OUTROOT / key) for key in
    ['materialize-tests', 'red', 'materialize-producers', 'green', 'validation']}
assert cfg['tempRoots'] == {key: str(OUTROOT / key / 'tmp') for key in cfg['outputRoots']}
assert str(OUTROOT) == combined_r1['execution']['outputRoot']
assert str(pathlib.Path(cfg['runnerLocalPath']).parent) == combined_r1['execution']['controlRoot']
assert str(binding_file.parent) == combined_r1['execution']['controlRoot']
assert set(cfg['inputFiles']) == set(INPUT_PATHS)
assert ROOT.is_dir() and not ROOT.is_symlink() and REPO.is_dir() and not REPO.is_symlink()
for name in ['toolchain', 'bin', 'evidence', 'tmp', 'store', 'cache', 'state', 'config', 'data']:
    assert (ROOT / name).is_dir() and not (ROOT / name).is_symlink(), name + ' root alias'
control_pins = [(pathlib.Path(__file__), cfg['runnerIdentity']), (binding_file, identity(binding_bytes))]
inputs = {}
for name, path in INPUT_PATHS.items():
    pin = cfg['inputFiles'][name]
    assert str(path) == pin['path'] and path.is_file() and not path.is_symlink()
    data = path.read_bytes()
    expected = {key: pin[key] for key in ['bytes', 'sha256', 'gitBlob']}
    assert identity(data) == expected, name
    control_pins.append((path, expected))
    inputs[name] = json.loads(data)
setup = inputs['setupBinding']
r1, amendment = json.loads(setup['r1Body']), json.loads(setup['amendmentBody'])
assert identity(setup['r1Body'].encode()) == setup['r1Identity']
assert identity(setup['amendmentBody'].encode()) == setup['amendmentIdentity']
assert setup['publishedR1'] == '7e6f32741ccdb470e7688cec9de9481fd05827a1'
assert setup['publishedAmendment'] == '0042eec33e3bcf145de25db96f5fc7c5b026a1fe'
assert len(cfg['acceptedReviewBodies']) >= 21
for review in cfg['acceptedReviewBodies']:
    assert identity(review['body'].encode()) == review['identity']
assert len(inputs['sourceFull']['rows']) == 11567 and len(inputs['sourceNonDoc']['rows']) == 8798
assert len(inputs['dependencies']) == 122773 and len(inputs['compiled']) == 1454
assert inputs['sourceFull']['head'] == inputs['sourceNonDoc']['head'] == SOURCE_COMMIT
assert inputs['sourceFull']['tree'] == inputs['sourceNonDoc']['tree'] == SOURCE_TREE
assert len(cfg['nodeNames']) == len(set(cfg['nodeNames'])) == 139
assert cfg['nodeNames'][-6:] == combined_r1['nodeTestFirst']['names']
assert cfg['rendererNames'] == [*combined_r1['rendererTestFirst']['originalNames'], *combined_r1['rendererTestFirst']['names']]
assert len(cfg['rendererNames']) == len(set(cfg['rendererNames'])) == 85
preimages = {row['path']: row for row in combined_r1['nineBoundSourceRows']}
for overlays in [cfg['beforeSourceOverlay'], cfg['sourceOverlay']]:
    assert len(overlays) == 9 and sorted(row['path'] for row in overlays) == sorted(OVERLAY_PATHS)
    for row in overlays:
        assert row['mode'] == '100644' and same_identity(row['content'].encode(), row)
        if row['path'] in FIXED_PATHS:
            assert same_identity(row['content'].encode(), preimages[row['path']]), 'fixed producer changed'
        if row['path'] in PRODUCER_PATHS:
            cap = 2068 if row['path'] == PRODUCER_PATHS[2] else 800
            assert len(row['content'].splitlines()) <= cap
for row in cfg['beforeSourceOverlay']:
    expected = TEST_IDENTITIES['node' if row['path'] == TEST_PATHS[0] else 'renderer'] if (
        phase == 'green' and row['path'] in TEST_PATHS) else preimages[row['path']]
    assert same_identity(row['content'].encode(), expected), 'materialization preimage differs'
for row in cfg['sourceOverlay']:
    if row['path'] in TEST_PATHS:
        assert same_identity(row['content'].encode(), TEST_IDENTITIES['node' if row['path'] == TEST_PATHS[0] else 'renderer'])
    elif phase == 'red':
        assert same_identity(row['content'].encode(), preimages[row['path']]), 'RED producer differs'
base_source = {row['path']: row for row in inputs['sourceNonDoc']['rows']}
def compose_source(overlays):
    result = dict(base_source)
    for row in overlays:
        result[row['path']] = {key: row[key] for key in ['path', 'mode', 'bytes', 'sha256', 'gitBlob']}
    assert len(result) == 8798
    return result
expected_source = compose_source(cfg['sourceOverlay'])
before_source = compose_source(cfg['beforeSourceOverlay'])
written_paths = TEST_PATHS if phase == 'red' else PRODUCER_PATHS
assert cfg['materializePaths'] == written_paths
assert sorted(path for path in expected_source if expected_source[path] != before_source[path]) == sorted(written_paths)
assert cfg['sourcePins'] == [expected_source[path] for path in sorted(OVERLAY_PATHS)]
assert cfg['sourceVectorIdentity'] == vector_identity(cfg['sourceOverlay'])
assert len([path for path in expected_source if expected_source[path] != base_source[path]]) == (6 if phase == 'red' else 9)
assert len([path for path in before_source if before_source[path] != base_source[path]]) == (5 if phase == 'red' else 6)
pnpm_inventory = inputs['pnpm']
original_environment = os.environ.copy()
env, captured_transport = admit_environment(original_environment)
for key in ['NODE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_PORTABLE']:
    env.pop(key, None)
env.update({'NODE_DISABLE_COMPILE_CACHE': '1', 'AGENT_BACKEND_TEST_NODE': r1['tools']['node']['path'],
            'TMPDIR': str(TASK_TMP)})
tempfile.tempdir = str(TASK_TMP)
absent_configs = [*r1['environment']['absentConfigFiles'], amendment['admission']['additionalAbsentConfig']['path']]
normalized_prefix = next(value for key, value in captured_transport.items() if key.lower() == 'npm_config_prefix')
NODE = r1['tools']['node']['path']
assert cfg['commandVectors'] == combined_r1['execution']['commandVectors']
assert cfg['commandVectors']['node'] == [NODE, '--test', TEST_PATHS[0]]
assert cfg['nativeMetadataArgv'] == [NODE, '--input-type=commonjs', '-e', NATIVE_METADATA_CODE]
assert cfg['executionScope']['requiresObservedSupervisorExitZeroForContinuation'] is True

def accepted_combined(name, expected_phase):
    pin = cfg[name]
    assert pin['independentReviewAccepted'] is True and pin['observedOuterSupervisorExit'] == 0
    assert pin['actualPublicationReadbackAccepted'] is True
    data = pin['receiptBody'].encode()
    assert identity(data) == pin['identity']
    value = json.loads(data)
    assert value['action'] == 'run' and value['command'] == value['phase'] == expected_phase
    assert value['exitCode'] == (1 if expected_phase == 'red' else 0)
    assert value['scopeCompleted'] and value['commandCompletedNormally'] and value['semanticAdmissionComplete']
    assert value['inputsPreserved'] and value['fullRuntimeInputsInspected'] and value['fullRuntimeInputsPreserved']
    assert value['testIdentities'] == TEST_IDENTITIES and value['runnerIdentity'] == cfg['runnerIdentity']
    assert value['interruptions'] == [] and value['primaryFinalizationComplete']
    assert not any(value.get(key) for key in ['executionError', 'postflightError', 'transientCleanupError'])
    cleanup = value['cleanup']
    assert all(cleanup[key] == [] for key in ['unknownPrimaryLaunches', 'capturedSessionMembersAfter',
                                            'newTestTempsRemaining', 'taskTmpEntriesAfter'])
    assert cleanup['viteTempAbsent'] is True and cleanup['nodeDebtGatePassed'] is True
    assert [row['command'] for row in value['suiteCommands']] == ['node', 'renderer']
    assert all(row['status'] == 'ACCEPTED' for row in value['suiteCommands'])
    return value
if phase == 'green':
    red = accepted_combined('acceptedCombinedRed', 'red')
    assert red['sourceVectorIdentity'] == vector_identity(cfg['beforeSourceOverlay'])
    assert cfg['producerR2ReviewedAndPublished'] is True and cfg['producerActualReadbackAccepted'] is True
if action == 'run' and command in ['red', 'green']:
    materialized_path = OUTROOT / ('materialize-tests' if phase == 'red' else 'materialize-producers') / 'phase-receipt.json'
    assert materialized_path.is_file() and not materialized_path.is_symlink()
    materialized_bytes = materialized_path.read_bytes()
    control_pins.append((materialized_path, identity(materialized_bytes)))
    materialized = json.loads(materialized_bytes)
    assert materialized['action'] == 'materialize' and materialized['command'] == phase
    assert materialized['bindingIdentity'] == identity(binding_bytes)
    assert materialized['publishedSubject'] == cfg['publishedSubject']
    assert materialized['testIdentities'] == TEST_IDENTITIES
    assert materialized['sourceVectorIdentity'] == cfg['sourceVectorIdentity']
    assert materialized['scopeCompleted'] and materialized['sourceAndSupervisorMetadataPreserved']
    assert materialized['fullRuntimeInputsInspected'] is False
    assert materialized['fullRuntimeInputsPreserved'] is None and materialized['inputsPreserved'] is None
    assert materialized['writtenPaths'] == written_paths and materialized['interruptions'] == []
    assert all(materialized['cleanup'][key] == [] for key in [
        'unknownPrimaryLaunches', 'capturedSessionMembersAfter', 'newTestTempsRemaining', 'taskTmpEntriesAfter'])
    assert materialized['cleanup']['viteTempAbsent'] is True
    assert not any(materialized.get(key) for key in ['executionError', 'postflightError', 'transientCleanupError'])
if command == 'validation-package':
    green = accepted_combined('acceptedCombinedGreen', 'green')
    assert green['publishedSubject'] == cfg['publishedSubject'] and green['sourcePins'] == cfg['sourcePins']
    assert green['sourceVectorIdentity'] == cfg['sourceVectorIdentity']
owner = {'kind': 'c714-combined139-renderer85-evidence', 'base': SOURCE_COMMIT, 'publishedR1': R1,
         'r1Identity': cfg['combinedR1Identity'], 'runner': cfg['runnerIdentity'], 'tests': TEST_IDENTITIES}
owner_data = (json.dumps(owner, indent=2) + '\n').encode()
if os.path.lexists(OUTROOT):
    assert OUTROOT.is_dir() and not OUTROOT.is_symlink()
    assert stat.S_IMODE(OUTROOT.stat().st_mode) == 0o700 and OUTROOT.stat().st_uid == os.getuid()
    owner_path = OUTROOT / 'owner.json'
    assert owner_path.is_file() and not owner_path.is_symlink() and owner_path.read_bytes() == owner_data
else:
    OUTROOT.mkdir(mode=0o700, exist_ok=False)
    with (OUTROOT / 'owner.json').open('xb') as handle:
        handle.write(owner_data)
OUT.mkdir(mode=0o700, exist_ok=False)
assert OUT.is_dir() and not OUT.is_symlink() and stat.S_IMODE(OUT.stat().st_mode) == 0o700
TASK_TMP.mkdir(mode=0o700, exist_ok=False)
task_tmp_owner = directory_owner(TASK_TMP)
assert task_tmp_owner['mode'] == 0o700 and list(TASK_TMP.iterdir()) == []
assert shutil.disk_usage(REPO).free >= 8 * 1024 * 1024 and shutil.disk_usage(OUT).free >= 64 * 1024 * 1024
prefix = phase_id
runtime_inputs = action == 'run'
with (OUT / (prefix + '.attempt')).open('x') as handle:
    handle.write(utc() + '\n')


receipt = {'kind': 'combined-whole-node139-renderer85-bounded-invocation', 'command': command,
           'action': action, 'phase': phase, 'attempt': 1, 'startedAt': utc(),
           'publishedR1': R1, 'publishedSubject': cfg['publishedSubject'], 'actualLocalHead': SOURCE_COMMIT,
           'runnerIdentity': cfg['runnerIdentity'], 'bindingIdentity': identity(binding_bytes),
           'testIdentities': TEST_IDENTITIES, 'sourcePins': cfg['sourcePins'],
           'sourceVectorIdentity': cfg['sourceVectorIdentity'], 'cwd': str(REPO),
           'perPrimaryCommandLimitSeconds': 180, 'metadataCommandLimitSeconds': 30,
           'fullRuntimeInputsRequested': runtime_inputs, 'fullRuntimeInputsInspected': False,
           'fullRuntimeInputBoundaries': {key: 'UNREACHED' if runtime_inputs else 'UNINSPECTED' for key in ['before', 'after']},
           'fullRuntimeInputsPreserved': False if runtime_inputs else None,
           'inputsPreserved': False if runtime_inputs else None, 'sourceAndSupervisorMetadataPreserved': False,
           'commandCompletedNormally': False, 'semanticAdmissionComplete': False,
           'exitCode': None, 'exitSignal': None, 'timedOut': False, 'cleanupSeconds': 0, 'commandPhaseSeconds': 0,
           'cleanupTimeAccounting': 'Captured process termination/reap is within command time; separately recorded surviving-file capture/removal is package output accounting.',
           'snapshotScope': 'whole package; complete fresh before/after inputs shared by its separately captured commands' if runtime_inputs else 'source-and-supervisor-metadata-only',
           'qualification': 'Finite actual-source suites/scoped guards only; no GUI/native/vendor or whole E2E qualification.',
           'owner': owner, 'taskTmpOwner': task_tmp_owner}
if not runtime_inputs:
    receipt['uninspectedRuntimeInputs'] = {key: 'UNINSPECTED' for key in
        ['dependencies', 'compiled', 'providerArchivesAndInstalledMembers', 'bootstrapNodeCache']}
elif command == 'validation-package':
    receipt['validationCommands'] = [
        {'command': name, 'argv': argv, 'status': 'UNREACHED'} for name, argv in zip(
            ['lint-node', 'lint-renderer', 'source-size', 'diff-check'], cfg['commandVectors']['validation'])]
else:
    receipt['suiteCommands'] = [
        {'command': 'node', 'argv': cfg['commandVectors']['node'], 'status': 'UNREACHED'},
        {'command': 'renderer', 'argv': cfg['commandVectors']['rendererRed' if phase == 'red' else 'rendererGreen'], 'status': 'UNREACHED'}]
receipt_path = OUT / 'phase-receipt.json'
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
metadata_counter = 0
phase_signals = []
cleaning = finalizing = launching = False
previous_handlers = {sig: signal.signal(sig, interrupt) for sig in [signal.SIGINT, signal.SIGTERM]}
invocation_start = time.monotonic()
before = after = primary = None
primaries = []
primary_invocations = []
receipt['primaryInvocations'] = primary_invocations
active_source_vector = None
expected_command_outcome = False
node_debt_gate_passed = False
vite_owner = None
vite_path = REPO / 'node_modules/.vite-temp'
boundary = 'before'
snapshot = input_snapshot if runtime_inputs else source_metadata_snapshot
try:
    preflight_start = time.monotonic()
    overlays = cfg['beforeSourceOverlay'] if action == 'materialize' else cfg['sourceOverlay']
    if runtime_inputs:
        receipt['fullRuntimeInputBoundaries']['before'] = 'STARTED'
    before = snapshot(overlays)
    assert before['taskTmpTopEntries'] == [], 'phase TMPDIR was not empty'
    if runtime_inputs:
        receipt['fullRuntimeInputBoundaries']['before'] = 'COMPLETE'
    receipt['before'] = before
    receipt['preflightSeconds'] = time.monotonic() - preflight_start
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    if action == 'materialize':
        receipt['writtenPaths'] = []
        for path in written_paths:
            assert not phase_signals
            row = next(x for x in cfg['sourceOverlay'] if x['path'] == path)
            previous = next(x for x in cfg['beforeSourceOverlay'] if x['path'] == path)
            target = REPO / path
            assert target.is_file() and not target.is_symlink() and same_identity(target.read_bytes(), previous)
            target.write_bytes(row['content'].encode())
            assert same_identity(target.read_bytes(), row)
            receipt['writtenPaths'].append(path)
        expected_command_outcome = True
    elif command == 'validation-package':
        package_start = time.monotonic()
        try:
            for entry in receipt['validationCommands']:
                assert not phase_signals, 'supervisor interruption before next validation child'
                command_start = time.monotonic()
                entry['status'] = 'STARTED'
                stage = {'id': prefix + '-' + entry['command'], 'cwd': str(REPO)}
                invocation_offset = len(primary_invocations)
                try:
                    pointer, primary = run_child(stage, 1, entry['argv'], command_start + 180)
                    primaries.append(primary)
                    entry.update({'status': 'EXECUTED', 'primaryReceipt': pointer, 'record': primary})
                finally:
                    entry['commandPhaseSeconds'] = time.monotonic() - command_start
                    entry['cleanupSeconds'] = primary_cleanup_seconds(primary_invocations[invocation_offset:])
                    entry['invocationRecords'] = primary_invocations[invocation_offset:]
                assert same_identity(pathlib.Path(pointer['path']).read_bytes(), pointer)
                assert primary.get('raw') and same_identity(pathlib.Path(primary['raw']['path']).read_bytes(), primary['raw'])
                assert ordinary_completion(primary) and primary['successful'] and primary['exitCode'] == 0
                assert primary['remainingCapturedSession'] == [] and not phase_signals
                assert list(TASK_TMP.iterdir()) == [], 'validation temporary debt'
                assert time.monotonic() < command_start + 180 and not phase_signals, 'semantic/final admission exceeded original command clock'
                entry['commandPhaseSeconds'] = time.monotonic() - command_start
                entry['status'] = 'ACCEPTED'
                entry['nextCommandAdmitted'] = True
            receipt['commandCompletedNormally'] = True
            receipt['semanticAdmissionComplete'] = True
            expected_command_outcome = True
        finally:
            receipt['commandPhaseSeconds'] = time.monotonic() - package_start
            receipt['cleanupSeconds'] = primary_cleanup_seconds(primary_invocations)
            if primary:
                for key in ['exitCode', 'exitSignal', 'timedOut']:
                    receipt[key] = primary[key]
    else:
        package_start = time.monotonic()
        try:
            for entry in receipt['suiteCommands']:
                assert not phase_signals, 'supervisor interruption before next suite'
                if entry['command'] == 'renderer':
                    assert node_debt_gate_passed, 'Node no-debt gate incomplete'
                    assert all(row['finalReceiptPersisted'] and row['capturedPid'] is not None
                               and group_members(row['capturedPid']) == [] for row in primary_invocations)
                    assert list(TASK_TMP.iterdir()) == [], 'debt appeared before renderer'
                    for row in cfg['sourceOverlay']:
                        assert file_row(REPO / row['path'], row['path']) == {
                            key: row[key] for key in ['path', 'mode', 'bytes', 'sha256', 'gitBlob']}
                    receipt['nativeRouteAdmission'] = native_route_gate()
                    assert not phase_signals and not os.path.lexists(vite_path)
                    assert not os.path.lexists(REPO / 'node_modules/.vite')
                    vite_path.mkdir(mode=0o700, exist_ok=False)
                    vite_owner = directory_owner(vite_path)
                    assert vite_owner['mode'] == 0o700 and list(vite_path.iterdir()) == []
                    receipt['viteTempOwner'] = vite_owner
                    write_new(prefix + '-renderer-output-ownership.json', {
                        'viteTempOwner': vite_owner, 'taskTmpOwner': task_tmp_owner,
                        'nodeTmpGate': receipt['nodeTmpGate'], 'capturedNodeSessionEmpty': True})
                command_start = time.monotonic()
                entry['status'] = 'STARTED'
                stage = {'id': prefix + '-' + entry['command'], 'cwd': str(REPO)}
                invocation_offset = len(primary_invocations)
                try:
                    pointer, primary = run_child(stage, 1, entry['argv'], command_start + 180)
                    primaries.append(primary)
                    entry.update({'status': 'EXECUTED', 'primaryReceipt': pointer, 'record': primary})
                finally:
                    entry['commandPhaseSeconds'] = time.monotonic() - command_start
                    entry['cleanupSeconds'] = primary_cleanup_seconds(primary_invocations[invocation_offset:])
                    entry['invocationRecords'] = primary_invocations[invocation_offset:]
                assert same_identity(pathlib.Path(pointer['path']).read_bytes(), pointer)
                assert primary.get('raw') and same_identity(pathlib.Path(primary['raw']['path']).read_bytes(), primary['raw'])
                assert ordinary_completion(primary) and primary['exitCode'] == (1 if phase == 'red' else 0)
                assert primary['remainingCapturedSession'] == [] and not phase_signals
                if entry['command'] == 'node':
                    entry['semanticReceipt'] = node_semantics(primary)
                    receipt['nodeTmpGate'] = node_tmp_gate()
                    node_debt_gate_passed = True
                else:
                    entry['semanticReceipt'] = renderer_semantics(primary)
                assert time.monotonic() < command_start + 180 and not phase_signals, 'semantic/final admission exceeded original command clock'
                entry['commandPhaseSeconds'] = time.monotonic() - command_start
                entry['status'] = 'ACCEPTED'
                entry['nextCommandAdmitted'] = True
                receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
            receipt['commandCompletedNormally'] = True
            receipt['semanticAdmissionComplete'] = True
            expected_command_outcome = True
        finally:
            receipt['commandPhaseSeconds'] = time.monotonic() - package_start
            receipt['cleanupSeconds'] = primary_cleanup_seconds(primary_invocations)
            if primary:
                for key in ['exitCode', 'exitSignal', 'timedOut']:
                    receipt[key] = primary[key]
except BaseException as error:
    receipt['executionError'] = type(error).__name__ + ': ' + str(error)
    if 'preflightSeconds' not in receipt:
        receipt['preflightSeconds'] = time.monotonic() - preflight_start
finally:
    finalizing = True
    transient_started = time.monotonic()
    try:
        if vite_owner is not None:
            assert node_debt_gate_passed, 'renderer cleanup cannot erase Node debt'
            assert all(not row['spawnAttempted'] or row['capturedPid'] is not None for row in primary_invocations), 'unknown primary launch; transients retained'
            assert all(group_members(row['capturedPid']) == [] for row in primary_invocations if row['capturedPid']), 'live captured group; transients retained'
            renderer_trackers = [row for row in primary_invocations if row['id'] == prefix + '-renderer-1']
            assert len(renderer_trackers) <= 1
            if renderer_trackers and renderer_trackers[0]['spawnAttempted']:
                tracker = renderer_trackers[0]
                record = tracker['record']
                assert tracker['finalReceiptPersisted'] and not record.get('finalizationError'), 'incomplete renderer finalization; transients retained'
                assert record['exitCode'] is not None or record['exitSignal'] is not None
                assert same_identity(pathlib.Path(tracker['finalReceipt']['path']).read_bytes(), tracker['finalReceipt'])
                assert record.get('raw') and same_identity(pathlib.Path(record['raw']['path']).read_bytes(), record['raw'])
                assert record['remainingCapturedSession'] == []
            else:
                assert list(vite_path.iterdir()) == [] and list(TASK_TMP.iterdir()) == [], 'unreached renderer acquired output; retained'
            receipt['rendererTransientCleanup'] = {
                'vite': capture_and_remove_owned(vite_path, vite_owner, 'vite-config'),
                'tmp': capture_and_remove_owned(TASK_TMP, task_tmp_owner, 'renderer-tmp')}
    except BaseException as error:
        receipt['transientCleanupError'] = type(error).__name__ + ': ' + str(error)
    finally:
        receipt['transientCaptureAndCleanupSeconds'] = time.monotonic() - transient_started
    postflight_start = time.monotonic()
    try:
        boundary = 'after'
        if runtime_inputs:
            receipt['fullRuntimeInputBoundaries']['after'] = 'STARTED'
        after = snapshot(cfg['sourceOverlay'])
        if runtime_inputs:
            receipt['fullRuntimeInputBoundaries']['after'] = 'COMPLETE'
        receipt['after'] = after
        metadata_preserved = bool(before and all(before[key] == after[key] for key in ['tools', 'pnpm', 'environment', 'controls']))
        receipt['sourceAndSupervisorMetadataPreserved'] = metadata_preserved
        if runtime_inputs:
            receipt['inputsPreserved'] = bool(before and preserved(before, after))
            receipt['fullRuntimeInputsPreserved'] = receipt['inputsPreserved']
        unknown = [row['id'] for row in primary_invocations if row['spawnAttempted'] and row['capturedPid'] is None]
        receipt['cleanup'] = {
            'unknownPrimaryLaunches': unknown,
            'capturedSessionMembersAfter': None if unknown else [
                member for row in primary_invocations if row.get('capturedPid') for member in group_members(row['capturedPid'])],
            'newTestTempsRemaining': [x for x in after['testTemps'] if before and x not in before['testTemps']],
            'taskTmpEntriesAfter': after['taskTmpTopEntries'],
            'viteTempAbsent': not os.path.lexists(vite_path),
            'nodeDebtGatePassed': node_debt_gate_passed if command in ['red', 'green'] and runtime_inputs else None,
            'scope': 'Captured primary sessions/groups and exact owned phase outputs; metadata sessions checked individually. No universal escaped-child/native custody claim.'}
        same_directory(TASK_TMP, task_tmp_owner)
    except BaseException as error:
        receipt['postflightError'] = type(error).__name__ + ': ' + str(error)
        if runtime_inputs:
            receipt['inputsPreserved'] = receipt['fullRuntimeInputsPreserved'] = False
        receipt['sourceAndSupervisorMetadataPreserved'] = False

    finally:
        managed_signals = set(previous_handlers)
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, managed_signals)
        try:
            pending_signals = sorted(int(sig) for sig in signal.sigpending() & managed_signals)
            receipt['signalAdmissionCutoff'] = {
                'at': utc(), 'pendingSignals': pending_signals, 'supervisorExitZeroRequired': True,
                'scope': 'Managed-signal pending snapshot while blocked; later signals require separate observed outer-exit admission.'}
            receipt['postflightSeconds'] = time.monotonic() - postflight_start
            receipt['finishedAt'] = utc()
            receipt['totalInvocationSeconds'] = time.monotonic() - invocation_start
            receipt['interruptions'] = [*phase_signals, *pending_signals]
            receipt['metadataCommands'] = metadata_counter
            receipt['fullRuntimeInputsInspected'] = runtime_inputs and all(
                value == 'COMPLETE' for value in receipt['fullRuntimeInputBoundaries'].values())
            receipt['primaryUnreached'] = runtime_inputs and not primary_invocations
            receipt['primaryFinalizationComplete'] = all(row['finalReceiptPersisted'] for row in primary_invocations)
            receipt['primaryInvocationsWithoutFinalReceipt'] = [
                row['id'] for row in primary_invocations if not row['finalReceiptPersisted']]
            entries = receipt.get('suiteCommands', receipt.get('validationCommands', []))
            receipt['unreachedCommands'] = [x['command'] for x in entries if x['status'] == 'UNREACHED']
            receipt['unacceptedCommands'] = [x['command'] for x in entries if x['status'] != 'ACCEPTED']
            selected_inputs_preserved = receipt['inputsPreserved'] if runtime_inputs else receipt['sourceAndSupervisorMetadataPreserved']
            receipt['scopeCompleted'] = bool(
                selected_inputs_preserved and expected_command_outcome
                and (not runtime_inputs or receipt['fullRuntimeInputsInspected'])
                and (not runtime_inputs or receipt['semanticAdmissionComplete'])
                and receipt['primaryFinalizationComplete']
                and not receipt.get('executionError') and not receipt.get('postflightError')
                and not receipt.get('transientCleanupError') and not receipt['interruptions']
                and not receipt['unacceptedCommands']
                and receipt.get('cleanup', {}).get('unknownPrimaryLaunches') == []
                and receipt.get('cleanup', {}).get('capturedSessionMembersAfter') == []
                and receipt.get('cleanup', {}).get('newTestTempsRemaining') == []
                and receipt.get('cleanup', {}).get('taskTmpEntriesAfter') == []
                and receipt.get('cleanup', {}).get('viteTempAbsent') is True)
            receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
        finally:
            for sig, previous in previous_handlers.items():
                signal.signal(sig, previous)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
printed_keys = ['command', 'action', 'phase', 'exitCode', 'exitSignal', 'timedOut',
                'executionError', 'postflightError', 'transientCleanupError',
                'inputsPreserved', 'fullRuntimeInputsInspected', 'fullRuntimeInputsPreserved',
                'sourceAndSupervisorMetadataPreserved', 'commandCompletedNormally',
                'semanticAdmissionComplete', 'scopeCompleted', 'preflightSeconds',
                'commandPhaseSeconds', 'cleanupSeconds', 'transientCaptureAndCleanupSeconds',
                'postflightSeconds', 'totalInvocationSeconds', 'unreachedCommands',
                'unacceptedCommands', 'cleanup', 'signalAdmissionCutoff']
summary = {key: receipt.get(key) for key in printed_keys}
summary['primarySummaries'] = [
    {key: row.get(key) for key in ['command', 'status', 'primaryReceipt', 'semanticReceipt']}
    for row in receipt.get('suiteCommands', receipt.get('validationCommands', []))]
summary['finalReceipt'] = regular_pointer(receipt_path)
print(json.dumps(summary), flush=True)
sys.exit(0 if receipt['scopeCompleted'] and not phase_signals else 2)
