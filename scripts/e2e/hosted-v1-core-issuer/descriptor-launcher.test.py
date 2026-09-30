import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).with_name('descriptor-launcher.py')
SPEC = importlib.util.spec_from_file_location('core_issuer_descriptor_launcher', SOURCE)
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class DescriptorLauncherFileValidationTest(unittest.TestCase):
    def test_accepts_exact_regular_file_then_rejects_symlink(self):
        with tempfile.TemporaryDirectory(prefix='core-issuer-launcher-test-') as root:
            executable = Path(root, 'cli')
            executable.write_bytes(b'#!/bin/sh\nexit 0\n')
            uid, gid = os.getuid(), os.getgid()
            observed = LAUNCHER.assert_pinned_regular_file(str(executable), uid, gid)
            self.assertEqual(observed.st_ino, executable.lstat().st_ino)
            link = Path(root, 'link')
            link.symlink_to(executable)
            with self.assertRaisesRegex(RuntimeError, 'image-file-substituted'):
                LAUNCHER.assert_pinned_regular_file(str(link), uid, gid)

    def test_exec_child_receives_fd3_fd4_fd5_and_drops_groups(self):
        # Keep the FD remapping in a separate process so the test runner's
        # own descriptors remain untouched.
        probe = r'''
import fcntl, importlib.util, json, os, socket, subprocess, sys, tempfile
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('launcher', sys.argv[1])
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
launcher.reserve_target_fds()
with tempfile.TemporaryFile() as lease:
    lease.write(b'lease')
    lease.flush()
    lease.seek(0)
    child_live, parent_live = socket.socketpair()
    parent_live.sendall(b'live')
    bootstrap_read, bootstrap_write = os.pipe()
    os.write(bootstrap_write, b'boot')
    sources = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10)
               for fd in (lease.fileno(), child_live.fileno(), bootstrap_read)]
    child_code = "import json,os;print(json.dumps({'lease':os.read(3,5).decode(),'live':os.read(4,4).decode(),'boot':os.read(5,4).decode(),'groups':os.getgroups(),'uid':os.getuid(),'gid':os.getgid()}))"
    privileged = os.geteuid() == 0
    if privileged:
        os.setgroups([0])
    child = launcher.spawn_descriptor_child([sys.executable, '-I', '-c', child_code],
        sources=sources, uid=65534 if privileged else None,
        gid=65534 if privileged else None, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True)
    output, errors = child.communicate(timeout=5)
    if child.returncode != 0:
        raise RuntimeError(errors)
    data = json.loads(output)
    assert (data['lease'], data['live'], data['boot']) == ('lease','live','boot'), data
    if privileged:
        assert data['groups'] == [] and data['uid'] == 65534 and data['gid'] == 65534, data
    print('fd3-fd4-fd5-and-groups-ok')
'''
        result = subprocess.run([sys.executable, '-I', '-c', probe, str(SOURCE)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fd3-fd4-fd5-and-groups-ok', result.stdout)


class AgentTeamsMcpDescriptorTest(unittest.TestCase):
    def stage(self, root):
        directory = Path(root, 'agent-teams-mcp')
        directory.mkdir(mode=0o755)
        directory.chmod(0o755)  # independent of a group-writable umask
        Path(root, 'image').mkdir()
        command, entry = directory / 'node', directory / 'index.js'
        command.write_bytes(b'node-binary')
        entry.write_bytes(b'console.log("mcp")\n')
        return {'command': str(command), 'commandSha256': LAUNCHER.file_sha256(str(command)),
                'entry': str(entry), 'entrySha256': LAUNCHER.file_sha256(str(entry))}

    def verify(self, root, descriptor, version=b'v24.16.0\n'):
        def run(argv, **options):
            self.assertEqual(argv, [descriptor['command'], '--version'])
            self.assertEqual(set(options['env']), {'PATH', 'HOME'})
            return subprocess.CompletedProcess(argv, 0, version, b'')
        return LAUNCHER.verify_agent_teams_mcp(descriptor, str(Path(root, 'image')), root, 1000, 1000,
                                               run=run, owner=(os.getuid(), os.getgid()))

    def test_pins_staged_node_and_entry_before_header(self):
        with tempfile.TemporaryDirectory(prefix='core-issuer-mcp-test-') as root:
            descriptor = self.stage(root)
            verified, version = self.verify(root, descriptor)
            self.assertEqual(verified, descriptor)
            self.assertEqual(version, 'v24.16.0')
            with self.assertRaisesRegex(RuntimeError, 'node-version-unsupported'):
                self.verify(root, descriptor, b'v24.14.1\n')
            with self.assertRaisesRegex(RuntimeError, 'node-version-unsupported'):
                self.verify(root, descriptor, b'v25.0.0\n')
            with self.assertRaisesRegex(RuntimeError, 'agent-teams-mcp-invalid'):
                self.verify(root, {**descriptor, 'environment': {}})
            with self.assertRaisesRegex(RuntimeError, 'agent-teams-mcp-path-invalid'):
                self.verify(root, {**descriptor, 'entry': str(Path(root, 'index.js'))})
            Path(descriptor['entry']).write_bytes(b'console.log("replaced")\n')
            with self.assertRaisesRegex(RuntimeError, 'agent-teams-mcp-digest-mismatch'):
                self.verify(root, descriptor)

    @unittest.skipUnless(shutil.which('bun'), 'requires bun')
    def test_bun_preflight_rejects_mcp_override_from_cwd_dotenv(self):
        bun = shutil.which('bun')
        with tempfile.TemporaryDirectory(prefix='core-issuer-mcp-env-test-') as home:
            env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': home,
                   'BUN_INSTALL': str(Path(bun).parent), 'NODE_ENV': 'production'}
            no_identity_drop = lambda: None
            attestation = LAUNCHER.assert_bun_environment(bun, env, home, 1000, 1000, no_identity_drop)
            self.assertTrue(attestation['bunEnvironmentVerified'])
            for key in ('CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY', 'AGENT_TEAMS_MCP_CLAUDE_DIR',
                        'CLAUDE_TEAM_CONTROL_URL'):
                Path(home, '.env').write_text(f'{key}=/tmp/ambient\n')
                with self.assertRaisesRegex(RuntimeError, 'bun-environment-preflight-mismatch'):
                    LAUNCHER.assert_bun_environment(bun, env, home, 1000, 1000, no_identity_drop)


if __name__ == '__main__':
    unittest.main()
