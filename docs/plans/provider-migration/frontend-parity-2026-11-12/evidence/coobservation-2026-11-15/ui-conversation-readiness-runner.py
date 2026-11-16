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

REPO = pathlib.Path('/workspace/scratch/c714f5bce554/agent-teams-reconciled-local')
OUT = pathlib.Path('/tmp/c714-ui-conversation-evidence')
TASK_TMP = OUT / 'test-tmp'
NODE = '/workspace/scratch/82d3f9ba6b85/toolchain/node24/bin/node'
LOCAL_HEAD = '47d9f29602bae778f20ae8cc133ca332e458e59a'
R1 = 'f3fb3ead0315508901531e8f54b75f21518492a7'
FRESH_INPUT = {'bytes': 2873822,
               'sha256': 'a6bc697e55d93b994391fed2ae4434ae50bd7163cd499d045ffeeeb74edf911b',
               'gitBlob': 'eab37daec1b7cc8e979d023b037de9b9e41ccf08'}
INPUT_SHA = '69d471b52e0592b84e7b47c46e93dcc4a4b1a007e80c632cb11f9eee290dbb5e'
PATHS = ['scripts/legacy-agent-host/desktop-ui-controls.ts',
         'scripts/legacy-agent-host/desktop-emulated-selection-ui.ts',
         'scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts']
TEST_ARGV = [NODE, '--test', PATHS[2]]
COMMANDS = {'red': TEST_ARGV, 'green': TEST_ARGV,
            'lint': ['pnpm', 'lint:fast:files', *PATHS],
            'source-size': ['pnpm', 'guard:source-file-size'],
            'diff-check': ['git', 'diff', '--check', '--', *PATHS]}
UNSET = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'GOMAXPROCS', 'GOMEMLIMIT',
         'ELECTRON_RUN_AS_NODE', 'LEGACY_PROCESS_COLD_UI_GO', 'LEGACY_M19_PROVIDER_UI_GO',
         'LEGACY_M19_ORIGINAL_HOST_CRASH_GO']


def identity(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'gitBlob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO)


def read_row(relative):
    path = REPO / relative
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        data, mode = os.readlink(path).encode(), '120000'
    else:
        assert stat.S_ISREG(info.st_mode), relative
        data, mode = path.read_bytes(), '100755' if info.st_mode & stat.S_IXUSR else '100644'
    return {'path': relative, 'mode': mode, **identity(data)}


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


def temp_rows():
    rows = []
    for path in pathlib.Path(tempfile.gettempdir()).iterdir():
        if path.name.startswith('TEST-'):
            info = path.lstat()
            rows.append({'name': path.name, 'device': info.st_dev, 'inode': info.st_ino,
                         'mode': stat.S_IFMT(info.st_mode)})
    return sorted(rows, key=lambda row: row['name'])


def source_snapshot(overlays):
    assert git('rev-parse', 'HEAD').decode().strip() == LOCAL_HEAD
    base = {row['path']: row for row in inventory['trackedNonDocRows']}
    expected = {**base, **{row['path']: {key: row[key] for key in ['path', 'mode', 'gitBlob', 'bytes', 'sha256']}
                          for row in overlays}}
    assert len(base) == len(expected) == 8798
    assert len({row['path'] for row in overlays}) == len(overlays)
    index = {}
    for raw in git('ls-files', '--stage', '-z').split(b'\0'):
        if not raw:
            continue
        metadata, path = raw.split(b'\t', 1)
        mode, blob, stage = metadata.decode().split()
        assert stage == '0'
        name = path.decode()
        if not name.startswith('docs/'):
            index[name] = {'mode': mode, 'gitBlob': blob}
    assert set(index) == set(base)
    assert all(index[path] == {key: row[key] for key in ['mode', 'gitBlob']} for path, row in base.items())
    assert git('diff', '--cached', '--name-only', '-z') == b'', 'no staged changes'
    assert git('ls-files', '--others', '--exclude-standard', '-z') == b'', 'no unrelated untracked work'
    changed = {row['path'] for row in overlays if row['gitBlob'] != base[row['path']]['gitBlob']}
    actual_changed = {p.decode() for p in git('diff', '--name-only', '-z', 'HEAD').split(b'\0') if p}
    assert actual_changed == changed, sorted(actual_changed ^ changed)
    rows = [read_row(path) for path in sorted(expected)]
    for row in rows:
        assert row == expected[row['path']], 'source differs: ' + row['path']
    return {'actualLocalHead': LOCAL_HEAD, 'documentaryCheckout': LOCAL_HEAD,
            'publishedExecutableSource': cfg['publishedSubject'], 'rows': rows,
            'changedTrackedPaths': sorted(changed), 'status': git('status', '--porcelain').decode()}


def dependency_snapshot():
    compiled = []
    for root in inventory['compiledRoots']:
        for path in sorted((REPO / root).rglob('*')):
            assert not path.is_symlink(), 'unexpected compiled symlink: ' + str(path)
            if path.is_file():
                data = path.read_bytes()
                compiled.append({'path': path.relative_to(REPO).as_posix(),
                                 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    assert sorted(compiled, key=lambda row: row['path']) == sorted(inventory['compiledRows'], key=lambda row: row['path'])
    assert len(compiled) == 1504
    installed = []
    for pin in inventory['currentInstalledProviderVerification']:
        archive = REPO / pin['archive']
        archive_id = identity(archive.read_bytes())
        assert archive_id['bytes'] == pin['archiveBytes'] and archive_id['sha256'] == pin['archiveSha256']
        members = []
        with tarfile.open(archive, 'r:gz') as handle:
            for member in handle.getmembers():
                assert not member.issym() and not member.islnk(), 'unexpected provider archive link'
                if not member.isfile():
                    continue
                assert member.name.startswith('package/') and '..' not in pathlib.PurePosixPath(member.name).parts
                relative = member.name[len('package/'):]
                data = handle.extractfile(member).read()
                actual = pathlib.Path(pin['installedRoot']) / relative
                assert actual.is_file() and not actual.is_symlink() and actual.read_bytes() == data, relative
                members.append({'path': relative, **identity(data)})
        assert len(members) == pin['comparedFiles']
        installed.append({'package': pin['package'], 'archive': pin['archive'], 'archiveIdentity': archive_id,
                          'installedRoot': pin['installedRoot'], 'allRegularMembersEqual': True, 'members': members})
    assert compiled == fresh_inventory['compiledRows']
    assert installed == fresh_inventory['installedProviderArchives']
    generated = []
    for pin in fresh_inventory['installedGeneratedPackageMetadata']:
        path = pathlib.Path(pin['path'])
        assert path.is_file() and not path.is_symlink(), 'generated metadata path changed'
        value = {key: pin[key] for key in ['package', 'path', 'relative']}
        value.update(identity(path.read_bytes()))
        assert all(value[key] == pin[key] for key in ['bytes', 'sha256', 'gitBlob'])
        generated.append(value)
    assert len(generated) == 1
    runtime = identity(pathlib.Path(NODE).read_bytes())
    assert runtime['bytes'] == inventory['node']['bytes'] and runtime['sha256'] == inventory['node']['sha256']
    tooling = []
    for pin in cfg['toolingPins']:
        path = pathlib.Path(pin['path'])
        value = {'path': str(path), **identity(path.read_bytes())}
        assert all(value[key] == pin[key] for key in ['bytes', 'sha256']), str(path)
        tooling.append(value)
    assert [{'path': NODE, **runtime}, *tooling] == fresh_inventory['tooling']
    assert shutil.which('pnpm', path=env['PATH']) == cfg['pnpmLauncher']
    for path in cfg['absentUserConfigs']:
        assert not pathlib.Path(path).exists(), 'new unreviewed package-manager config'
    inherited_configs = {key.lower() for key in env if key.lower().startswith(('npm_config_', 'pnpm_config_'))}
    assert inherited_configs <= set(cfg['allowedInheritedConfigKeys']), 'unreviewed inherited package-manager override'
    assert str(pathlib.Path.home()) == cfg['configSearchRoots']['home']
    assert env.get('XDG_CONFIG_HOME', str(pathlib.Path.home() / '.config')) == cfg['configSearchRoots']['xdgConfig']
    for binding in cfg['inheritedConfigPathBindings']:
        values = [value for key, value in env.items() if key.lower() == binding['key']]
        assert values and all(value == binding['value'] for value in values), 'changed config search prefix'
        assert binding['key'] == 'npm_config_prefix'
        assert str(pathlib.Path(binding['value']) / 'etc/npmrc') == binding['absentConfig']
        assert binding['absentConfig'] in cfg['absentUserConfigs']
    return {'compiledRows': compiled, 'installedProviderArchives': installed,
            'generatedPackageMetadata': generated, 'freshInputIdentity': FRESH_INPUT,
            'directNode': {'path': NODE, **runtime}, 'toolingPins': tooling,
            'pnpmLauncher': cfg['pnpmLauncher'], 'pnpmDeclaredVersion': '11.25.0',
            'versionExecutions': 0, 'newBuilds': 0, 'newInstalls': 0}


def snapshot(overlays):
    return {'at': utc(), 'source': source_snapshot(overlays), 'dependencies': dependency_snapshot(),
            'processCensus': process_rows(), 'testTemps': temp_rows()}


assert len(sys.argv) == 5, 'binding path, binding SHA256, action and command required'
binding_path, binding_sha, action, command = sys.argv[1:]
binding_bytes = pathlib.Path(binding_path).read_bytes()
assert hashlib.sha256(binding_bytes).hexdigest() == binding_sha
cfg = json.loads(binding_bytes)
assert cfg['publishedR1'] == R1 and cfg['phase'] in ['red', 'green']
assert cfg['actualPublishedReadbackAccepted'] is True
assert cfg['publishedSubject']['commit'] and cfg['publishedSubject']['tree']
assert identity(pathlib.Path(__file__).read_bytes()) == cfg['runnerIdentity']
input_bytes = pathlib.Path(cfg['inputInventoryPath']).read_bytes()
assert hashlib.sha256(input_bytes).hexdigest() == INPUT_SHA
inventory = json.loads(input_bytes)
assert inventory['localHead'] == LOCAL_HEAD and inventory['allTrackedNonDocsEqualHead'] is True
fresh_bytes = pathlib.Path(cfg['freshInputInventoryPath']).read_bytes()
assert identity(fresh_bytes) == FRESH_INPUT
fresh_inventory = json.loads(fresh_bytes)
assert fresh_inventory['localHead'] == LOCAL_HEAD
assert fresh_inventory['executableBaseline'] == '3e41e39b101ccc06bb24203be245ac55dcf1502f'
assert fresh_inventory['allPriorSelectedRowsRehashedAndMatched'] is True
assert len(fresh_inventory['trackedNonDocRows']) == 8798
assert command in (['red'] if cfg['phase'] == 'red' else ['green', 'lint', 'source-size', 'diff-check'])
assert command in COMMANDS and action in ['materialize', 'run']
env = os.environ.copy()
env['PATH'] = str(pathlib.Path(NODE).parent) + os.pathsep + env['PATH']
env['AGENT_TEAMS_INSTALL_PROFILE'] = 'node-ci'
env['AGENT_BACKEND_TEST_NODE'] = NODE
env['TMPDIR'] = str(TASK_TMP)
tempfile.tempdir = str(TASK_TMP)
for key in list(env):
    if key in UNSET or key.startswith('LEGACY_DESKTOP_'):
        del env[key]
OUT.mkdir(exist_ok=True)
assert OUT.is_dir() and not OUT.is_symlink(), 'task evidence root changed'
TASK_TMP.mkdir(exist_ok=True)
assert TASK_TMP.is_dir() and not TASK_TMP.is_symlink(), 'task temporary root changed'
if action == 'materialize':
    assert shutil.disk_usage(REPO).free >= 8 * 1024 * 1024, 'workspace headroom below 8MiB'
    assert shutil.disk_usage(OUT).free >= 64 * 1024 * 1024, 'task filesystem headroom below 64MiB'
    assert command == cfg['phase']
    before = snapshot(cfg['beforeSourceOverlay'])
    if cfg['phase'] == 'red':
        assert before['source']['rows'] == fresh_inventory['trackedNonDocRows']
    previous = {row['path']: row for row in before['source']['rows']}
    changed = []
    for row in cfg['sourceOverlay']:
        data = row['content'].encode()
        assert identity(data) == {key: row[key] for key in ['bytes', 'sha256', 'gitBlob']}
        assert row['mode'] in ['100644', '100755']
        if row['gitBlob'] != previous[row['path']]['gitBlob']:
            changed.append(row['path'])
    assert sorted(changed) == sorted(cfg['materializePaths'])
    if cfg['phase'] == 'green':
        assert sorted(changed) == sorted([PATHS[0], PATHS[1]])
    else:
        assert changed == [PATHS[2]]
    for row in cfg['sourceOverlay']:
        if row['path'] in changed:
            (REPO / row['path']).write_bytes(row['content'].encode())
    after = snapshot(cfg['sourceOverlay'])
    assert before['dependencies'] == after['dependencies']
    receipt = {'kind': 'exact-published-source-overlay', 'phase': cfg['phase'], 'bindingSha256': binding_sha,
               'before': before, 'after': after, 'writtenPaths': sorted(changed), 'runtimeCommands': 0}
    destination = OUT / (cfg['phase'] + '-materialization.json')
    with destination.open('x') as handle:
        handle.write(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'materialized': cfg['phase'], 'actualLocalHead': LOCAL_HEAD,
                      'publishedSubject': cfg['publishedSubject'], 'paths': len(changed)}), flush=True)
    sys.exit(0)

if cfg['phase'] == 'green':
    red = pathlib.Path(cfg['acceptedSemanticRed']['receiptPath']).read_bytes()
    assert hashlib.sha256(red).hexdigest() == cfg['acceptedSemanticRed']['receiptSha256']
    prior = json.loads(red)
    assert prior['command'] == 'red' and prior['exitCode'] == 1 and not prior['timedOut']
    assert not prior.get('executionError') and not prior.get('postflightError') and prior['exitSignal'] is None
    assert prior['inputsPreserved'] and prior['cleanup']['capturedSessionMembersAfter'] == []
    assert prior['cleanup']['newTestTempsRemaining'] == []
    assert cfg['acceptedSemanticRed']['independentReviewAccepted'] is True
if command not in ['red', 'green']:
    green = json.loads((OUT / 'green-receipt.json').read_text())
    assert green['publishedSubject'] == cfg['publishedSubject'] and green['exitCode'] == 0
    assert not green.get('executionError') and not green.get('postflightError') and green['exitSignal'] is None
    assert green['inputsPreserved'] and not green['timedOut'] and green['cleanup']['capturedSessionMembersAfter'] == []
    assert green['cleanup']['newTestTempsRemaining'] == []
before = snapshot(cfg['sourceOverlay'])
lock = OUT / (command + '.attempt')
with lock.open('x') as handle:
    handle.write(utc() + '\n')
receipt = {'kind': 'single-authorized-whole-file-or-scoped-guard-command', 'command': command,
           'publishedR1': R1, 'publishedSubject': cfg['publishedSubject'], 'actualLocalHead': LOCAL_HEAD,
           'bindingPath': binding_path, 'bindingIdentity': identity(binding_bytes),
           'runnerIdentity': cfg['runnerIdentity'], 'argv': COMMANDS[command], 'cwd': str(REPO),
           'environment': {key: env.get(key) for key in ['PATH', 'TMPDIR', 'AGENT_TEAMS_INSTALL_PROFILE', 'AGENT_BACKEND_TEST_NODE', *UNSET]},
           'allLegacyDesktopSelectorsAbsent': not any(key.startswith('LEGACY_DESKTOP_') for key in env),
           'launcherForcedEnvironment': {'pnpm_config_pm_on_fail': 'ignore'} if COMMANDS[command][0] == 'pnpm' else {},
           'observedTempRoot': tempfile.gettempdir(),
           'before': before, 'startedAt': utc(), 'outerWallLimitSeconds': 180, 'attempt': 1,
           'timedOut': False, 'exitCode': None, 'exitSignal': None, 'timeoutSignals': [],
           'qualification': 'Finite actual-source tests or scoped guard only; no GUI/native/platform/full-workspace qualification.'}
receipt_path = OUT / (command + '-receipt.json')


def save():
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')


save()
raw_path = OUT / (command + '.log')
start = time.monotonic()
child = None
previous_handlers = {}
launching = False
pending_signals = []
cleanup_started = False


def interrupted(signum, _frame):
    if cleanup_started:
        receipt.setdefault('signalsDuringBoundedCleanup', []).append(signum)
        return
    if launching:
        pending_signals.append(signum)
        return
    raise InterruptedError('supervisor received signal ' + str(signum))


def stop_captured_command(reason):
    global cleanup_started
    if child is None or cleanup_started:
        return
    cleanup_started = True
    saved_handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in [signal.SIGINT, signal.SIGTERM]}
    cleanup = {'reason': reason, 'capturedPid': child.pid, 'signal': None, 'reaped': False}
    receipt.setdefault('abnormalSupervisorCleanup', []).append(cleanup)
    try:
        live = child.poll() is None
        cleanup['childWasLive'] = live
        # A failed receipt/census read cannot prevent termination of this retained live child.
        members = []
        if not live:
            members = [row for row in process_rows() if row['session'] == child.pid or row['pgid'] == child.pid]
            cleanup['groupMembersAfterLeaderExit'] = members
        if live or members:
            try:
                os.killpg(child.pid, signal.SIGKILL)
                cleanup['signal'] = 'SIGKILL to the captured command group'
            except ProcessLookupError:
                cleanup['groupAlreadyAbsent'] = True
        child.wait(timeout=3)
        cleanup['reaped'] = True
    except BaseException as error:
        cleanup['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        for sig, handler in saved_handlers.items():
            signal.signal(sig, handler)


for supervisor_signal in [signal.SIGINT, signal.SIGTERM]:
    previous_handlers[supervisor_signal] = signal.signal(supervisor_signal, interrupted)
try:
    with raw_path.open('xb') as output:
        launching = True
        try:
            child = subprocess.Popen(COMMANDS[command], cwd=REPO, env=env, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        finally:
            launching = False
        receipt['capturedChildPid'] = child.pid
        if pending_signals:
            raise InterruptedError('supervisor signal during captured launch: ' + repr(pending_signals))
        save()
        try:
            remaining = 180 - (time.monotonic() - start)
            if remaining <= 0:
                raise subprocess.TimeoutExpired(COMMANDS[command], 180)
            child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            receipt['timedOut'] = True
            receipt['timeoutSignals'].append('outer180s cutoff; bounded captured-group termination')
            stop_captured_command('outer180s cutoff')
        receipt['exitCode'] = child.returncode if child.returncode is not None and child.returncode >= 0 else None
        receipt['exitSignal'] = -child.returncode if child.returncode is not None and child.returncode < 0 else None
except BaseException as error:
    receipt['executionError'] = type(error).__name__ + ': ' + str(error)
    stop_captured_command('abnormal supervisor exit after captured launch')
finally:
    if child is not None and child.poll() is None and not receipt.get('abnormalSupervisorCleanup'):
        stop_captured_command('still-live captured command at supervisor finalization')
    if child is not None:
        receipt['exitCode'] = child.returncode if child.returncode is not None and child.returncode >= 0 else None
        receipt['exitSignal'] = -child.returncode if child.returncode is not None and child.returncode < 0 else None
    for supervisor_signal, previous_handler in previous_handlers.items():
        signal.signal(supervisor_signal, previous_handler)
    receipt['finishedAt'] = utc()
    receipt['durationSeconds'] = time.monotonic() - start
    if raw_path.exists():
        receipt['rawCombinedOutput'] = {'path': str(raw_path), **identity(raw_path.read_bytes())}
    try:
        after = snapshot(cfg['sourceOverlay'])
        receipt['after'] = after
        receipt['inputsPreserved'] = before['source'] == after['source'] and before['dependencies'] == after['dependencies']
        new_temps = [row for row in after['testTemps'] if row not in before['testTemps']]
        receipt['cleanup'] = {'capturedSessionMembersAfter': [row for row in after['processCensus']
                              if child and (row['session'] == child.pid or row['pgid'] == child.pid)],
                              'newTestTempsRemaining': new_temps,
                              'scope': 'Actual captured command session/group and TEST-prefixed temp census, not universal escaped-child or native custody proof.'}
    except BaseException as error:
        receipt['inputsPreserved'] = False
        receipt['postflightError'] = type(error).__name__ + ': ' + str(error)
    save()
print(json.dumps({key: receipt.get(key) for key in ['command', 'exitCode', 'exitSignal', 'timedOut',
                 'executionError', 'postflightError', 'durationSeconds', 'inputsPreserved', 'rawCombinedOutput', 'cleanup']}), flush=True)
sys.exit(0 if not receipt.get('executionError') and not receipt.get('postflightError') else 2)
