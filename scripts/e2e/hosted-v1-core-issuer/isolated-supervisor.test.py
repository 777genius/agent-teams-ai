import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

SOURCE = Path(__file__).with_name('isolated-supervisor.py')
SPEC = importlib.util.spec_from_file_location('isolated_supervisor', SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
IMAGE = 'example.invalid/inert@sha256:' + 'a' * 64
CONTAINER_ID = 'b' * 64


class FakeDocker:
    def __init__(self):
        self.calls = []
        self.container = None
        self.running = False
        self.mutate = None
        self.create_reply = None
        self.remove_reply_lost = False

    def __call__(self, *args):
        self.calls.append(args)
        if args[0] == 'create':
            self.create_args = args
            self.container = CONTAINER_ID
            if self.create_reply == 'timeout':
                raise RuntimeError('core-isolation-docker-timeout')
            return self.create_reply or CONTAINER_ID
        if args[0] == 'inspect':
            if self.container is None:
                raise MODULE.DockerNotFound('core-isolation-container-not-found')
            fields = list(self.create_args)
            def option(name):
                return fields[fields.index(name) + 1]
            mounts = [fields[index + 1] for index, item in enumerate(fields) if item == '--mount']
            values = []
            for mount in mounts:
                parts = dict(part.split('=', 1) for part in mount.split(',') if '=' in part)
                values.append({'Source': parts['source'], 'Destination': parts['target'],
                               'RW': 'readonly' not in mount})
            security_opt = [fields[index + 1] for index, item in enumerate(fields) if item == '--security-opt']
            security_opt = [f'seccomp={Path(value[8:]).read_text()}' if value.startswith('seccomp=') else value
                            for value in security_opt]
            labels = [fields[index + 1] for index, item in enumerate(fields) if item == '--label']
            data = {'Id': CONTAINER_ID, 'Config': {'Image': IMAGE, 'User': '65534:65534',
                    'Entrypoint': ['/bin/true'], 'Cmd': ['--'],
                    'Labels': dict(label.split('=', 1) for label in labels)},
                    'Name': '/' + option('--name'),
                    'AppArmorProfile': 'test-inert',
                    'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False,
                        'NetworkMode': 'none', 'PidMode': '', 'IpcMode': 'private',
                        'CapDrop': ['ALL'], 'CapAdd': None,
                        'SecurityOpt': security_opt,
                        'PidsLimit': 32, 'Memory': 256 * 1024 * 1024, 'NanoCpus': 500_000_000},
                    'Mounts': values, 'State': {'Running': self.running, 'Pid': 123 if self.running else 0}}
            if self.mutate:
                self.mutate(data)
            return json.dumps(data)
        if args[0] == 'start':
            self.running = True
        if args[0] == 'stop':
            self.running = False
        if args[0] == 'rm':
            self.container = None
            if self.remove_reply_lost:
                raise RuntimeError('core-isolation-docker-timeout')
        return ''


class InertSupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='core-inert-supervisor-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.workspace_parent = root / 'workspace'
        self.profile_parent = root / 'profile'
        self.workspace_parent.mkdir(mode=0o700)
        self.profile_parent.mkdir(mode=0o700)
        self.workspace = self.workspace_parent / ('1' * 24)
        self.profile = self.profile_parent / ('2' * 24)
        self.workspace.mkdir(mode=0o700)
        self.profile.mkdir(mode=0o700)
        self.seccomp = root / 'seccomp.json'
        self.seccomp.write_text('{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}')
        self.seccomp.chmod(0o400)
        self.runner = FakeDocker()
        self.supervisor = MODULE.InertSandboxSupervisor(
            image=IMAGE, workspace_parent=str(self.workspace_parent),
            profile_parent=str(self.profile_parent), seccomp_path=str(self.seccomp),
            seccomp_sha256=hashlib.sha256(self.seccomp.read_bytes()).hexdigest(),
            apparmor_profile='test-inert', runner=self.runner, require_root=False)

    def request(self, op, operation_id='operation_12345678', lease=None, handle=None, generation=None):
        return dict(version=1, op=op, operationId=operation_id,
                    lease=lease, handle=handle, generation=generation)

    def test_start_observe_stop_uses_only_inert_image_and_private_sandbox(self):
        lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
        started = self.supervisor.dispatch(self.request('Start', lease=lease))
        self.assertFalse(started['effectEnabled'])
        self.assertEqual(started['image'], IMAGE)
        args = self.runner.create_args
        self.assertIn('--cap-drop', args)
        self.assertIn('ALL', args)
        self.assertIn('--network', args)
        self.assertIn('none', args)
        self.assertNotIn('opencode', ' '.join(args).lower())
        observed = self.supervisor.dispatch(self.request('Observe', 'observe_12345678',
            handle=started['handle'], generation=started['generation']))
        self.assertTrue(observed['running'])
        self.assertFalse(observed['effectEnabled'])
        stopped = self.supervisor.dispatch(self.request('Stop', 'stopping_12345678',
            handle=started['handle'], generation=started['generation']))
        self.assertTrue(stopped['stopped'])
        self.assertIsNone(self.runner.container)

    def test_rejects_raw_paths_unknown_fields_replay_and_stale_generation(self):
        lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
        bad = self.request('Start', lease=lease)
        bad['dockerArgs'] = ['--privileged']
        with self.assertRaisesRegex(ValueError, 'shape-invalid'):
            self.supervisor.dispatch(bad)
        started = self.supervisor.dispatch(self.request('Start', lease=lease))
        with self.assertRaisesRegex(ValueError, 'lease-unavailable'):
            self.supervisor.dispatch(self.request('Start', 'operation_87654321', lease=lease))
        with self.assertRaisesRegex(ValueError, 'replay-conflict'):
            self.supervisor.dispatch(self.request('Observe', handle=started['handle'],
                generation=started['generation']))
        with self.assertRaisesRegex(ValueError, 'generation-invalid'):
            self.supervisor.dispatch(self.request('Stop', 'stopping_12345678',
                handle=started['handle'], generation='wrong'))

    def test_rejects_mount_substitution_before_docker_and_bad_effective_policy(self):
        lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
        self.workspace.rmdir()
        self.workspace.symlink_to(self.profile, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            self.supervisor.dispatch(self.request('Start', lease=lease))
        self.assertEqual(self.runner.calls, [])
        self.workspace.unlink()
        self.workspace.mkdir(mode=0o700)
        second = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
        self.runner.mutate = lambda data: data['HostConfig'].update(Privileged=True)
        result = self.supervisor.dispatch(self.request('Start', 'operation_87654321', lease=second))
        self.assertEqual(result['status'], 'unresolved')
        self.assertFalse(any(call[0] == 'start' for call in self.runner.calls))

    def test_rejects_uncertain_stop_and_preserves_recovery_handle(self):
        lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
        started = self.supervisor.dispatch(self.request('Start', lease=lease))
        self.runner.mutate = lambda data: data['State'].update(Running=True, Pid=123)
        with self.assertRaisesRegex(RuntimeError, 'stop-unconfirmed'):
            self.supervisor.dispatch(self.request('Stop', 'stopping_12345678',
                handle=started['handle'], generation=started['generation']))
        self.assertIsNotNone(self.runner.container)
        self.assertFalse(self.supervisor.handles[started['handle']]['stopped'])

    def test_reconcile_stops_an_already_exited_generation(self):
        lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
        started = self.supervisor.dispatch(self.request('Start', lease=lease))
        self.runner.running = False
        reconciled = self.supervisor.dispatch(self.request('Reconcile', 'reconcile_12345678',
            handle=started['handle'], generation=started['generation']))
        self.assertTrue(reconciled['stopped'])
        self.assertIsNone(self.runner.container)
        self.assertFalse(any(call[0] == 'stop' for call in self.runner.calls))

    def test_rejects_apparmor_or_mount_policy_drift_before_start(self):
        for mutation in (
            lambda data: data.update(AppArmorProfile='unconfined'),
            lambda data: data['Mounts'].append({'Source': '/var/run/docker.sock',
                'Destination': '/var/run/docker.sock', 'RW': True}),
        ):
            with self.subTest(mutation=mutation):
                self.runner.calls.clear()
                self.runner.mutate = mutation
                lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
                result = self.supervisor.dispatch(self.request('Start', 'operation_' + os.urandom(5).hex(), lease=lease))
                self.assertEqual(result['status'], 'unresolved')
                self.assertFalse(any(call[0] == 'start' for call in self.runner.calls))

    def test_create_timeout_or_malformed_reply_keeps_named_generation_for_reconcile(self):
        for create_reply in ('timeout', 'malformed'):
            with self.subTest(create_reply=create_reply):
                self.runner.calls.clear()
                self.runner.create_reply = create_reply
                lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
                request = self.request('Start', 'start_' + os.urandom(5).hex(), lease=lease)
                started = self.supervisor.dispatch(request)
                self.assertEqual(started['status'], 'unresolved')
                self.assertFalse(started['effectEnabled'])
                self.assertEqual(self.supervisor.dispatch(request), started)
                self.assertEqual(sum(call[0] == 'create' for call in self.runner.calls), 1)
                self.assertIsNone(self.supervisor.handles[started['handle']]['id'])
                reconciled = self.supervisor.dispatch(self.request('Reconcile', 'reconcile_' + os.urandom(5).hex(),
                    handle=started['handle'], generation=started['generation']))
                self.assertTrue(reconciled['stopped'])
                self.assertIsNone(self.runner.container)

    def test_create_timeout_without_known_container_stays_unresolved(self):
        self.runner.create_reply = 'timeout'
        lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
        started = self.supervisor.dispatch(self.request('Start', lease=lease))
        self.runner.container = None
        reconciled = self.supervisor.dispatch(self.request('Reconcile', 'reconcile_12345678',
            handle=started['handle'], generation=started['generation']))
        self.assertTrue(reconciled['unresolved'])
        self.assertFalse(reconciled['stopped'])
        self.assertFalse(self.supervisor.handles[started['handle']]['stopped'])

    def test_remove_reply_loss_reconciles_by_confirmed_missing_container(self):
        lease = self.supervisor.issue_lease(workspace=str(self.workspace), profile=str(self.profile))
        started = self.supervisor.dispatch(self.request('Start', lease=lease))
        self.runner.remove_reply_lost = True
        stopped = self.supervisor.dispatch(self.request('Stop', 'stopping_12345678',
            handle=started['handle'], generation=started['generation']))
        self.assertTrue(stopped['stopped'])
        self.assertIsNone(self.runner.container)

    def test_docker_inspect_lowercase_missing_object_is_reconcilable(self):
        completed = subprocess.CompletedProcess(['docker', 'inspect'], 1, '\n',
                                                'error: no such object: exact-container-id\n')
        with patch.object(MODULE.subprocess, 'run', return_value=completed):
            with self.assertRaises(MODULE.DockerNotFound):
                MODULE.DockerRunner()('inspect', '--format', '{{json .}}', 'exact-container-id')


if __name__ == '__main__':
    unittest.main()
