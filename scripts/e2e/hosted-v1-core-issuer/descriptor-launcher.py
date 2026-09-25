#!/usr/bin/env python3
"""Test-only retained FD3/FD4/FD5 launcher for a pinned extracted Owner CLI."""

import fcntl
import hashlib
import hmac
import json
import os
import select
import signal
import socket
import stat
import subprocess
import sys
import time


def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def send(value):
    sys.stdout.buffer.write(canonical(value) + b'\n')
    sys.stdout.buffer.flush()


def assert_pinned_regular_file(path, expected_uid=0, expected_gid=0):
    item = os.lstat(path)
    if not stat.S_ISREG(item.st_mode) or item.st_uid != expected_uid or item.st_gid != expected_gid or item.st_nlink != 1:
        raise RuntimeError('core-issuer-image-file-substituted')
    return item


FD_TARGETS = (3, 4, 5)


def reserve_target_fds():
    # pass_fds must name open target FDs as well as the source FDs. Python may
    # otherwise close dup2 targets while preparing exec.
    for target in FD_TARGETS:
        placeholder = os.open('/dev/null', os.O_RDONLY)
        try:
            os.dup2(placeholder, target, inheritable=True)
        finally:
            if placeholder != target:
                os.close(placeholder)
        os.set_inheritable(target, True)


def drop_child_identity(uid, gid):
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def child_descriptor_setup(sources, uid=None, gid=None):
    def setup():
        for target, source in zip(FD_TARGETS, sources):
            os.dup2(source, target, inheritable=True)
        for source in sources:
            os.close(source)
        if uid is not None and gid is not None:
            drop_child_identity(uid, gid)
    return setup


def spawn_descriptor_child(argv, *, sources, uid=None, gid=None, **options):
    return subprocess.Popen(argv, pass_fds=(*FD_TARGETS, *sources),
                            preexec_fn=child_descriptor_setup(sources, uid, gid),
                            start_new_session=True, **options)


def assert_bun_environment(bun, env, home, uid, gid):
    script = "const keys=['PATH','HOME','BUN_INSTALL','NODE_ENV','HOSTED_OPENCODE_RUNTIME_MODE','HOSTED_OPENCODE_BIN_PATH','XDG_CONFIG_HOME','OPENCODE_CONFIG_CONTENT'];process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]??null]))))"
    result = subprocess.run([bun, '-e', script], cwd=home, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=10, preexec_fn=lambda: drop_child_identity(uid, gid),
                            check=False)
    if result.returncode != 0 or len(result.stdout) > 4096:
        raise RuntimeError('core-issuer-bun-environment-preflight-failed')
    try:
        observed = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError):
        raise RuntimeError('core-issuer-bun-environment-preflight-invalid') from None
    if not isinstance(observed, dict) or any(observed.get(key) != env.get(key)
                                              for key in ('PATH', 'HOME', 'BUN_INSTALL', 'NODE_ENV',
                                                          'HOSTED_OPENCODE_RUNTIME_MODE',
                                                          'HOSTED_OPENCODE_BIN_PATH', 'XDG_CONFIG_HOME',
                                                          'OPENCODE_CONFIG_CONTENT')):
        raise RuntimeError('core-issuer-bun-environment-preflight-mismatch')
    return {'bunEnvironmentVerified': True,
            'officialOpenCodeSha256': '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080'
                if 'HOSTED_OPENCODE_BIN_PATH' in env else None,
            'providerConfigSha256': hashlib.sha256((env['OPENCODE_CONFIG_CONTENT'] + '\n').encode()).hexdigest()
                if 'OPENCODE_CONFIG_CONTENT' in env else None,
            'model': 'local-llama/qwen3-8b' if 'OPENCODE_CONFIG_CONTENT' in env else None}


def main():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('core-issuer-launcher-requires-linux-root')
    raw = sys.stdin.buffer.readline(131073)
    if not raw.endswith(b'\n') or len(raw) > 131072:
        raise RuntimeError('core-issuer-launch-spec-invalid')
    spec = json.loads(raw)
    if not isinstance(spec, dict) or set(spec) != {'cli', 'bun', 'cliSha256', 'bunSha256', 'uid', 'gid', 'home', 'officialOpenCodePath', 'localProvider', 'lease', 'header', 'secret', 'logPath'}:
        raise RuntimeError('core-issuer-launch-spec-invalid')
    cli, uid, gid = spec['cli'], spec['uid'], spec['gid']
    if not isinstance(cli, str) or not cli.startswith('/tmp/hosted-core-issuer-') or not os.path.isfile(cli):
        raise RuntimeError('core-issuer-cli-invalid')
    bun = spec['bun']
    if not isinstance(bun, str) or not bun.startswith('/tmp/hosted-core-issuer-') or not os.path.isfile(bun):
        raise RuntimeError('core-issuer-bun-invalid')
    image_root = os.path.dirname(cli)
    if bun != os.path.join(image_root, 'bin', 'bun'):
        raise RuntimeError('core-issuer-image-bun-linkage-invalid')
    if not isinstance(uid, int) or not isinstance(gid, int) or uid < 1 or gid < 1:
        raise RuntimeError('core-issuer-child-identity-invalid')
    secret = bytes.fromhex(spec['secret'])
    if len(secret) != 32:
        raise RuntimeError('core-issuer-secret-invalid')
    reserve_target_fds()
    lease_bytes = canonical(spec['lease'])
    lease_fd = os.memfd_create('core-issuer-launcher-lease', os.MFD_ALLOW_SEALING)
    os.fchown(lease_fd, uid, gid)
    os.fchmod(lease_fd, 0o600)
    os.write(lease_fd, lease_bytes)
    os.lseek(lease_fd, 0, os.SEEK_SET)
    seals = fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE
    fcntl.fcntl(lease_fd, fcntl.F_ADD_SEALS, seals)
    lease_stat = os.fstat(lease_fd)
    header = spec['header']
    if not isinstance(header, dict) or header.get('leaseEvidence') is not None:
        raise RuntimeError('core-issuer-header-invalid')
    header['leaseEvidence'] = {
        'device': str(lease_stat.st_dev), 'inode': str(lease_stat.st_ino), 'uid': lease_stat.st_uid,
        'gid': lease_stat.st_gid, 'mode': lease_stat.st_mode & 0o777,
        'launcherLeaseId': spec['lease']['launcherLeaseId'],
        'leaseArtifactDigest': hashlib.sha256(lease_bytes).hexdigest(),
    }
    header_bytes = canonical(header)
    prefix = len(header_bytes).to_bytes(4, 'big')
    authenticated = prefix + header_bytes
    proof = hmac.new(secret, b'agent-teams.hosted-control.bootstrap/v1\0' + authenticated, hashlib.sha256).digest()
    frame = authenticated + secret + proof
    child_live, parent_live = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    bootstrap_read, bootstrap_write = os.pipe()
    # Sources are moved above the reserved targets before dup2 in the child.
    sources = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10)
               for fd in (lease_fd, child_live.fileno(), bootstrap_read)]

    for candidate in (cli, bun, os.path.join(image_root, 'dist', 'local-cli', 'cli.js')):
        assert_pinned_regular_file(candidate)
    for candidate in (image_root, os.path.dirname(image_root)):
        item = os.lstat(candidate)
        if not stat.S_ISDIR(item.st_mode) or item.st_uid != 0 or item.st_gid != 0 or item.st_mode & 0o022:
            raise RuntimeError('core-issuer-image-parent-substituted')
    for candidate, expected in ((cli, spec['cliSha256']), (bun, spec['bunSha256'])):
        if not isinstance(expected, str) or len(expected) != 64:
            raise RuntimeError('core-issuer-image-file-pin-invalid')
        with open(candidate, 'rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if digest != expected:
            raise RuntimeError('core-issuer-image-file-pin-mismatch')
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': spec['home'],
           'BUN_INSTALL': image_root, 'NODE_ENV': 'production'}
    official_opencode = spec['officialOpenCodePath']
    if official_opencode is not None:
        if not isinstance(official_opencode, str) or official_opencode != os.path.join(os.path.dirname(image_root), 'official-opencode', 'opencode'):
            raise RuntimeError('core-issuer-official-opencode-path-invalid')
        item = os.lstat(official_opencode)
        if not stat.S_ISREG(item.st_mode) or item.st_uid != 0 or item.st_gid != 0 or item.st_nlink != 1:
            raise RuntimeError('core-issuer-official-opencode-file-invalid')
        with open(official_opencode, 'rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if digest != '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080':
            raise RuntimeError('core-issuer-official-opencode-digest-mismatch')
        env['HOSTED_OPENCODE_RUNTIME_MODE'] = 'official-v1.18.32'
        env['HOSTED_OPENCODE_BIN_PATH'] = official_opencode
    provider = spec['localProvider']
    if provider is not None:
        if not isinstance(provider, dict) or set(provider) != {'directory', 'path', 'digest', 'content', 'model', 'baseURL'}:
            raise RuntimeError('core-issuer-local-provider-invalid')
        expected_root = os.path.join(os.path.dirname(image_root), 'opencode-config')
        if provider['directory'] != expected_root or provider['path'] != os.path.join(expected_root, 'opencode', 'opencode.json') or provider['model'] != 'local-llama/qwen3-8b':
            raise RuntimeError('core-issuer-local-provider-path-invalid')
        content = provider['content']
        if not isinstance(content, str) or not isinstance(provider['digest'], str):
            raise RuntimeError('core-issuer-local-provider-content-invalid')
        for candidate in (expected_root, os.path.join(expected_root, 'opencode')):
            item = os.lstat(candidate)
            if not stat.S_ISDIR(item.st_mode) or item.st_uid != 0 or item.st_gid != 0 or item.st_mode & 0o022:
                raise RuntimeError('core-issuer-local-provider-directory-invalid')
        item = os.lstat(provider['path'])
        if not stat.S_ISREG(item.st_mode) or item.st_uid != 0 or item.st_gid != 0 or item.st_nlink != 1:
            raise RuntimeError('core-issuer-local-provider-file-invalid')
        with open(provider['path'], 'rb') as source:
            file_digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if file_digest != provider['digest'] or hashlib.sha256((content + '\n').encode()).hexdigest() != provider['digest']:
            raise RuntimeError('core-issuer-local-provider-digest-mismatch')
        env['XDG_CONFIG_HOME'] = expected_root
        env['OPENCODE_CONFIG_CONTENT'] = content
    attestation = assert_bun_environment(bun, env, spec['home'], uid, gid)
    log = open(spec['logPath'], 'ab', buffering=0)
    try:
        child = spawn_descriptor_child([cli, 'hosted-control'], sources=sources,
                                       uid=uid, gid=gid, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, env=env, cwd=spec['home'])
    finally:
        for fd in sources:
            os.close(fd)
        for fd in FD_TARGETS:
            os.close(fd)
        os.close(lease_fd)
        child_live.close()
        os.close(bootstrap_read)
        log.close()
    try:
        offset = 0
        while offset < len(frame):
            offset += os.write(bootstrap_write, frame[offset:])
    finally:
        os.close(bootstrap_write)
    send({'kind': 'spawned', 'pid': child.pid, 'attestation': attestation})
    while child.poll() is None:
        ready, _, _ = select.select([sys.stdin.buffer], [], [], 0.25)
        if ready:
            # EOF (or any unsolicited byte) revokes the sole liveness peer.
            os.read(sys.stdin.fileno(), 1)
            break
    parent_live.close()
    try:
        code = child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            code = child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            code = child.wait(timeout=5)
    send({'kind': 'owner-exit', 'code': code})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        send({'kind': 'launcher-error', 'reason': str(error)[:200]})
        sys.exit(2)
