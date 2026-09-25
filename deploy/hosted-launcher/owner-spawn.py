#!/usr/bin/env python3
"""Root helper that starts one installed Owner with the FD3/FD4/FD5 bootstrap.

hostedctl writes one JSON spec line to stdin. The helper verifies the installed
files again, creates the sealed launcher lease (FD3), the liveness socket (FD4)
and the one-use bootstrap pipe (FD5), then runs `cli hosted-control` as the
agent user. It holds FD4 until stdin reaches EOF: closing stdin is the only
way to revoke the Owner. Python is used because Node cannot create sealed
memfds or socketpairs without native modules.
"""

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

FD_TARGETS = (3, 4, 5)
SPEC_KEYS = {'ownerRoot', 'files', 'uid', 'gid', 'home', 'env', 'appMcp', 'lease',
             'header', 'secret', 'logPath', 'stopGraceSeconds'}
FILE_KEYS = {'cli', 'bun', 'cliJs', 'launcher'}
MCP_KEYS = {'command', 'commandSha256', 'entry', 'entrySha256'}
REQUIRED_ENV = {'PATH', 'HOME', 'BUN_INSTALL', 'NODE_ENV'}
PUBLIC_ENV = REQUIRED_ENV | {'USER', 'LOGNAME', 'LANG', 'HOSTED_OPENCODE_RUNTIME_MODE',
                             'HOSTED_OPENCODE_BIN_PATH'}
# Presence-only in the preflight: values may hold credentials (OpenCode config can embed keys).
SECRET_ENV = {'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_CONFIG_CONTENT'}
# Owner takes the app MCP only from the authenticated header and must not see
# these overrides. Owner's cwd is the root-owned install root, so no agent-written
# .env can reach it (bun loads .env from its cwd); the preflight proves the rest.
AMBIENT_OVERRIDES = ('CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND',
                     'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
                     'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON', 'AGENT_TEAMS_MCP_CLAUDE_DIR',
                     'CLAUDE_TEAM_CONTROL_URL', 'CLAUDE_CONFIG_DIR')


def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def send(value):
    sys.stdout.buffer.write(canonical(value) + b'\n')
    sys.stdout.buffer.flush()


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def assert_root_chain(path):
    """The path and all ancestors are root-owned and not group/world writable.

    A root-owned sticky ancestor such as /tmp is accepted: other users cannot
    rename or remove entries they do not own there.
    """
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        raise RuntimeError('owner-spawn-path-not-canonical')
    current = path
    while True:
        item = os.lstat(current)
        sticky_root = current != path and item.st_mode & stat.S_ISVTX
        if stat.S_ISLNK(item.st_mode) or item.st_uid != 0 or (item.st_mode & 0o022 and not sticky_root):
            raise RuntimeError('owner-spawn-path-not-root-owned')
        if current == '/':
            return
        current = os.path.dirname(current)


def assert_pinned_file(path, expected):
    item = os.lstat(path)
    if not stat.S_ISREG(item.st_mode) or item.st_uid != 0 or item.st_gid != 0 or item.st_nlink != 1:
        raise RuntimeError('owner-spawn-file-substituted')
    if not isinstance(expected, str) or len(expected) != 64 or file_sha256(path) != expected:
        raise RuntimeError('owner-spawn-file-digest-mismatch')


def assert_agent_directory(path, uid):
    item = os.lstat(path)
    if not stat.S_ISDIR(item.st_mode) or item.st_uid != uid or item.st_mode & 0o022 \
            or os.path.realpath(path) != path:
        raise RuntimeError('owner-spawn-agent-directory-invalid')


def drop_identity(uid, gid):
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def verify_app_mcp(descriptor, uid, gid, home):
    if descriptor is None:
        return None, None
    if not isinstance(descriptor, dict) or set(descriptor) != MCP_KEYS:
        raise RuntimeError('owner-spawn-app-mcp-invalid')
    for path, key in ((descriptor['command'], 'commandSha256'), (descriptor['entry'], 'entrySha256')):
        assert_root_chain(os.path.dirname(path))
        assert_pinned_file(path, descriptor[key])
    result = subprocess.run([descriptor['command'], '--version'], cwd='/',
                            env={'PATH': '/usr/bin:/bin', 'HOME': home},
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10,
                            preexec_fn=lambda: drop_identity(uid, gid), check=False)
    version = result.stdout.decode('ascii', 'replace').strip()
    parts = version.removeprefix('v').split('.')
    if result.returncode != 0 or len(parts) != 3 or not all(part.isdigit() for part in parts) \
            or int(parts[0]) != 24 or int(parts[1]) < 15:
        raise RuntimeError('owner-spawn-app-mcp-node-version-unsupported')
    return {key: descriptor[key] for key in ('command', 'commandSha256', 'entry', 'entrySha256')}, version


def assert_environment(bun, env, cwd, uid, gid):
    """Runs the pinned bun as the agent with Owner's env and cwd and compares what it sees."""
    public = sorted(PUBLIC_ENV)
    script = ('const p=' + json.dumps(public) + ',s=' + json.dumps(sorted(SECRET_ENV)) + ',a='
              + json.dumps(list(AMBIENT_OVERRIDES))
              + ';process.stdout.write(JSON.stringify({p:Object.fromEntries(p.map(k=>[k,process.env[k]??null])),'
              + 's:Object.fromEntries(s.map(k=>[k,k in process.env])),'
              + 'a:a.filter(k=>k in process.env)}))')
    result = subprocess.run([bun, '-e', script], cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=15,
                            preexec_fn=lambda: drop_identity(uid, gid), check=False)
    if result.returncode != 0 or len(result.stdout) > 8192:
        raise RuntimeError('owner-spawn-environment-preflight-failed')
    try:
        observed = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError('owner-spawn-environment-preflight-invalid') from None
    if any(observed['p'].get(key) != env.get(key) for key in public) \
            or any(observed['s'].get(key) != (key in env) for key in SECRET_ENV) or observed['a']:
        raise RuntimeError('owner-spawn-environment-preflight-mismatch')


def read_spec():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('owner-spawn-requires-linux-root')
    raw = sys.stdin.buffer.readline(262145)
    if not raw.endswith(b'\n') or len(raw) > 262144:
        raise RuntimeError('owner-spawn-spec-invalid')
    return validate_spec(json.loads(raw))


def validate_spec(spec):
    if not isinstance(spec, dict) or set(spec) != SPEC_KEYS or not isinstance(spec['files'], dict) \
            or set(spec['files']) != FILE_KEYS:
        raise RuntimeError('owner-spawn-spec-invalid')
    uid, gid = spec['uid'], spec['gid']
    if not isinstance(uid, int) or not isinstance(gid, int) or uid < 1 or gid < 1:
        raise RuntimeError('owner-spawn-agent-identity-invalid')
    env = spec['env']
    if not isinstance(env, dict) or not REQUIRED_ENV <= set(env) \
            or not set(env) <= PUBLIC_ENV | SECRET_ENV \
            or not all(isinstance(value, str) and '\0' not in value for value in env.values()):
        raise RuntimeError('owner-spawn-env-not-allowlisted')
    if env['BUN_INSTALL'] != spec['ownerRoot'] or env['NODE_ENV'] != 'production' or env['HOME'] != spec['home']:
        raise RuntimeError('owner-spawn-env-invalid')
    grace = spec['stopGraceSeconds']
    if not isinstance(grace, int) or not 1 <= grace <= 600:
        raise RuntimeError('owner-spawn-stop-grace-invalid')
    return spec


def verify_installation(spec):
    root = spec['ownerRoot']
    assert_root_chain(root)
    expected = {
        'cli': os.path.join(root, 'cli'),
        'bun': os.path.join(root, 'bin', 'bun'),
        'cliJs': os.path.join(root, 'dist', 'local-cli', 'cli.js'),
    }
    for name, (path, digest) in spec['files'].items():
        if not isinstance(path, str) or os.path.dirname(path) not in (root, os.path.join(root, 'bin'),
                                                                      os.path.join(root, 'dist', 'local-cli')):
            raise RuntimeError('owner-spawn-file-outside-install')
        if name in expected and path != expected[name]:
            raise RuntimeError('owner-spawn-file-path-invalid')
        assert_pinned_file(path, digest)
    launcher = os.path.basename(spec['files']['launcher'][0])
    if launcher != 'hostedActualOwnerLauncher-' + spec['files']['launcher'][1]:
        raise RuntimeError('owner-spawn-launcher-not-content-addressed')


def main():
    spec = read_spec()
    verify_installation(spec)
    uid, gid, env = spec['uid'], spec['gid'], spec['env']
    assert_agent_directory(spec['home'], uid)
    # Owner runs from the verified root-owned install root, never from an agent-writable
    # directory: bun would load a planted .env (NODE_OPTIONS, BUN_*, ...) on the next start.
    cwd = spec['ownerRoot']
    secret = bytes.fromhex(spec['secret'])
    if len(secret) != 32:
        raise RuntimeError('owner-spawn-secret-invalid')
    app_mcp, node_version = verify_app_mcp(spec['appMcp'], uid, gid, spec['home'])
    header = spec['header']
    if not isinstance(header, dict) or header.get('leaseEvidence') is not None or 'appMcp' in header:
        raise RuntimeError('owner-spawn-header-invalid')
    bun = spec['files']['bun'][0]
    assert_environment(bun, env, cwd, uid, gid)

    # pass_fds must name open target FDs; Python could otherwise close the dup2 targets.
    for target in FD_TARGETS:
        placeholder = os.open('/dev/null', os.O_RDONLY)
        if placeholder != target:
            os.dup2(placeholder, target, inheritable=True)
            os.close(placeholder)
        os.set_inheritable(target, True)
    lease_bytes = canonical(spec['lease'])
    lease_fd = os.memfd_create('agent-teams-launcher-lease', os.MFD_ALLOW_SEALING)
    os.fchown(lease_fd, uid, gid)
    os.fchmod(lease_fd, 0o600)
    os.write(lease_fd, lease_bytes)
    os.lseek(lease_fd, 0, os.SEEK_SET)
    fcntl.fcntl(lease_fd, fcntl.F_ADD_SEALS,
                fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE)
    lease_stat = os.fstat(lease_fd)
    header['leaseEvidence'] = {
        'device': str(lease_stat.st_dev), 'inode': str(lease_stat.st_ino), 'uid': lease_stat.st_uid,
        'gid': lease_stat.st_gid, 'mode': lease_stat.st_mode & 0o777,
        'launcherLeaseId': spec['lease']['launcherLeaseId'],
        'leaseArtifactDigest': hashlib.sha256(lease_bytes).hexdigest(),
    }
    if app_mcp is not None:
        header['appMcp'] = app_mcp
    header_bytes = canonical(header)
    authenticated = len(header_bytes).to_bytes(4, 'big') + header_bytes
    proof = hmac.new(secret, b'agent-teams.hosted-control.bootstrap/v1\0' + authenticated, hashlib.sha256).digest()
    frame = authenticated + secret + proof
    child_live, parent_live = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    bootstrap_read, bootstrap_write = os.pipe()
    sources = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10) for fd in (lease_fd, child_live.fileno(), bootstrap_read)]

    def child_setup():
        for target, source in zip(FD_TARGETS, sources):
            os.dup2(source, target, inheritable=True)
        for source in sources:
            os.close(source)
        drop_identity(uid, gid)

    log_fd = os.open(spec['logPath'], os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        child = subprocess.Popen([spec['files']['cli'][0], 'hosted-control'], pass_fds=(*FD_TARGETS, *sources),
                                 preexec_fn=child_setup, start_new_session=True, stdin=subprocess.DEVNULL,
                                 stdout=log_fd, stderr=log_fd, env=env, cwd=cwd)
    finally:
        for fd in (*sources, *FD_TARGETS, lease_fd, bootstrap_read, log_fd):
            os.close(fd)
        child_live.close()
    try:
        offset = 0
        while offset < len(frame):
            offset += os.write(bootstrap_write, frame[offset:])
    finally:
        os.close(bootstrap_write)
    send({'kind': 'spawned', 'pid': child.pid, 'attestation': {
        'environmentVerified': True, 'appMcp': None if app_mcp is None else {
            'commandSha256': app_mcp['commandSha256'], 'entrySha256': app_mcp['entrySha256'],
            'nodeVersion': node_version}}})
    while child.poll() is None:
        ready, _, _ = select.select([sys.stdin.buffer], [], [], 0.25)
        if ready:
            # EOF (or any byte) from hostedctl revokes the only liveness peer.
            os.read(sys.stdin.fileno(), 1)
            break
    parent_live.close()
    code = stop_owner(child, spec['stopGraceSeconds'])
    send({'kind': 'owner-exit', 'code': code})


def stop_owner(child, grace):
    try:
        return child.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        pass
    for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 10)):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        try:
            return child.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            continue
    return None


if __name__ == '__main__':
    try:
        main()
    except Exception as error:  # noqa: BLE001 - one structured failure line for hostedctl
        send({'kind': 'launcher-error', 'reason': str(error)[:200]})
        sys.exit(2)
