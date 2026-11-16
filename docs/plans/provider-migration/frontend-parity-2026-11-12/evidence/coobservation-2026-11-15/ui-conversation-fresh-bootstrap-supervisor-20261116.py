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
import time
import urllib.parse
import urllib.request

R1_COMMIT = '7e6f32741ccdb470e7688cec9de9481fd05827a1'
AMENDMENT_COMMIT = '0042eec33e3bcf145de25db96f5fc7c5b026a1fe'
SOURCE_COMMIT = 'c5ff4fc283e58d486c58147b4dfb00144ca10d34'
SOURCE_TREE = '3239e6e6c8182f3d8e45ee671efc9108500b5137'
ROOT = pathlib.Path('/workspace/scratch/c714-fresh-20261116')
REPO = ROOT / 'source'
OUT = ROOT / 'evidence'
WORKSPACES = ['', 'agent-teams-controller', 'mcp-server', 'landing',
              'packages/agent-graph', 'packages/legacy-agent-host', 'packages/task-change-ledger']


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
            'explicitAssignments': r1['environment']['assignments'],
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


def git_read(*arguments):
    global metadata_counter
    metadata_counter += 1
    stage = {'id': active_stage['id'] + '-metadata', 'cwd': str(REPO)}
    pointer, record = run_child(stage, metadata_counter, [r1['tools']['git']['path'], *arguments],
                                min(active_deadline, time.monotonic() + 30), metadata=True)
    assert record['successful'], 'Git metadata refused/failed; retained ' + pointer['path']
    data = pathlib.Path(record['raw']['path']).read_bytes()
    assert identity(data) == {key: record['raw'][key] for key in ['bytes', 'sha256', 'gitBlob']}
    return data


def file_row(path, relative):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        data, mode = os.readlink(path).encode(), '120000'
    else:
        assert stat.S_ISREG(info.st_mode), 'special file: ' + relative
        data = path.read_bytes()
        mode = '100755' if info.st_mode & stat.S_IXUSR else '100644'
    return {'path': relative, 'mode': mode, **identity(data)}


def source_snapshot(include_documents=False):
    assert git_read('rev-parse', 'HEAD').decode().strip() == SOURCE_COMMIT
    assert git_read('rev-parse', 'HEAD^{tree}').decode().strip() == SOURCE_TREE
    actual = []
    for raw in git_read('ls-tree', '-rz', '--full-tree', 'HEAD').split(b'\0'):
        if raw:
            metadata, path = raw.split(b'\t', 1)
            mode, kind, blob = metadata.decode().split()
            actual.append({'path': path.decode(), 'mode': mode, 'type': kind, 'gitBlob': blob})
    expected = [{key: row[key] for key in ['path', 'mode', 'type', 'gitBlob']}
                for row in cfg['sourceTreeRows']]
    assert sorted(actual, key=lambda row: row['path']) == sorted(expected, key=lambda row: row['path'])
    assert len(actual) == 11567, 'Git tree differs'
    assert git_read('diff', '--cached', '--name-only', '-z') == b'', 'staged changes'
    assert git_read('diff', '--name-only', '-z', 'HEAD') == b'', 'tracked changes'
    assert git_read('ls-files', '--others', '--exclude-standard', '-z') == b'', 'unexpected untracked file'
    rows = []
    for pin in cfg['sourceTreeRows']:
        if not include_documents and pin['path'].startswith('docs/'):
            continue
        row = file_row(REPO / pin['path'], pin['path'])
        assert all(row[key] == pin[key] for key in ['path', 'mode', 'bytes', 'gitBlob']), pin['path']
        rows.append(row)
    assert len(rows) == (11567 if include_documents else 8798)
    return {'head': SOURCE_COMMIT, 'tree': SOURCE_TREE, 'allTreeLeaves': 11567,
            'workflowLeaves': sum(row['path'].startswith('.github/workflows/') for row in expected),
            'includeDocuments': include_documents, 'rows': rows,
            'localGitConfig': identity((REPO / '.git/config').read_bytes())}


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
        cleaning = False


def run_child(stage, index, argv, deadline, metadata=False):
    global launching, finalizing
    name = stage['id'] + '-' + str(index)
    record = {'argv': argv, 'cwd': stage['cwd'], 'startedAt': utc(), 'timedOut': False,
              'exitCode': None, 'exitSignal': None, 'capturedPid': None, 'metadataOnly': metadata}
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
                    child = subprocess.Popen(argv, cwd=stage['cwd'], env=env, stdout=output,
                                             stderr=error_stream if metadata else subprocess.STDOUT,
                                             start_new_session=True)
                finally:
                    launching = False
                record['capturedPid'] = child.pid
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
                record['deadlineExceeded'] = time.monotonic() >= deadline
                record['successful'] = bool(child is not None and record['exitCode'] == 0
                                            and not record['timedOut'] and not record.get('executionError')
                                            and not record.get('finalizationError') and not record.get('abnormalCleanup')
                                            and not record['interruptions'] and not record['deadlineExceeded'])
                pointer = write_new(name + '-receipt.json', record)
        finally:
            finalizing = previous_finalizing
    return pointer, record


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError('unselected download redirect')


def stage_pnpm(deadline):
    pin = r1['tools']['pnpm']
    destination = ROOT / 'toolchain'
    assert not any(destination.iterdir()), 'toolchain not empty'
    archive = destination / 'pnpm-11.22.0.tgz'
    proxy = env['npm_config_proxy']
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
    size = 0
    with opener.open(pin['archiveUrl'], timeout=min(30, max(0.1, deadline - time.monotonic()))) as response:
        assert response.status == 200 and response.geturl() == pin['archiveUrl']
        with archive.open('xb') as output:
            while True:
                assert time.monotonic() < deadline, 'pnpm download deadline'
                data = response.read(1024 * 1024)
                if not data:
                    break
                size += len(data)
                assert size <= pin['archiveMaxBytes'], 'pnpm archive size'
                output.write(data)
    archive.chmod(0o644)
    data = archive.read_bytes()
    assert hashlib.sha512(data).hexdigest() == pin['archiveSha512'], 'pnpm SRI differs'
    rows, names, total = [], set(), 0
    with tarfile.open(archive, 'r:gz') as handle:
        members = handle.getmembers()
        assert len(members) <= pin['maximumMembers']
        for member in members:
            assert time.monotonic() < deadline, 'pnpm staging deadline'
            relative = pathlib.PurePosixPath(member.name)
            assert relative.parts and relative.parts[0] == 'package' and not relative.is_absolute()
            assert '..' not in relative.parts and member.name not in names, 'unsafe/duplicate archive path'
            names.add(member.name)
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            assert member.isfile(), 'archive link/special member'
            total += member.size
            assert total <= pin['unpackedMaxBytes'], 'pnpm unpacked size'
            contents = handle.extractfile(member).read()
            assert len(contents) == member.size
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                output.write(contents)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            rows.append({'path': member.name, 'mode': '100755' if member.mode & 0o111 else '100644',
                         **identity(contents)})
    manifest = json.loads((destination / 'package/package.json').read_bytes())
    assert manifest['name'] == 'pnpm' and manifest['version'] == '11.22.0'
    assert manifest['bin']['pnpm'] == 'bin/pnpm.mjs'
    executable = pathlib.Path(pin['executable'])
    assert executable.is_file() and not executable.is_symlink()
    pathlib.Path(pin['launcher']).symlink_to(executable)
    assert shutil.which('pnpm', path=env['PATH']) == pin['launcher']
    assert time.monotonic() < deadline, 'pnpm staging deadline'
    return {'archive': {'path': str(archive), **identity(data), 'sha512': hashlib.sha512(data).hexdigest()},
            'manifest': manifest, 'members': rows, 'launcher': pin['launcher']}


assert len(sys.argv) == 3, 'binding path and SHA256 required'
binding_path, binding_sha = sys.argv[1:]
binding_bytes = pathlib.Path(binding_path).read_bytes()
assert hashlib.sha256(binding_bytes).hexdigest() == binding_sha
cfg = json.loads(binding_bytes)
assert pathlib.Path(__file__).resolve() == pathlib.Path(cfg['runnerLocalPath'])
assert pathlib.Path(binding_path).resolve() == pathlib.Path(cfg['bindingLocalPath'])
assert identity(pathlib.Path(__file__).read_bytes()) == cfg['runnerIdentity']
assert cfg['publishedR1'] == R1_COMMIT and cfg['publishedAmendment'] == AMENDMENT_COMMIT
assert cfg['actualIndependentPublishedReadbacksAccepted'] is True
r1 = json.loads(cfg['r1Body'])
amendment = json.loads(cfg['amendmentBody'])
assert identity(cfg['r1Body'].encode()) == cfg['r1Identity']
assert identity(cfg['amendmentBody'].encode()) == cfg['amendmentIdentity']
assert r1['source']['commit'] == SOURCE_COMMIT and r1['source']['tree'] == SOURCE_TREE
assert r1['paths']['root'] == str(ROOT)
assert len(cfg['sourceTreeRows']) == 11567
assert not ROOT.exists() and not ROOT.is_symlink(), 'fresh task root already exists'
assert ROOT.parent.resolve() == ROOT.parent
original_environment = dict(os.environ)
env, captured_transport = admit_environment(original_environment)
normalized_prefix = next(value for key, value in original_environment.items() if key.lower() == 'npm_config_prefix')
absent_configs = [*r1['environment']['absentConfigFiles'], amendment['admission']['additionalAbsentConfig']['path']]
initial_environment = environment_check()
initial_tools = tooling()
assert shutil.disk_usage(ROOT.parent).free >= 4 * 1024 ** 3, 'less than 4GiB task headroom'
ROOT.mkdir()
for key in ['toolchain', 'bin', 'evidence', 'tmp', 'store', 'cache', 'state', 'config', 'data']:
    pathlib.Path(r1['paths'][key]).mkdir()
write_new('bootstrap-start.json', {'startedAt': utc(), 'binding': identity(binding_bytes),
          'runner': cfg['runnerIdentity'], 'publishedR1': R1_COMMIT, 'publishedAmendment': AMENDMENT_COMMIT,
          'source': r1['source'], 'environment': initial_environment, 'tools': initial_tools,
          'processCensus': process_rows(), 'qualification': 'Finite setup only; no SDK/test/provider/GUI execution.'})
launching, cleaning, finalizing, phase_signals = False, False, False, []
metadata_counter = 0
previous_handlers = {sig: signal.signal(sig, interrupt) for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGALRM]}
completed_stages, pnpm_inventory, failure = [], None, None
active_stage, active_deadline = None, 0
try:
    for stage in r1['stages']:
        sid, active_stage = stage['id'], stage
        phase_signals = []
        with (OUT / (sid + '.attempt')).open('x') as handle:
            handle.write(utc() + '\n')
        receipt = {'id': sid, 'attempt': 1, 'startedAt': utc(), 'outerSeconds': stage['outerSeconds'],
                   'successful': False, 'commands': [], 'postflight': {}, 'postflightErrors': {}}
        write_new(sid + '-start.json', receipt)
        started = time.monotonic()
        deadline = active_deadline = started + stage['outerSeconds']
        signal.setitimer(signal.ITIMER_REAL, stage['outerSeconds'])
        before_source, before_dependencies, command_error = None, None, None
        try:
            try:
                environment_check()
                assert tooling() == initial_tools
                assert shutil.disk_usage(ROOT).free >= 1024 ** 3, 'less than 1GiB task headroom'
                before_source = source_snapshot() if completed_stages else None
                if before_source is not None:
                    receipt['beforeSource'] = write_new(sid + '-source-before.json', before_source)
                if sid == 'host-build':
                    before_dependencies = dependencies()
                    receipt['beforeDependencies'] = write_new(sid + '-dependencies-before.json', before_dependencies)
                    assert not compiled(), 'unexpected existing compiled output'
                verify_pnpm()
                if sid == 'tool-stage':
                    pnpm_inventory = stage_pnpm(deadline)
                    receipt['pnpmInventory'] = write_new('pnpm-inventory.json', pnpm_inventory)
                else:
                    commands = stage['argvs'] if 'argvs' in stage else [stage['argv']]
                    for index, argv in enumerate(commands, 1):
                        pointer, record = run_child(stage, index, argv, deadline)
                        receipt['commands'].append(pointer)
                        if not record['successful']:
                            raise RuntimeError('captured command failed: ' + pointer['path'])
            except BaseException as error:
                command_error = type(error).__name__ + ': ' + str(error)
            try:
                checks = [('source', lambda: source_snapshot(include_documents=(sid == 'source-restore'))),
                          ('tools', tooling), ('environment', environment_check), ('pnpm', verify_pnpm)]
                if sid in ['install', 'host-build']:
                    checks.append(('dependencies', dependencies))
                if sid == 'host-build':
                    checks.append(('compiled', compiled))
                for name, action in checks:
                    if time.monotonic() >= deadline or phase_signals:
                        receipt['postflightErrors'][name] = 'unreached within absolute cutoff or after interruption'
                        continue
                    try:
                        value = action()
                        assert time.monotonic() < deadline and not phase_signals, 'postflight exceeded absolute cutoff'
                        receipt['postflight'][name] = write_new(sid + '-' + name + '-after.json', value)
                        if name == 'source' and before_source is not None:
                            assert value == before_source, 'source inputs changed'
                        if name == 'tools':
                            assert value == initial_tools, 'tool inputs changed'
                        if name == 'environment':
                            assert value == initial_environment, 'environment changed'
                        if name == 'dependencies' and before_dependencies is not None:
                            assert value == before_dependencies, 'build changed installed dependencies'
                        if name == 'compiled':
                            assert value, 'compiler outputs absent'
                            for relative in ['adapters/team/createFilesystemTeamOwner.js',
                                             'adapters/profile/ProfileWriterLease.js', 'composition/readProfile.js']:
                                assert (REPO / 'packages/legacy-agent-host/dist' / relative).is_file(), relative
                    except BaseException as error:
                        receipt['postflightErrors'][name] = type(error).__name__ + ': ' + str(error)
            except BaseException as error:
                receipt['postflightErrors']['supervisor'] = type(error).__name__ + ': ' + str(error)
        finally:
            finalizing = True
            try:
                signal.setitimer(signal.ITIMER_REAL, 0)
                receipt['error'] = command_error
                receipt['finishedAt'] = utc()
                receipt['durationSeconds'] = time.monotonic() - started
                receipt['interruptions'] = list(phase_signals)
                receipt['deadlineExceeded'] = time.monotonic() >= deadline
                try:
                    receipt['finalProcessCensus'] = process_rows()
                    receipt['taskTempEntries'] = sorted(path.name for path in (ROOT / 'tmp').iterdir())
                except BaseException as error:
                    receipt['postflightErrors']['finalCensus'] = type(error).__name__ + ': ' + str(error)
                for name in ['source', 'tools', 'environment', 'pnpm'] + (
                        ['dependencies'] if sid in ['install', 'host-build'] else []) + (
                        ['compiled'] if sid == 'host-build' else []):
                    if name not in receipt['postflight'] and name not in receipt['postflightErrors']:
                        receipt['postflightErrors'][name] = 'unreached after supervisor interruption/error'
                receipt['retainedCommandReceipts'] = sorted(path.name for path in OUT.glob(sid + '-*-receipt.json'))
                receipt['finishedAt'] = utc()
                receipt['durationSeconds'] = time.monotonic() - started
                receipt['interruptions'] = list(phase_signals)
                receipt['deadlineExceeded'] = time.monotonic() >= deadline
                receipt['successful'] = (command_error is None and not receipt['postflightErrors']
                                         and not receipt['interruptions'] and not receipt['deadlineExceeded'])
                write_new(sid + '-receipt.json', receipt)
            finally:
                finalizing = False
        print(json.dumps({'stage': sid, 'successful': receipt['successful'], 'error': receipt.get('error'),
                          'postflightErrors': receipt['postflightErrors'],
                          'durationSeconds': receipt['durationSeconds']}), flush=True)
        if not receipt['successful'] or phase_signals:
            raise RuntimeError('bootstrap stage failed or interrupted: ' + sid)
        completed_stages.append(sid)
except BaseException as error:
    failure = type(error).__name__ + ': ' + str(error)
finally:
    finalizing = True
    signal.setitimer(signal.ITIMER_REAL, 0)
    final = {'finishedAt': utc(), 'completedStages': completed_stages,
             'successful': failure is None and len(completed_stages) == 4 and not phase_signals, 'error': failure,
             'interruptions': list(phase_signals),
             'testExecutions': 0, 'providerExecutions': 0, 'guiExecutions': 0,
             'sourceCommit': SOURCE_COMMIT, 'publishedR1': R1_COMMIT, 'publishedAmendment': AMENDMENT_COMMIT,
             'scope': 'Recovered input preparation only; fresh provider/archive/SDK import review remains required.'}
    try:
        write_new('bootstrap-final.json', final)
        print(json.dumps(final), flush=True)
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)

sys.exit(0 if final['successful'] and not phase_signals else 1)
