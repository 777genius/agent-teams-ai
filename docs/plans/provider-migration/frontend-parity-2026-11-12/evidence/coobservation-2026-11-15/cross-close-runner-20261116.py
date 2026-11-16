import datetime
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
OUT = pathlib.Path('/tmp/c714-cross-close-evidence')
TASK_TMP = OUT / 'test-tmp'
SOURCE_COMMIT = 'c5ff4fc283e58d486c58147b4dfb00144ca10d34'
SOURCE_TREE = '3239e6e6c8182f3d8e45ee671efc9108500b5137'
R1 = 'a4f5c2d2a05edd636ea0ff461c00615a2ff60d86'
R1_BLOB = '8abe2a1437489d5c0223d532535d6c520fd70184'
WORKSPACES = ['', 'agent-teams-controller', 'mcp-server', 'landing',
              'packages/agent-graph', 'packages/legacy-agent-host', 'packages/task-change-ledger']
BASE_PATHS = ['scripts/legacy-agent-host/desktop-ui-controls.ts',
              'scripts/legacy-agent-host/desktop-emulated-selection-ui.ts']
PATHS = ['scripts/legacy-agent-host/desktop-task-comment-input-target.ts',
         'scripts/legacy-agent-host/desktop-task-board-ui-smoke.ts',
         'scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts']
OVERLAY_PATHS = [*BASE_PATHS, *PATHS]
TEST_IDENTITY = {'bytes': 155423, 'sha256': 'b1b6573cf17971fc479135b8aa7dbc4e8705206ba85818bcdc97c7d8539ba409',
                 'gitBlob': '0aec698e88cc3af8d12c48f6d93b038efcc84900'}
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
    return {'capturedTransportCanonicalSha256': hashlib.sha256(canonical(captured_transport)).hexdigest(),
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

def directory_manifest(roots):
    rows = []
    for base in roots:
        if not base.exists():
            continue
        assert base.is_dir() and not base.is_symlink(), 'unexpected root link: ' + str(base)
        for folder, directories, files in os.walk(base, followlinks=False):
            for name in sorted(directories + files):
                path = pathlib.Path(folder) / name
                info = path.lstat()
                if stat.S_ISDIR(info.st_mode):
                    continue
                relative = path.relative_to(REPO).as_posix()
                row = file_row(path, relative)
                if stat.S_ISLNK(info.st_mode):
                    assert path.resolve().is_relative_to(REPO), 'dependency link escapes source'
                    row['target'] = os.readlink(path)
                rows.append(row)
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
              'exitCode': None, 'exitSignal': None, 'capturedPid': None, 'metadataOnly': metadata}
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
        before[key] == after[key] for key in ['providers', 'tools', 'pnpm', 'environment', 'bootstrapCache', 'controls'])


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
binding_path, binding_sha, action, command = sys.argv[1:]
binding_bytes = pathlib.Path(binding_path).read_bytes()
assert hashlib.sha256(binding_bytes).hexdigest() == binding_sha
cfg = json.loads(binding_bytes)
assert pathlib.Path(__file__).resolve() == pathlib.Path(cfg['runnerLocalPath'])
assert pathlib.Path(binding_path).resolve() == pathlib.Path(cfg['bindingLocalPath'])
assert identity(pathlib.Path(__file__).read_bytes()) == cfg['runnerIdentity']
assert cfg['publishedR1'] == R1 and cfg['phase'] in ['red', 'green']
assert identity(cfg['crossR1Body'].encode()) == cfg['crossR1Identity']
assert cfg['crossR1Identity']['gitBlob'] == R1_BLOB
cross_r1 = json.loads(cfg['crossR1Body'])
assert cfg['actualPublishedSubjectReadbackAccepted'] and cfg['combinedInputImportAdmission']['accepted']
assert cfg['combinedInputImportAdmission']['sourceCommit'] == SOURCE_COMMIT
assert command in (['red'] if cfg['phase'] == 'red' else ['green', 'validation-package'])
assert action in ['run', 'materialize']
assert action != 'materialize' or command == cfg['phase']
assert set(cfg['inputFiles']) == set(INPUT_PATHS)
assert ROOT.is_dir() and not ROOT.is_symlink() and REPO.is_dir() and not REPO.is_symlink()
for name in ['toolchain', 'bin', 'evidence', 'tmp', 'store', 'cache', 'state', 'config', 'data']:
    assert (ROOT / name).is_dir() and not (ROOT / name).is_symlink(), name + ' root alias'
control_pins = [(pathlib.Path(__file__), cfg['runnerIdentity']),
                (pathlib.Path(binding_path), identity(binding_bytes))]
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
for review in cfg['acceptedReviewBodies']:
    assert identity(review['body'].encode()) == review['identity']
assert len(inputs['sourceFull']['rows']) == 11567 and len(inputs['sourceNonDoc']['rows']) == 8798
assert len(inputs['dependencies']) == 122773 and len(inputs['compiled']) == 1454
assert inputs['sourceFull']['head'] == inputs['sourceNonDoc']['head'] == SOURCE_COMMIT
assert inputs['sourceFull']['tree'] == inputs['sourceNonDoc']['tree'] == SOURCE_TREE
expected_before = BASE_PATHS if cfg['phase'] == 'red' else [*BASE_PATHS, PATHS[2]]
expected_after = [*BASE_PATHS, PATHS[2]] if cfg['phase'] == 'red' else OVERLAY_PATHS
assert sorted(x['path'] for x in cfg['beforeSourceOverlay']) == sorted(expected_before)
assert sorted(x['path'] for x in cfg['sourceOverlay']) == sorted(expected_after)
for overlays in [cfg['beforeSourceOverlay'], cfg['sourceOverlay']]:
    for pin in cross_r1['preservedBaseline']['currentTwoOverlays']:
        row = next(x for x in overlays if x['path'] == pin['path'])
        assert {key: row[key] for key in pin} == pin, 'previous conversation producer changed'
    for row in overlays:
        assert row['mode'] == '100644'
        assert identity(row['content'].encode()) == {key: row[key] for key in ['bytes', 'sha256', 'gitBlob']}
        if row['path'] == PATHS[2]:
            assert identity(row['content'].encode()) == TEST_IDENTITY
        elif row['path'] in PATHS[:2]:
            cap = 200 if row['path'] == PATHS[0] else 800
            assert len(row['content'].splitlines()) <= cap
base_source = {row['path']: row for row in inputs['sourceNonDoc']['rows']}
expected_source = dict(base_source)
for row in cfg['sourceOverlay']:
    expected_source[row['path']] = {key: row[key] for key in ['path', 'mode', 'bytes', 'sha256', 'gitBlob']}
assert cfg['sourcePins'] == [expected_source[path] for path in sorted(OVERLAY_PATHS)]
assert cfg['reviewedTestCensus']['wholeRuntimeCases'] == 133
assert cfg['reviewedTestCensus']['wholeTest'] == TEST_IDENTITY
written_paths = [PATHS[2]] if cfg['phase'] == 'red' else PATHS[:2]
assert cfg['materializePaths'] == written_paths
before_source = dict(base_source)
for row in cfg['beforeSourceOverlay']:
    before_source[row['path']] = {key: row[key] for key in ['path', 'mode', 'bytes', 'sha256', 'gitBlob']}
assert sorted(path for path in expected_source if expected_source[path] != before_source[path]) == sorted(written_paths)
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
PNPM = [NODE, r1['tools']['pnpm']['executable'], '--config.pm-on-fail=error',
        '--config.verify-deps-before-run=false', '--config.engine-strict=true']
COMMANDS = {'red': [NODE, '--test', PATHS[2]], 'green': [NODE, '--test', PATHS[2]],
            'lint': [*PNPM, 'lint:fast:files', *PATHS],
            'source-size': [*PNPM, 'guard:source-file-size'],
            'diff-check': [r1['tools']['git']['path'], 'diff', '--check', '--', *OVERLAY_PATHS]}
assert cfg['commandVectors'] == COMMANDS
assert cfg['executionScope']['requiresObservedSupervisorExitZeroForContinuation'] is True
owner = {'kind': 'c714-cross-close-evidence', 'base': SOURCE_COMMIT, 'publishedR1': R1,
         'runner': cfg['runnerIdentity'], 'test': TEST_IDENTITY}
if action == 'materialize' and cfg['phase'] == 'red':
    OUT.mkdir(mode=0o700, exist_ok=False)
    write_new('owner.json', owner)
else:
    assert OUT.is_dir() and not OUT.is_symlink()
    assert json.loads((OUT / 'owner.json').read_text()) == owner
if cfg['phase'] == 'green':
    red_pin = cfg['acceptedSemanticRed']
    assert red_pin['independentReviewAccepted'] is True and red_pin['observedOuterSupervisorExit'] == 0
    red_bytes = (OUT / 'red-receipt.json').read_bytes()
    assert identity(red_bytes) == red_pin['identity']
    red = json.loads(red_bytes)
    assert red['command'] == 'red' and red['exitCode'] == 1 and red['inputsPreserved']
    assert red['fullRuntimeInputsInspected'] and red['fullRuntimeInputsPreserved']
    assert red['commandCompletedNormally'] and red['cleanup']['newTestTempsRemaining'] == []
    assert red['scopeCompleted'] is True and red['interruptions'] == []
    assert red['cleanup']['capturedSessionMembersAfter'] == []
    assert not red.get('executionError') and not red.get('postflightError')
    assert red['testIdentity'] == TEST_IDENTITY
if action == 'run' and command in ['red', 'green']:
    materialized = json.loads((OUT / ('materialize-' + command + '-receipt.json')).read_text())
    assert materialized['action'] == 'materialize' and materialized['command'] == command
    assert materialized['bindingIdentity'] == identity(binding_bytes)
    assert materialized['publishedSubject'] == cfg['publishedSubject']
    assert materialized['scopeCompleted'] and materialized['sourceAndSupervisorMetadataPreserved']
    assert materialized['fullRuntimeInputsInspected'] is False
    assert materialized['fullRuntimeInputsPreserved'] is None and materialized['inputsPreserved'] is None
    assert materialized['writtenPaths'] == written_paths and materialized['interruptions'] == []
    assert materialized['cleanup']['capturedSessionMembersAfter'] == []
    assert materialized['cleanup']['newTestTempsRemaining'] == []
    assert not materialized.get('executionError') and not materialized.get('postflightError')
if command == 'validation-package':
    green = json.loads((OUT / 'green-receipt.json').read_text())
    assert green['command'] == 'green' and green['exitCode'] == 0 and green['inputsPreserved']
    assert green['fullRuntimeInputsInspected'] and green['fullRuntimeInputsPreserved']
    assert green['commandCompletedNormally'] and green['cleanup']['newTestTempsRemaining'] == []
    assert green['scopeCompleted'] is True and green['interruptions'] == []
    assert green['cleanup']['capturedSessionMembersAfter'] == []
    assert green['publishedSubject'] == cfg['publishedSubject'] and green['bindingIdentity'] == identity(binding_bytes)
    assert not green.get('executionError') and not green.get('postflightError')
assert OUT.is_dir() and not OUT.is_symlink()
TASK_TMP.mkdir(mode=0o700, exist_ok=True)
assert TASK_TMP.is_dir() and not TASK_TMP.is_symlink()
assert shutil.disk_usage(REPO).free >= 8 * 1024 * 1024 and shutil.disk_usage(OUT).free >= 64 * 1024 * 1024
prefix = command if action == 'run' else 'materialize-' + cfg['phase']
with (OUT / (prefix + '.attempt')).open('x') as handle:
    handle.write(utc() + '\n')
runtime_inputs = action == 'run'
receipt = {'kind': 'cross-close-test-first-bounded-invocation', 'command': command,
           'action': action, 'attempt': 1, 'startedAt': utc(), 'publishedR1': R1,
           'publishedSubject': cfg['publishedSubject'], 'actualLocalHead': SOURCE_COMMIT,
           'runnerIdentity': cfg['runnerIdentity'], 'bindingIdentity': identity(binding_bytes),
           'testIdentity': TEST_IDENTITY, 'sourcePins': cfg['sourcePins'],
           'argv': COMMANDS.get(command) if action == 'run' else None, 'cwd': str(REPO),
           'perPrimaryCommandLimitSeconds': 180, 'metadataCommandLimitSeconds': 30,
           'fullRuntimeInputsRequested': runtime_inputs, 'fullRuntimeInputsInspected': False,
           'fullRuntimeInputBoundaries': {key: 'UNREACHED' if runtime_inputs else 'UNINSPECTED' for key in ['before', 'after']},
           'fullRuntimeInputsPreserved': False if runtime_inputs else None,
           'inputsPreserved': False if runtime_inputs else None, 'sourceAndSupervisorMetadataPreserved': False,
           'commandCompletedNormally': False, 'exitCode': None, 'exitSignal': None, 'timedOut': False,
           'cleanupSeconds': 0, 'commandPhaseSeconds': 0,
           'cleanupTimeAccounting': 'Captured termination/reap time is a subset of each commandPhaseSeconds.',
           'snapshotScope': 'whole invocation; validation children share one full preflight and postflight' if runtime_inputs else 'source-and-supervisor-metadata-only',
           'qualification': 'Finite actual-source cases/scoped guards only. Metadata materialization is not a behavioral or all-input result. No GUI/native/vendor or whole-E2E claim.'}
if not runtime_inputs:
    receipt['uninspectedRuntimeInputs'] = {key: 'UNINSPECTED' for key in
        ['dependencies', 'compiled', 'providerArchivesAndInstalledMembers', 'bootstrapNodeCache']}
if command == 'validation-package':
    receipt['validationCommands'] = [{'command': name, 'argv': COMMANDS[name], 'status': 'UNREACHED'}
                                     for name in ['lint', 'source-size', 'diff-check']]
receipt_path = OUT / (prefix + '-receipt.json')
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
expected_command_outcome = False
boundary = 'before'
snapshot = input_snapshot if runtime_inputs else source_metadata_snapshot
try:
    preflight_start = time.monotonic()
    overlays = cfg['beforeSourceOverlay'] if action == 'materialize' else cfg['sourceOverlay']
    if runtime_inputs:
        receipt['fullRuntimeInputBoundaries']['before'] = 'STARTED'
    before = snapshot(overlays)
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
            (REPO / path).write_bytes(row['content'].encode())
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
                assert identity(pathlib.Path(pointer['path']).read_bytes()) == {key: pointer[key] for key in ['bytes', 'sha256', 'gitBlob']}
                assert primary.get('raw')
                assert identity(pathlib.Path(primary['raw']['path']).read_bytes()) == {key: primary['raw'][key] for key in ['bytes', 'sha256', 'gitBlob']}
                assert ordinary_completion(primary) and primary['successful'] and primary['exitCode'] == 0
                assert primary['remainingCapturedSession'] == [] and not phase_signals
                entry['nextCommandAdmitted'] = True
            receipt['commandCompletedNormally'] = True
            expected_command_outcome = True
        finally:
            receipt['commandPhaseSeconds'] = time.monotonic() - package_start
            receipt['cleanupSeconds'] = primary_cleanup_seconds(primary_invocations)
            if primary:
                for key in ['exitCode', 'exitSignal', 'timedOut']:
                    receipt[key] = primary[key]
    else:
        command_start = time.monotonic()
        stage = {'id': prefix + '-command', 'cwd': str(REPO)}
        try:
            pointer, primary = run_child(stage, 1, COMMANDS[command], command_start + 180)
            primaries.append(primary)
            receipt['primaryReceipt'] = pointer
            for key in ['exitCode', 'exitSignal', 'timedOut']:
                receipt[key] = primary[key]
            receipt['commandCompletedNormally'] = ordinary_completion(primary)
            receipt['rawCombinedOutput'] = primary.get('raw')
            expected_command_outcome = receipt['commandCompletedNormally'] and primary['exitCode'] == (1 if command == 'red' else 0)
        finally:
            receipt['commandPhaseSeconds'] = time.monotonic() - command_start
            receipt['cleanupSeconds'] = primary_cleanup_seconds(primary_invocations)
except BaseException as error:
    receipt['executionError'] = type(error).__name__ + ': ' + str(error)
    if 'preflightSeconds' not in receipt:
        receipt['preflightSeconds'] = time.monotonic() - preflight_start
finally:
    finalizing = True
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
        unknown_launches = [row['id'] for row in primary_invocations if row['spawnAttempted'] and row['capturedPid'] is None]
        receipt['cleanup'] = {'unknownPrimaryLaunches': unknown_launches,
                              'capturedSessionMembersAfter': None if unknown_launches else [member for row in primary_invocations if row.get('capturedPid')
                                                              for member in group_members(row['capturedPid'])],
                              'newTestTempsRemaining': [x for x in after['testTemps'] if before and x not in before['testTemps']],
                              'scope': 'All captured primary sessions/groups and TEST-prefixed task temps; metadata sessions are checked individually. No universal escaped-child/native custody proof.'}
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
                'scope': 'Managed-signal pending snapshot while blocked; later signals are outside this receipt and require separate outer-exit admission.'}
            receipt['postflightSeconds'] = time.monotonic() - postflight_start
            receipt['finishedAt'] = utc()
            receipt['totalInvocationSeconds'] = time.monotonic() - invocation_start
            receipt['interruptions'] = [*phase_signals, *pending_signals]
            receipt['metadataCommands'] = metadata_counter
            receipt['fullRuntimeInputsInspected'] = runtime_inputs and all(
                value == 'COMPLETE' for value in receipt['fullRuntimeInputBoundaries'].values())
            receipt['primaryUnreached'] = action == 'run' and not primary_invocations
            receipt['primaryFinalizationComplete'] = all(row['finalReceiptPersisted'] for row in primary_invocations)
            receipt['primaryInvocationsWithoutFinalReceipt'] = [row['id'] for row in primary_invocations
                                                               if not row['finalReceiptPersisted']]
            receipt['unreachedValidationCommands'] = [x['command'] for x in receipt.get('validationCommands', [])
                                                       if x['status'] == 'UNREACHED']
            selected_inputs_preserved = receipt['inputsPreserved'] if runtime_inputs else receipt['sourceAndSupervisorMetadataPreserved']
            receipt['scopeCompleted'] = bool(selected_inputs_preserved and expected_command_outcome
                                             and (not runtime_inputs or receipt['fullRuntimeInputsInspected'])
                                             and receipt['primaryFinalizationComplete']
                                             and not receipt.get('executionError') and not receipt.get('postflightError')
                                             and not receipt['interruptions'] and not receipt['unreachedValidationCommands']
                                             and receipt.get('cleanup', {}).get('newTestTempsRemaining') == []
                                             and receipt.get('cleanup', {}).get('capturedSessionMembersAfter') == [])
            receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
        finally:
            for sig, previous in previous_handlers.items():
                signal.signal(sig, previous)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
print(json.dumps({key: receipt.get(key) for key in ['command', 'action', 'exitCode', 'exitSignal',
      'timedOut', 'executionError', 'postflightError', 'inputsPreserved', 'fullRuntimeInputsInspected',
      'fullRuntimeInputsPreserved', 'sourceAndSupervisorMetadataPreserved', 'commandCompletedNormally',
      'scopeCompleted', 'preflightSeconds', 'commandPhaseSeconds', 'cleanupSeconds', 'postflightSeconds',
      'totalInvocationSeconds', 'unreachedValidationCommands', 'rawCombinedOutput', 'cleanup', 'signalAdmissionCutoff']}), flush=True)
sys.exit(0 if receipt['scopeCompleted'] and not phase_signals else 2)
