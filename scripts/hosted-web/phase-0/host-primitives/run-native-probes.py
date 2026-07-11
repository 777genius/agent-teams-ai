#!/usr/bin/env python3
"""Marker-owned Linux feasibility runner for Phase 0 lane W4.

The runner never discovers or signals arbitrary processes. Every PID, mount and path it touches is
created beneath its private temporary marker directory during this invocation.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
SOURCE_ROOT = Path(__file__).resolve().parent
CC = os.environ.get("CC", "/usr/bin/cc")


class ProbeFailure(RuntimeError):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise ProbeFailure(message)


def process_identity(pid: int) -> tuple[int, int] | None:
    try:
        record = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return None
    fields = record[record.rfind(")") + 2 :].split()
    if len(fields) < 20:
        raise ProbeFailure(f"incomplete /proc identity for owned PID {pid}")
    return int(fields[2]), int(fields[19])


class OwnedResources:
    def __init__(self) -> None:
        self.processes: list[subprocess.Popen[str]] = []
        self.identities: dict[tuple[int, int], str] = {}
        self.process_groups: set[int] = set()
        self.mounts: set[Path] = set()

    def track_process(self, process: subprocess.Popen[str], label: str) -> None:
        self.processes.append(process)
        self.track_pid(process.pid, label)

    def track_pid(self, pid: int, label: str) -> None:
        identity = process_identity(pid)
        if identity is None:
            return
        process_group, start_time = identity
        self.identities[(pid, start_time)] = label
        self.process_groups.add(process_group)

    def track_mount(self, path: Path) -> None:
        self.mounts.add(path)

    def untrack_mount(self, path: Path) -> None:
        self.mounts.discard(path)

    def identity_is_live(self, pid: int, start_time: int) -> bool:
        identity = process_identity(pid)
        return identity is not None and identity[1] == start_time

    def cleanup(self, marker: Path, residual_timeout: float = 3.0) -> dict[str, object]:
        for process in reversed(self.processes):
            terminate_owned(process)
        for mount in sorted(self.mounts, reverse=True):
            if mount_is_active(mount):
                run_owned(
                    self,
                    ["/usr/bin/umount", str(mount)],
                    "cleanup-umount",
                    check=True,
                    capture_output=True,
                )
        self.mounts.clear()
        deadline = time.monotonic() + residual_timeout
        residuals = list(self.identities)
        while residuals and time.monotonic() < deadline:
            residuals = [
                identity
                for identity in residuals
                if self.identity_is_live(identity[0], identity[1])
            ]
            if residuals:
                time.sleep(0.02)
        if residuals:
            details = ", ".join(
                f"{pid}:{self.identities[(pid, start_time)]}" for pid, start_time in residuals
            )
            raise ProbeFailure(f"owned process identities remained after cleanup: {details}")
        shutil.rmtree(marker)
        check(not marker.exists(), "marker directory remained after verified removal")
        return {
            "performedBeforeEmission": True,
            "markerRemoved": True,
            "ownedProcessIdentitiesTracked": len(self.identities),
            "ownedProcessGroupsTracked": len(self.process_groups),
            "ownedResidualProcesses": 0,
            "ownedResidualMounts": 0,
        }


def mount_is_active(path: Path) -> bool:
    escaped = str(path).replace(" ", "\\040")
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields = line.split()
        if len(fields) > 4 and fields[4] == escaped:
            return True
    return False


def duplicate_high_descriptor(fd: int, offset: int = 0) -> int:
    soft_limit, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
    candidate = 4096 + offset
    check(soft_limit == resource.RLIM_INFINITY or candidate < soft_limit, "high-FD fixture unavailable")
    os.dup2(fd, candidate, inheritable=True)
    return candidate


def run_owned(
    owned: OwnedResources, command: list[str], label: str, **options: object
) -> subprocess.CompletedProcess[str]:
    check_result = bool(options.pop("check", False))
    capture_output = bool(options.pop("capture_output", False))
    timeout = options.pop("timeout", None)
    input_value = options.pop("input", None)
    if capture_output:
        options["stdout"] = subprocess.PIPE
        options["stderr"] = subprocess.PIPE
    process = subprocess.Popen(command, **options)  # type: ignore[arg-type]
    owned.track_process(process, label)
    stdout, stderr = process.communicate(input=input_value, timeout=timeout)
    result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    if check_result and result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode, command, output=result.stdout, stderr=result.stderr
        )
    return result


def compile_spikes(build: Path, owned: OwnedResources) -> dict[str, Path]:
    sources = {
        "instance_lock": SOURCE_ROOT / "instance-lock" / "instance_lock_spike.c",
        "workspace_guard": SOURCE_ROOT / "workspace-guard" / "workspace_guard_spike.c",
        "process_anchor": SOURCE_ROOT / "process-anchor" / "process_anchor_spike.c",
    }
    binaries: dict[str, Path] = {}
    for name, source in sources.items():
        output = build / name
        command = [
            CC,
            "-std=c17",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-D_FORTIFY_SOURCE=2",
            "-fstack-protector-strong",
            str(source),
            "-o",
            str(output),
        ]
        compiler_environment = dict(os.environ)
        compiler_environment["PATH"] = "/usr/local/bin:/usr/bin:/bin"
        run_owned(
            owned,
            command,
            f"compiler:{name}",
            check=True,
            text=True,
            capture_output=True,
            env=compiler_environment,
        )
        binaries[name] = output
    return binaries


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def native_artifact_feasibility(binaries: dict[str, Path]) -> dict[str, object]:
    records = []
    definitions = [
        (
            "agent-teams-instance-lock",
            SOURCE_ROOT / "instance-lock" / "instance_lock_spike.c",
            ROOT / "docs/research/hosted-web/phase-0/host-primitives/instance-lock.protocol.json",
            binaries["instance_lock"],
        ),
        (
            "agent-teams-process-anchor",
            SOURCE_ROOT / "process-anchor" / "process_anchor_spike.c",
            ROOT / "docs/research/hosted-web/phase-0/host-primitives/process-anchor.protocol.json",
            binaries["process_anchor"],
        ),
        (
            "agent-teams-workspace-guard",
            SOURCE_ROOT / "workspace-guard" / "workspace_guard_spike.c",
            ROOT / "docs/research/hosted-web/phase-0/host-primitives/workspace-guard.protocol.json",
            binaries["workspace_guard"],
        ),
    ]
    for artifact_id, source, protocol, binary in definitions:
        records.append(
            {
                "artifactId": artifact_id,
                "sourceSha256": sha256_file(source),
                "protocolSha256": sha256_file(protocol),
                "currentHostUnstrippedBinarySha256": sha256_file(binary),
            }
        )
    return {
        "status": "passed_current_host_target_unverified",
        "buildRecipeId": "w4-native-c17-v1",
        "artifacts": records,
    }


def terminate_owned(process: subprocess.Popen[str], timeout: float = 3.0) -> None:
    if process.poll() is not None:
        return
    before = process_identity(process.pid)
    check(before is not None, f"live owned child {process.pid} had no process identity")
    pidfd = os.pidfd_open(process.pid)
    try:
        after = process_identity(process.pid)
        check(after == before, f"owned child {process.pid} changed identity before pidfd signal")
        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            process.wait(timeout=timeout)
    finally:
        os.close(pidfd)


def run_cleanup_probes() -> dict[str, object]:
    positive_marker = Path(tempfile.mkdtemp(prefix="atg-phase0-w4-cleanup-positive-", dir="/tmp"))
    positive = OwnedResources()
    positive_process = subprocess.Popen(["/usr/bin/sleep", "10"], text=True)
    positive.track_process(positive_process, "cleanup-positive-live-process")
    positive_result = positive.cleanup(positive_marker)
    check(positive_process.poll() is not None, "positive cleanup did not terminate its live child")

    residual_marker = Path(tempfile.mkdtemp(prefix="atg-phase0-w4-cleanup-residual-", dir="/tmp"))
    residual = OwnedResources()
    residual_process = subprocess.Popen(["/usr/bin/sleep", "10"], text=True)
    residual.track_process(residual_process, "cleanup-negative-live-residual")
    residual.processes.clear()
    residual_rejected = False
    try:
        residual.cleanup(residual_marker, residual_timeout=0.05)
    except ProbeFailure as error:
        residual_rejected = "owned process identities remained" in str(error)
    finally:
        terminate_owned(residual_process)
        if residual_marker.exists():
            shutil.rmtree(residual_marker)
    check(residual_rejected, "cleanup accepted an intentionally live owned residual")

    absent_marker = Path(tempfile.mkdtemp(prefix="atg-phase0-w4-cleanup-absent-", dir="/tmp"))
    shutil.rmtree(absent_marker)
    removal_error_rejected = False
    try:
        OwnedResources().cleanup(absent_marker, residual_timeout=0.05)
    except FileNotFoundError:
        removal_error_rejected = True
    check(removal_error_rejected, "cleanup ignored a marker removal error")
    return {
        "actualOwnedResourcesCleanupExecutions": 3,
        "liveOwnedProcessTerminated": True,
        "negativeResidualsObserved": 1,
        "negativeResidualProcessRejected": residual_rejected,
        "negativeMarkerRemovalRejected": removal_error_rejected,
        "positiveCleanup": positive_result,
    }


def wait_pid_gone(pid: int, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not Path(f"/proc/{pid}").exists():
            return
        time.sleep(0.02)
    raise ProbeFailure(f"owned PID {pid} did not exit")


def instance_command(binary: Path, deployment: Path, effect: Path, owner: str) -> list[str]:
    anchor = deployment / "instance.lock"
    identity = anchor.stat()
    return [
        str(binary),
        str(deployment),
        anchor.name,
        str(identity.st_dev),
        str(identity.st_ino),
        str(effect),
        owner,
    ]


def start_instance(
    binary: Path,
    deployment: Path,
    effect: Path,
    owner: str,
    owned: OwnedResources,
    env: dict[str, str] | None = None,
) -> tuple[subprocess.Popen[str], int]:
    process = subprocess.Popen(
        instance_command(binary, deployment, effect, owner),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    owned.track_process(process, f"instance-launcher:{owner}")
    check(process.stdout is not None, "instance stdout unavailable")
    line = process.stdout.readline().strip()
    check(line.startswith("ready "), f"instance did not become ready: {line}")
    match = re.search(r"controller=(\d+)", line)
    check(match is not None, "controller PID missing from ready record")
    controller_pid = int(match.group(1))
    owned.track_pid(controller_pid, f"instance-controller:{owner}")
    return process, controller_pid


def run_instance_lock(binary: Path, marker: Path, owned: OwnedResources) -> dict[str, object]:
    deployment = marker / "lease" / "deployment"
    deployment.mkdir(parents=True, mode=0o700)
    os.chmod(deployment, 0o700)
    anchor = deployment / "instance.lock"
    anchor.write_bytes(b"")
    os.chmod(anchor, 0o600)
    original_identity = anchor.stat()

    owner_effect = marker / "lease" / "owner.effect"
    owner, controller_pid = start_instance(binary, deployment, owner_effect, "owner-a", owned)
    try:
        check(owner_effect.read_text() == "owner-a\n", "owner effect was not committed once")
        contender_effect = marker / "lease" / "contender.effect"
        contender = run_owned(
            owned,
            instance_command(binary, deployment, contender_effect, "contender"),
            "instance-contender",
            text=True,
            capture_output=True,
        )
        check(contender.returncode == 73, "concurrent contender did not return lease_busy")
        check(not contender_effect.exists(), "busy contender reached effect code")

        owner.send_signal(signal.SIGSTOP)
        paused = run_owned(
            owned,
            instance_command(binary, deployment, contender_effect, "paused-contender"),
            "instance-paused-contender",
            text=True,
            capture_output=True,
        )
        check(paused.returncode == 73, "paused owner was incorrectly stealable")
        check(not contender_effect.exists(), "paused-owner contender reached effect code")
        owner.send_signal(signal.SIGCONT)

        replaced = deployment / "instance.lock.original"
        anchor.rename(replaced)
        anchor.write_bytes(b"replacement")
        os.chmod(anchor, 0o600)
        replacement = run_owned(
            owned,
            [
                str(binary),
                str(deployment),
                "instance.lock",
                str(original_identity.st_dev),
                str(original_identity.st_ino),
                str(contender_effect),
                "replacement-contender",
            ],
            "instance-replacement-contender",
            text=True,
            capture_output=True,
        )
        check(replacement.returncode == 74, "replacement anchor identity was accepted")
        check(not contender_effect.exists(), "replacement contender reached effect code")
        anchor.unlink()
        replaced.rename(anchor)

        owner.kill()
        owner.wait(timeout=3)
        wait_pid_gone(controller_pid)
        handoff_effect = marker / "lease" / "handoff.effect"
        handoff, _ = start_instance(binary, deployment, handoff_effect, "owner-b", owned)
        terminate_owned(handoff)
        check(handoff_effect.read_text() == "owner-b\n", "clean post-failure handoff failed")
    finally:
        if owner.poll() is None:
            owner.send_signal(signal.SIGCONT)
            terminate_owned(owner)

    duplicate_env = dict(os.environ)
    duplicate_env["ATG_CLOSE_LAUNCHER_LOCK_AFTER_READY"] = "1"
    duplicate_effect = marker / "lease" / "duplicate.effect"
    duplicate, duplicate_controller = start_instance(
        binary, deployment, duplicate_effect, "duplicate-owner", owned, duplicate_env
    )
    try:
        check(duplicate.stdout is not None, "duplicate stdout unavailable")
        closed_line = duplicate.stdout.readline().strip()
        check(closed_line == "launcher_lock_closed", "launcher duplicate did not close")
        contender = run_owned(
            owned,
            instance_command(binary, deployment, marker / "lease" / "duplicate-contender.effect", "x"),
            "instance-duplicate-contender",
            text=True,
            capture_output=True,
        )
        check(contender.returncode == 73, "controller duplicate did not retain the lease")
    finally:
        terminate_owned(duplicate)
        wait_pid_gone(duplicate_controller)

    return {
        "status": "passed_current_host",
        "mutualExclusion": True,
        "pausedOwnerNotStealable": True,
        "killedOwnerCleanHandoff": True,
        "duplicateCloseOrdering": True,
        "pathReplacementRejectedByIdentity": True,
        "outsideEffects": 0,
    }


def guard_identity(
    binary: Path, root: Path, generation: str, owned: OwnedResources
) -> tuple[int, int, int]:
    identity = root.stat()
    result = run_owned(
        owned,
        [
            str(binary),
            str(root),
            str(identity.st_dev),
            str(identity.st_ino),
            "0",
            generation,
            "probe",
            "unused",
        ],
        "workspace-identity-probe",
        text=True,
        capture_output=True,
    )
    check(result.returncode == 0, f"workspace syscall probe failed: {result.stderr}")
    match = re.search(r"dev=(\d+) ino=(\d+) mnt=(\d+)", result.stdout)
    check(match is not None, "workspace probe identity was incomplete")
    return tuple(int(value) for value in match.groups())


def guard_command(
    binary: Path,
    root: Path,
    identity: tuple[int, int, int],
    generation: str,
    operation: list[str],
) -> list[str]:
    return [
        str(binary),
        str(root),
        *(str(value) for value in identity),
        generation,
        *operation,
    ]


def run_workspace_guard(binary: Path, marker: Path, owned: OwnedResources) -> dict[str, object]:
    workspace_parent = marker / "guard"
    root = workspace_parent / "workspace"
    outside = workspace_parent / "outside-marker-owned-negative-control"
    root.mkdir(parents=True)
    outside.mkdir()
    (root / ".atg-mount-generation").write_text("generation-1\n")
    (root / "safe").mkdir()
    identity = guard_identity(binary, root, "generation-1", owned)

    created = run_owned(
        owned,
        guard_command(binary, root, identity, "generation-1", ["create", "safe/created", "safe"]),
        "workspace-create",
        text=True,
        capture_output=True,
    )
    check(created.returncode == 0 and (root / "safe" / "created").read_text() == "safe", "guarded create failed")

    (root / "parent-link").symlink_to(outside, target_is_directory=True)
    parent_escape = run_owned(
        owned,
        guard_command(binary, root, identity, "generation-1", ["create", "parent-link/escape", "bad"]),
        "workspace-parent-symlink-negative",
        text=True,
        capture_output=True,
    )
    check(parent_escape.returncode == 77, "parent symlink escape was not rejected")
    check(not (outside / "escape").exists(), "parent symlink created an outside effect")

    outside_target = outside / "final-target"
    outside_target.write_text("unchanged")
    (root / "safe" / "final-link").symlink_to(outside_target)
    final_escape = run_owned(
        owned,
        guard_command(binary, root, identity, "generation-1", ["create", "safe/final-link", "bad"]),
        "workspace-final-symlink-negative",
        text=True,
        capture_output=True,
    )
    check(final_escape.returncode == 77, "final symlink mutation was not rejected")
    check(outside_target.read_text() == "unchanged", "final symlink changed outside marker")

    stale = run_owned(
        owned,
        guard_command(binary, root, identity, "stale-generation", ["create", "safe/stale", "bad"]),
        "workspace-stale-generation-negative",
        text=True,
        capture_output=True,
    )
    check(stale.returncode == 77 and not (root / "safe" / "stale").exists(), "stale generation produced an effect")

    race_command = guard_command(
        binary, root, identity, "generation-1", ["create", "safe/race", "descriptor-bound"]
    )
    race_env = dict(os.environ)
    race_env["ATG_GUARD_PAUSE_MS"] = "350"
    race = subprocess.Popen(race_command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=race_env)
    owned.track_process(race, "workspace-root-rename-race")
    time.sleep(0.12)
    old_root = workspace_parent / "workspace-opened-inode"
    root.rename(old_root)
    root.symlink_to(outside, target_is_directory=True)
    race_stdout, race_stderr = race.communicate(timeout=3)
    check(race.returncode == 0, f"descriptor-bound rename race failed: {race_stdout} {race_stderr}")
    check((old_root / "safe" / "race").read_text() == "descriptor-bound", "effect did not stay on opened inode")
    check(not (outside / "safe" / "race").exists(), "root rename race produced outside effect")
    root.unlink()
    old_root.rename(root)

    raw_script = """
const fs = require('node:fs');
const root = process.argv[1];
fs.realpathSync(root);
process.stdout.write('checked\\n');
setTimeout(() => fs.writeFileSync(root + '/raw-node-effect', 'escaped'), 250);
"""
    raw = subprocess.Popen(
        ["/usr/local/bin/node", "-e", raw_script, str(root)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    owned.track_process(raw, "raw-node-toctou-negative")
    check(raw.stdout is not None and raw.stdout.readline().strip() == "checked", "raw Node control did not reach check point")
    raw_old = workspace_parent / "workspace-raw-old"
    root.rename(raw_old)
    root.symlink_to(outside, target_is_directory=True)
    raw.communicate(timeout=3)
    check((outside / "raw-node-effect").read_text() == "escaped", "raw Node negative control did not reproduce TOCTOU")
    (outside / "raw-node-effect").unlink()
    root.unlink()
    raw_old.rename(root)

    descriptor_canary = workspace_parent / "instance.lock"
    descriptor_canary.write_text("descriptor canary")
    canary_fd = os.open(descriptor_canary, os.O_RDONLY)
    control_read_fd, control_write_fd = os.pipe()
    high_canary_fd = duplicate_high_descriptor(canary_fd)
    high_control_fd = duplicate_high_descriptor(control_read_fd, 1)
    forbidden_targets = {
        os.readlink(f"/proc/self/fd/{high_canary_fd}"),
        os.readlink(f"/proc/self/fd/{high_control_fd}"),
    }
    exec_fixture_code = r"""
import os, sys
role = sys.argv[1]
targets = []
for name in os.listdir('/proc/self/fd'):
    try: targets.append(os.readlink('/proc/self/fd/' + name))
    except OSError: pass
open(role + '.fds', 'w').write('\n'.join(targets))
open(role + '.marker', 'w').write(os.getcwd())
"""
    try:
        for role in ("provider", "git-helper", "helper"):
            child = run_owned(
                owned,
                guard_command(
                    binary,
                    root,
                    identity,
                    "generation-1",
                    ["exec", "safe", "/usr/bin/python3", "-c", exec_fixture_code, role],
                ),
                f"workspace-exec:{role}",
                text=True,
                capture_output=True,
                pass_fds=(high_canary_fd, high_control_fd),
            )
            child_marker = root / "safe" / f"{role}.marker"
            fd_marker = root / "safe" / f"{role}.fds"
            check(child.returncode == 0 and child_marker.exists(), f"guarded {role} failed: {child.stderr}")
            check(Path(child_marker.read_text()).samefile(root / "safe"), f"{role} cwd escaped descriptor root")
            observed_targets = set(fd_marker.read_text().splitlines())
            check(forbidden_targets.isdisjoint(observed_targets), f"lease/control descriptor leaked to {role}")
    finally:
        os.close(canary_fd)
        os.close(control_read_fd)
        os.close(control_write_fd)
        os.close(high_canary_fd)
        os.close(high_control_fd)

    repo = root / "repo"
    run_owned(owned, ["/usr/bin/git", "init", "-q", str(repo)], "git-init", check=True)
    run_owned(
        owned,
        ["/usr/bin/git", "-C", str(repo), "config", "user.email", "fixture@example.invalid"],
        "git-config-email",
        check=True,
    )
    run_owned(
        owned,
        ["/usr/bin/git", "-C", str(repo), "config", "user.name", "W4 Fixture"],
        "git-config-name",
        check=True,
    )
    (repo / "tracked").write_text("fixture")
    run_owned(owned, ["/usr/bin/git", "-C", str(repo), "add", "tracked"], "git-add", check=True)
    run_owned(
        owned,
        ["/usr/bin/git", "-C", str(repo), "commit", "-qm", "fixture"],
        "git-commit",
        check=True,
    )
    hook_marker = outside / "git-hook.effect"
    hooks = repo / ".git" / "hooks"
    hook = hooks / "post-checkout"
    hook.write_text(f"#!/bin/sh\n/usr/bin/touch '{hook_marker}'\n")
    hook.chmod(0o700)
    run_owned(
        owned,
        ["/usr/bin/git", "-C", str(repo), "worktree", "add", "-q", "../raw-wt", "-b", "raw"],
        "raw-git-hook-negative",
        check=True,
    )
    check(hook_marker.exists(), "raw Git negative control did not run post-checkout hook")
    hook_marker.unlink()
    guarded_git = run_owned(
        owned,
        guard_command(
            binary,
            root,
            identity,
            "generation-1",
            [
                "exec",
                "repo",
                "/usr/bin/git",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "credential.helper=",
                "worktree",
                "add",
                "-q",
                "../guarded-wt",
                "-b",
                "guarded",
            ],
        ),
        "guarded-git-worktree",
        text=True,
        capture_output=True,
    )
    check(guarded_git.returncode == 0, f"guarded Git fixture failed: {guarded_git.stderr}")
    check(not hook_marker.exists(), "guarded Git ran repository hook")

    bind_mount_result = "unavailable"
    bind_target = root / "bound"
    bind_target.mkdir()
    bind_source = outside / "bind-source"
    bind_source.mkdir()
    mount = run_owned(
        owned,
        ["/usr/bin/mount", "--bind", str(bind_source), str(bind_target)],
        "workspace-bind-mount",
        text=True,
        capture_output=True,
    )
    if mount.returncode == 0:
        owned.track_mount(bind_target)
        try:
            bound = run_owned(
                owned,
                guard_command(binary, root, identity, "generation-1", ["create", "bound/escape", "bad"]),
                "workspace-bind-mount-negative",
                text=True,
                capture_output=True,
            )
            check(bound.returncode == 77 and not (bind_source / "escape").exists(), "bind submount crossing was not rejected")
            bind_mount_result = "rejected_zero_effect"
        finally:
            run_owned(
                owned,
                ["/usr/bin/umount", str(bind_target)],
                "workspace-bind-umount",
                check=True,
                capture_output=True,
            )
            owned.untrack_mount(bind_target)

    return {
        "status": "passed_current_host",
        "openat2": True,
        "statxMountId": identity[2],
        "parentSymlinkOutsideEffects": 0,
        "finalSymlinkOutsideEffects": 0,
        "rootRenameOutsideEffects": 0,
        "staleGenerationOutsideEffects": 0,
        "fakeProviderCwdBound": True,
        "gitHookDisabled": True,
        "rawNodeNegativeControlOutsideEffects": 1,
        "bindMount": bind_mount_result,
        "execDescriptorLeaks": 0,
        "highFdCanariesClosed": True,
    }


def read_ready(process: subprocess.Popen[str]) -> str:
    check(process.stdout is not None, "anchor stdout unavailable")
    ready = process.stdout.readline().strip()
    check(ready.startswith("type=ready "), f"anchor ready record missing: {ready}")
    return ready


def run_anchor_case(
    binary: Path, marker: Path, mode: str, close_control: bool, owned: OwnedResources
) -> tuple[str, str]:
    nonce = f"nonce-{mode}-{'eof' if close_control else 'stop'}"
    fd_marker = marker / "anchor" / f"{mode}.fds"
    inherited_canary = marker / "anchor" / "instance.lock"
    inherited_canary.touch(exist_ok=True)
    canary_fd = os.open(inherited_canary, os.O_RDONLY)
    extra_control_read, extra_control_write = os.pipe()
    high_canary_fd = duplicate_high_descriptor(canary_fd)
    high_control_fd = duplicate_high_descriptor(extra_control_read, 1)
    try:
        process = subprocess.Popen(
            [
                str(binary),
                nonce,
                mode,
                str(fd_marker),
                "120",
                "host_reset",
                "7",
                "deployment-generation-fixture",
                f"process-anchor-generation-{mode}",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            pass_fds=(high_canary_fd, high_control_fd),
        )
        owned.track_process(process, f"process-anchor:{mode}")
    finally:
        os.close(canary_fd)
        os.close(extra_control_read)
        os.close(extra_control_write)
        os.close(high_canary_fd)
        os.close(high_control_fd)
    ready = read_ready(process)
    check(f"nonce={nonce}" in ready and "pidfd=yes" in ready and "subreaper=yes" in ready, "ready evidence did not bind nonce/pidfd/subreaper")
    main_match = re.search(r"main=(\d+)", ready)
    group_match = re.search(r"group=(\d+)", ready)
    check(main_match is not None and group_match is not None, "anchor ownership identities missing")
    owned.track_pid(int(main_match.group(1)), f"process-anchor-main:{mode}")
    expected_role = "escaped" if mode == "escape" else "grandchild" if mode == "double" else "main"
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if fd_marker.exists() and f"role={expected_role}" in fd_marker.read_text():
            break
        time.sleep(0.02)
    check(
        fd_marker.exists() and f"role={expected_role}" in fd_marker.read_text(),
        f"{mode} provider did not record descriptor evidence",
    )
    for provider_pid in re.findall(r"pid=(\d+)", fd_marker.read_text()):
        owned.track_pid(int(provider_pid), f"process-anchor-provider:{mode}")
    unrelated = subprocess.Popen(["/usr/bin/sleep", "10"], start_new_session=True)
    owned.track_process(unrelated, f"unrelated-canary:{mode}")
    reuse_pressure = [
        subprocess.Popen(["/usr/bin/sleep", "0.2"], start_new_session=True)
        for _ in range(24)
    ]
    for index, canary in enumerate(reuse_pressure):
        owned.track_process(canary, f"pid-pgid-reuse-pressure:{mode}:{index}")
    try:
        check(process.stdin is not None, "anchor control unavailable")
        if close_control:
            process.stdin.close()
            process.stdin = None
        else:
            process.stdin.write("STOP\n")
            process.stdin.flush()
            process.stdin.close()
            process.stdin = None
        stdout, stderr = process.communicate(timeout=5)
        check(process.returncode == 0, f"anchor {mode} failed: {stdout} {stderr}")
        check(unrelated.poll() is None, "anchor signaled an unrelated marker-owned process")
        for canary in reuse_pressure:
            canary.wait(timeout=2)
            check(canary.returncode == 0, "PID/PGID reuse-pressure canary was signaled")
    finally:
        terminate_owned(unrelated)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
    fd_evidence = fd_marker.read_text()
    check("pipe:[" not in fd_evidence and "instance.lock" not in fd_evidence, f"lease/control/status descriptor leaked to {mode} provider")
    return ready, stdout


def parse_drain_dto(output: str, record_type: str) -> dict[str, object]:
    line = next(
        (candidate for candidate in output.splitlines() if candidate.startswith(f"type={record_type} ")),
        None,
    )
    check(line is not None, f"missing {record_type} drain record")
    fields = dict(part.split("=", 1) for part in line.split() if "=" in part)
    residual_text = fields.get("residuals", "")
    check(residual_text.startswith("[") and residual_text.endswith("]"), "malformed residual list")
    residuals = [item for item in residual_text[1:-1].split(",") if item]
    dto: dict[str, object] = {
        "kind": fields.get("kind"),
        "outcome": fields.get("outcome"),
        "purpose": fields.get("purpose"),
        "resetGeneration": int(fields.get("resetGeneration", "-1")),
        "deploymentGeneration": fields.get("deploymentGeneration"),
        "processAnchorGeneration": fields.get("processAnchorGeneration"),
        "classificationId": fields.get("classificationId"),
        "residuals": residuals,
    }
    check(dto["kind"] == "process_drain_outcome_v1", "drain DTO kind mismatch")
    check(dto["purpose"] == "host_reset", "drain DTO purpose mismatch")
    check(dto["resetGeneration"] == 7, "drain DTO reset generation mismatch")
    check(
        dto["deploymentGeneration"] == "deployment-generation-fixture",
        "drain DTO deployment generation mismatch",
    )
    check(bool(dto["classificationId"]), "drain DTO classification identity missing")
    return dto


def run_process_anchor(binary: Path, marker: Path, owned: OwnedResources) -> dict[str, object]:
    (marker / "anchor").mkdir()
    normal_ready, normal = run_anchor_case(binary, marker, "normal", False, owned)
    ignore_ready, ignored = run_anchor_case(binary, marker, "ignore", False, owned)
    double_ready, double = run_anchor_case(binary, marker, "double", True, owned)
    escape_ready, escaped = run_anchor_case(binary, marker, "escape", True, owned)
    del normal_ready, ignore_ready, double_ready, escape_ready
    check(
        "type=drained" in normal and "residual=0" in normal,
        f"normal stop lacked drained outcome: {normal}",
    )
    check(
        "phase=kill" in ignored and "type=drained" in ignored and "residual=0" in ignored,
        "TERM-ignore case lacked KILL/drained evidence",
    )
    check(
        "reason=controller_eof" in double
        and "type=drained" in double
        and "residual=0" in double,
        "double-fork EOF case did not drain",
    )
    check("role=grandchild" in (marker / "anchor" / "double.fds").read_text(), "double-fork fixture did not execute")
    check(
        "type=unclassified_residual" in escaped
        and "kind=process_drain_outcome_v1" in escaped
        and "outcome=unclassified" in escaped
        and "numeric_pid_signal=no" in escaped
        and "numeric_pgid_signal=no" in escaped
        and "container_replacement_required=yes" in escaped,
        "escaped process did not produce typed fail-closed outcome",
    )
    drained_dto = parse_drain_dto(normal, "drained")
    unclassified_dto = parse_drain_dto(escaped, "unclassified_residual")
    check(drained_dto["outcome"] == "drained" and drained_dto["residuals"] == [], "drained DTO malformed")
    check(
        unclassified_dto["outcome"] == "unclassified"
        and unclassified_dto["residuals"] == ["escaped_group"],
        "unclassified DTO malformed",
    )
    return {
        "status": "passed_current_host",
        "nonceReadyBound": True,
        "pidfd": True,
        "subreaperDoubleFork": True,
        "typedStopDrained": True,
        "controllerEofDrained": True,
        "termKillEscalation": True,
        "typedUnclassified": True,
        "drainDtoKind": "process_drain_outcome_v1",
        "drainDtoGenerationBound": True,
        "drainDtoSamples": {
            "drained": drained_dto,
            "unclassified": unclassified_dto,
        },
        "numericPidSignals": 0,
        "numericPgidSignals": 0,
        "pidfdDescendantSignals": True,
        "ownedProcessGroupSignals": False,
        "rapidPidPgidReuseNegativeSchedule": True,
        "pidReuseDeterministicallyForced": False,
        "unrelatedProcessesSignaled": 0,
        "controlDescriptorLeaks": 0,
        "highFdCanariesClosed": True,
    }


def host_envelope(owned: OwnedResources) -> dict[str, object]:
    status = Path("/proc/self/status").read_text()
    seccomp = re.search(r"^Seccomp:\s+(\d+)$", status, re.MULTILINE)
    no_new_privs = re.search(r"^NoNewPrivs:\s+(\d+)$", status, re.MULTILINE)
    filesystem = run_owned(
        owned,
        ["/usr/bin/findmnt", "-T", "/tmp", "-o", "FSTYPE", "-n"],
        "host-envelope-findmnt",
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    docker = run_owned(
        owned,
        ["/usr/bin/docker", "version", "--format", "{{.Server.Version}}"],
        "host-envelope-docker",
        text=True,
        capture_output=True,
    )
    return {
        "osRelease": Path("/etc/os-release").read_text().splitlines()[0],
        "kernel": os.uname().release,
        "architecture": os.uname().machine,
        "uid": os.getuid(),
        "filesystem": filesystem,
        "seccompMode": int(seccomp.group(1)) if seccomp else None,
        "noNewPrivs": int(no_new_privs.group(1)) if no_new_privs else None,
        "node": run_owned(
            owned,
            ["/usr/local/bin/node", "--version"],
            "host-envelope-node",
            check=True,
            text=True,
            capture_output=True,
        ).stdout.strip(),
        "dockerDaemonReachable": docker.returncode == 0,
        "finalShapeContainer": False,
    }


def main() -> int:
    marker = Path(tempfile.mkdtemp(prefix="atg-phase0-w4-marker-", dir="/tmp"))
    os.chmod(marker, stat.S_IRWXU)
    owned = OwnedResources()
    result: dict[str, object] | None = None
    probe_error: Exception | None = None
    try:
        build = marker / "build"
        build.mkdir()
        binaries = compile_spikes(build, owned)
        result = {
            "$schema": "./probe-results.schema.json",
            "schemaVersion": 1,
            "recordId": "P0.W4.CURRENT_HOST_PROBE_RESULTS",
            "status": "characterized",
            "probeCommand": "/usr/bin/python3 scripts/hosted-web/phase-0/host-primitives/run-native-probes.py",
            "markerOwnership": "all fixture paths, mounts, process identities, and process groups are invocation-owned and tracked before use",
            "host": host_envelope(owned),
            "nativeArtifactFeasibility": native_artifact_feasibility(binaries),
            "cleanupProbes": run_cleanup_probes(),
            "instanceLease": run_instance_lock(binaries["instance_lock"], marker, owned),
            "workspaceGuard": run_workspace_guard(binaries["workspace_guard"], marker, owned),
            "processAnchor": run_process_anchor(binaries["process_anchor"], marker, owned),
        }
    except (ProbeFailure, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        probe_error = error
    try:
        cleanup = owned.cleanup(marker)
    except (ProbeFailure, subprocess.CalledProcessError, OSError) as cleanup_error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "error": str(probe_error) if probe_error else None,
                    "cleanupError": str(cleanup_error),
                    "marker": str(marker),
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1
    if probe_error is not None or result is None:
        print(
            json.dumps(
                {"schemaVersion": 1, "error": str(probe_error), "cleanup": cleanup}, indent=2
            ),
            file=sys.stderr,
        )
        return 1
    result["cleanup"] = cleanup
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
