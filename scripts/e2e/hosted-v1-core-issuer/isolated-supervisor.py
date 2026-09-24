#!/usr/bin/env python3
"""Test-only root issuer for an inert Docker sandbox. No Owner effect adapter.

The caller receives opaque leases and handles, never Docker flags or host paths.
This module deliberately exposes no socket: an authenticated transport and the
Owner effect-token protocol must be reviewed before any model-capable use.
"""

import json
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess


_IMAGE = re.compile(r'^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$')
_ID = re.compile(r'^[a-z0-9][a-z0-9_-]{7,95}$')
_CONTAINER_ID = re.compile(r'^[0-9a-f]{64}$')
_GENERATION_LABEL = 'org.agentteams.core-inert.generation'


class DockerNotFound(RuntimeError):
    pass


def _root_owned_regular(path, issuer_uid=0, issuer_gid=0):
    item = os.lstat(path)
    if (not stat.S_ISREG(item.st_mode) or item.st_uid != issuer_uid or
            item.st_gid != issuer_gid or item.st_nlink != 1 or item.st_mode & 0o022):
        raise ValueError('core-isolation-policy-file-invalid')
    return item


def _fresh_directory(path, parent, issuer_uid=0, issuer_gid=0):
    root = Path(path)
    if (not root.is_absolute() or root.parent != Path(parent) or
            not re.fullmatch(r'[a-f0-9]{24,64}', root.name)):
        raise ValueError('core-isolation-lease-path-invalid')
    base = os.lstat(parent)
    item = os.lstat(path)
    if (not stat.S_ISDIR(base.st_mode) or base.st_uid != issuer_uid or
            base.st_gid != issuer_gid or base.st_mode & 0o022):
        raise ValueError('core-isolation-parent-invalid')
    if (not stat.S_ISDIR(item.st_mode) or item.st_uid != issuer_uid or
            item.st_gid != issuer_gid or item.st_mode & 0o077):
        raise ValueError('core-isolation-lease-directory-invalid')
    if list(root.iterdir()):
        raise ValueError('core-isolation-lease-directory-not-fresh')
    return (item.st_dev, item.st_ino)


class DockerRunner:
    def __call__(self, *args):
        try:
            result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=30, check=False)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError('core-isolation-docker-timeout') from error
        if result.returncode:
            if args[0] == 'inspect' and ('no such object:' in result.stderr.lower() or
                                         'no such container:' in result.stderr.lower()):
                raise DockerNotFound('core-isolation-container-not-found')
            raise RuntimeError('core-isolation-docker-failed:' + result.stderr[-300:])
        return result.stdout.strip()


class InertSandboxSupervisor:
    """Root-issued leases and one container generation per Start operation.

    Only a pinned inert image with /bin/true is accepted. This is a negative
    isolation fixture, never a provider or agent runtime.
    """

    def __init__(self, *, image, workspace_parent, profile_parent, seccomp_path,
                 seccomp_sha256, apparmor_profile, runner=None, require_root=True):
        if not require_root and (runner is None or isinstance(runner, DockerRunner)):
            raise RuntimeError('core-isolation-test-runner-required')
        if require_root and (os.name != 'posix' or os.geteuid() != 0):
            raise RuntimeError('core-isolation-requires-root')
        if not _IMAGE.fullmatch(image):
            raise ValueError('core-isolation-image-not-pinned')
        if not isinstance(apparmor_profile, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', apparmor_profile):
            raise ValueError('core-isolation-apparmor-profile-invalid')
        self.issuer_uid = 0 if require_root else os.geteuid()
        self.issuer_gid = 0 if require_root else os.getegid()
        _root_owned_regular(seccomp_path, self.issuer_uid, self.issuer_gid)
        if not isinstance(seccomp_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', seccomp_sha256):
            raise ValueError('core-isolation-seccomp-pin-invalid')
        with open(seccomp_path, 'rb') as source:
            profile_bytes = source.read(65537)
        if len(profile_bytes) > 65536 or hashlib.sha256(profile_bytes).hexdigest() != seccomp_sha256:
            raise ValueError('core-isolation-seccomp-pin-mismatch')
        try:
            profile = json.loads(profile_bytes)
        except (ValueError, UnicodeDecodeError):
            raise ValueError('core-isolation-seccomp-invalid') from None
        if not isinstance(profile, dict) or profile.get('defaultAction') not in ('SCMP_ACT_ERRNO', 'SCMP_ACT_KILL_PROCESS'):
            raise ValueError('core-isolation-seccomp-not-deny-default')
        self.seccomp_profile = profile
        self.image = image
        self.workspace_parent = workspace_parent
        self.profile_parent = profile_parent
        self.seccomp_path = seccomp_path
        self.apparmor_profile = apparmor_profile
        self.runner = runner or DockerRunner()
        self.leases = {}
        self.handles = {}
        self.operations = {}

    def issue_lease(self, *, workspace, profile):
        # Called only by the trusted root issuer after creating fresh directories.
        workspace_identity = _fresh_directory(workspace, self.workspace_parent, self.issuer_uid, self.issuer_gid)
        profile_identity = _fresh_directory(profile, self.profile_parent, self.issuer_uid, self.issuer_gid)
        lease = 'lease_' + secrets.token_hex(16)
        self.leases[lease] = dict(workspace=workspace, profile=profile,
                                  workspace_identity=workspace_identity,
                                  profile_identity=profile_identity, consumed=False)
        return lease

    def _checked_lease(self, lease_id):
        lease = self.leases.get(lease_id)
        if not lease or lease['consumed']:
            raise ValueError('core-isolation-lease-unavailable')
        if (_fresh_directory(lease['workspace'], self.workspace_parent, self.issuer_uid, self.issuer_gid) != lease['workspace_identity'] or
                _fresh_directory(lease['profile'], self.profile_parent, self.issuer_uid, self.issuer_gid) != lease['profile_identity']):
            raise ValueError('core-isolation-lease-substituted')
        return lease

    def _inspect(self, record):
        inspected = json.loads(self.runner('inspect', '--format', '{{json .}}', record['id'] or record['name']))
        if (not isinstance(inspected, dict) or not isinstance(inspected.get('Id'), str) or
                not _CONTAINER_ID.fullmatch(inspected['Id']) or
                (record['id'] is not None and inspected['Id'] != record['id']) or
                inspected.get('Name') != '/' + record['name'] or
                (inspected.get('Config') or {}).get('Labels', {}).get(_GENERATION_LABEL) != record['generation']):
            raise RuntimeError('core-isolation-inspect-identity-invalid')
        record['id'] = inspected['Id']
        return inspected

    def _assert_effective(self, inspected, record):
        host = inspected.get('HostConfig') or {}
        config = inspected.get('Config') or {}
        settings = host.get('SecurityOpt') or []
        seccomp_settings = [item[8:] for item in settings if isinstance(item, str) and item.startswith('seccomp=')]
        try:
            seccomp_matches = len(seccomp_settings) == 1 and json.loads(seccomp_settings[0]) == self.seccomp_profile
        except ValueError:
            seccomp_matches = False
        mounts = inspected.get('Mounts') or []
        expected_mounts = {(record['workspace'], '/sandbox/workspace', True),
                           (record['profile'], '/sandbox/profile', False)}
        actual_mounts = {(item.get('Source'), item.get('Destination'), item.get('RW')) for item in mounts}
        if (config.get('Image') != self.image or config.get('User') != '65534:65534' or
                config.get('Entrypoint') != ['/bin/true'] or config.get('Cmd') != ['--'] or
                inspected.get('AppArmorProfile') != self.apparmor_profile or
                not host.get('ReadonlyRootfs') or host.get('Privileged') or host.get('NetworkMode') != 'none' or
                host.get('PidMode') not in ('private', '') or host.get('IpcMode') != 'private' or
                'ALL' not in (host.get('CapDrop') or []) or host.get('CapAdd') or
                'no-new-privileges:true' not in settings or not seccomp_matches or
                f'apparmor={self.apparmor_profile}' not in settings or
                actual_mounts != expected_mounts or
                (host.get('PidsLimit') or 0) < 1 or (host.get('PidsLimit') or 0) > 64 or
                (host.get('Memory') or 0) < 64 * 1024 * 1024 or
                (host.get('Memory') or 0) > 512 * 1024 * 1024 or
                (host.get('NanoCpus') or 0) < 100_000_000 or
                (host.get('NanoCpus') or 0) > 1_000_000_000):
            raise RuntimeError('core-isolation-effective-policy-mismatch')

    def dispatch(self, request):
        if not isinstance(request, dict) or set(request) != {'version', 'op', 'operationId', 'lease', 'handle', 'generation'}:
            raise ValueError('core-isolation-request-shape-invalid')
        if (request['version'] != 1 or request['op'] not in ('Start', 'Observe', 'Stop', 'Reconcile') or
                not isinstance(request['operationId'], str) or not _ID.fullmatch(request['operationId'])):
            raise ValueError('core-isolation-request-invalid')
        operation_id = request['operationId']
        if operation_id in self.operations:
            if self.operations[operation_id][0] != request:
                raise ValueError('core-isolation-operation-replay-conflict')
            if request['op'] == 'Observe':
                raise ValueError('core-isolation-observe-replay')
            return self.operations[operation_id][1]
        if request['op'] == 'Start':
            if request['handle'] is not None or request['generation'] is not None:
                raise ValueError('core-isolation-start-handle-invalid')
            result = self._start(request['lease'])
        else:
            if request['lease'] is not None:
                raise ValueError('core-isolation-nonstart-lease-invalid')
            record = self.handles.get(request['handle'])
            if not record or request['generation'] != record['generation']:
                raise ValueError('core-isolation-handle-generation-invalid')
            if request['op'] == 'Observe':
                result = self._observe(record)
            else:
                result = self._stop(record)
        self.operations[operation_id] = (dict(request), result)
        return result

    def _start(self, lease_id):
        lease = self._checked_lease(lease_id)
        lease['consumed'] = True
        name = 'core-inert-' + secrets.token_hex(12)
        generation = secrets.token_hex(16)
        record = dict(id=None, name=name, generation=generation,
                      workspace=lease['workspace'], profile=lease['profile'], stopped=False)
        # Publish recovery identity before Docker is invoked. A timed-out create
        # may still have registered the named container even without stdout.
        self.handles[name] = record
        args = ('create', '--name', name, '--user', '65534:65534', '--read-only',
                '--network', 'none', '--ipc', 'private', '--cap-drop', 'ALL',
                '--label', f'{_GENERATION_LABEL}={generation}',
                '--security-opt', 'no-new-privileges:true', '--security-opt', f'seccomp={self.seccomp_path}',
                '--security-opt', f'apparmor={self.apparmor_profile}', '--pids-limit', '32',
                '--memory', '256m', '--cpus', '0.5', '--mount',
                f'type=bind,source={lease["workspace"]},target=/sandbox/workspace', '--mount',
                f'type=bind,source={lease["profile"]},target=/sandbox/profile,readonly',
                '--entrypoint', '/bin/true', self.image, '--')
        try:
            container_id = self.runner(*args)
            if not isinstance(container_id, str) or not _CONTAINER_ID.fullmatch(container_id):
                raise RuntimeError('core-isolation-container-id-invalid')
            record['id'] = container_id
            self._assert_effective(self._inspect(record), record)
            self.runner('start', container_id)
            self._assert_effective(self._inspect(record), record)
            return dict(handle=name, generation=generation, image=self.image,
                        status='started', effectEnabled=False)
        except Exception:
            # No second create and no guessed cleanup after an uncertain result.
            return dict(handle=name, generation=generation, image=self.image,
                        status='unresolved', effectEnabled=False)

    def _observe(self, record):
        inspected = self._inspect(record)
        self._assert_effective(inspected, record)
        state = inspected.get('State') or {}
        return dict(handle=record['name'], generation=record['generation'], running=state.get('Running') is True,
                    pid=state.get('Pid'), effectEnabled=False)

    def _stop(self, record):
        if record['stopped']:
            return dict(handle=record['name'], generation=record['generation'], stopped=True)
        try:
            inspected = self._inspect(record)
        except DockerNotFound:
            # A known ID disappearing after an uncertain remove can be proven
            # absent. A create with no ID remains unresolved for root audit.
            if record['id'] is None:
                return dict(handle=record['name'], generation=record['generation'], stopped=False, unresolved=True)
            try:
                self._inspect(record)
            except DockerNotFound:
                record['stopped'] = True
                return dict(handle=record['name'], generation=record['generation'], stopped=True)
            raise RuntimeError('core-isolation-stop-state-changed')
        state = inspected.get('State') or {}
        if state.get('Running') is True:
            try:
                self.runner('stop', '--time', '2', record['id'])
            except Exception:
                pass  # Reobserve instead of treating a lost reply as failure or success.
            inspected = self._inspect(record)
            state = inspected.get('State') or {}
        if state.get('Running') is not False or state.get('Pid') != 0:
            raise RuntimeError('core-isolation-stop-unconfirmed')
        try:
            self.runner('rm', record['id'])
        except Exception:
            try:
                self._inspect(record)
            except DockerNotFound:
                pass
            else:
                raise RuntimeError('core-isolation-remove-unconfirmed')
        record['stopped'] = True
        return dict(handle=record['name'], generation=record['generation'], stopped=True)
