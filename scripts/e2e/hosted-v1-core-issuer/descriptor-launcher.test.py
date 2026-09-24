import importlib.util
import os
from pathlib import Path
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


if __name__ == '__main__':
    unittest.main()
