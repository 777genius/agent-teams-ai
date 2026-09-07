# Namespace security kernel source

Root runs this on a disposable Linux kernel test host with mount, network, UTS and
PID namespace permissions, pidfd, close_range, mount_setattr, securebits, ambient
capability support, and an already installed static C toolchain. Unsupported
facilities fail; there are no skips or dependency installation steps.

From the repository root, use a fresh private output directory:

```sh
kernel_out=$(mktemp -d /tmp/namespace-security-r1057.XXXXXX)
cc -std=c17 -static -O2 -Wall -Wextra -Werror -fstack-protector-strong \
  test/e2e/fixtures/hosted-actual-owner/namespace-kernel/security.c \
  -o "$kernel_out/security"
"$kernel_out/security"
```

The harness includes the actual namespace entry source with compile-time phase
hooks. Production builds compile those hooks away and retain the existing build
command. No environment switch enables hooks in the shipped ELF.

The harness creates disposable outer mount/network/UTS/PID isolation and a tmpfs
fixture tree. It executes its static attack ELF through the actual selected
worker exec path. Assertions check empty PID1 capability sets before worker fork,
empty capability sets after exec, restored worker signal masks, locked
securebits, failed capability restoration, failed readonly-bind remount via both
mount APIs, failed backing-file write, failed hostname mutation, readonly global
proc interfaces, and continued access to root-owned 0700 input. It checks the
backing-file and outer hostname sentinels after every lifetime case. A live
process outside both PID namespaces must survive the entire suite.

Shared-memory futex gates stop at exact source phases: before controller peer
capture, before guard arming, after arming, before/after PID1 fork, before PID1
arms its guard, before/after worker fork, before the worker arms its guard, and
after real FD3 plan consumption and attack acknowledgement. Killing the actual
socketpair-creating controller must leave no adopted children unreaped. The
post-plan case includes a live grandchild. TERM and INT are separately injected
at the production wait loop's flag-check/wait boundary while a nonterminating
child exists; the test requires SIGKILL status and ECHILD after reap.

Individual waits have a three-second failure bound; the outer supervisor has a
30-second suite failure bound and kills only its owned outer PID1 on timeout.
PID1 death causes kernel teardown of that disposable namespace. No global or
process-group kill is used. Test output is assertion-based, not expected JSON.

These tests have not been compiled or run by the implementation worker. They do
not validate the real pinned Node ELF, dynamic interpreter/library closure,
selected JS entry, external-writer revocation, or full native eligibility. Root
must separately materialize the selected real ELF/toolchain, run integration
gates, and obtain independent review before admitting the source slice.

r1065 source correction: inherited artifact descriptors belong to the mount
namespace before unshare. Production now reopens their kernel-reported paths in
the current mount namespace, verifies device/inode/mode against each held input,
and pins those local descriptors for mount targets and bind sources. Missing or
replaced paths fail closed. The fixture reserves its plan descriptor alongside
input sources above the ABI and checks every mapped input identity.

Each lifetime case prints its target and actual adopted-child reap count.
Only parent_changed/parent_dead failures after deliberate controller killing
are classified as expected death rejection. Other source failures wake the
case waiter and fail the suite, including errors during teardown. The after_plan
case requires the controller's actual attack acknowledgement before killing it;
completed-setup cases require removal of the now-unmounted root directory.
The attack function includes an unreachable return for strict C compilation.
