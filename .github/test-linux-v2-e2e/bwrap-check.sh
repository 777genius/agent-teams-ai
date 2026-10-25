#!/usr/bin/env bash
# TEST-only: the V2 isolation flags against /usr/bin/bwrap, as the runtime's ordinary user.
set -uo pipefail
w=$(mktemp -d "$RUNNER_TEMP/TEST-bwrap-check-XXXX")
/usr/bin/bwrap --unshare-user --disable-userns --assert-userns-disabled --unshare-pid --as-pid-1 \
  --unshare-ipc --unshare-uts --die-with-parent --new-session --cap-drop ALL --clearenv \
  --ro-bind /usr /usr --ro-bind-try /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
  --bind "$w" "$w" --proc /proc --remount-ro /proc --dev /dev --tmpfs /sys --chdir "$w" \
  --setenv PATH /usr/bin:/bin -- /bin/sh -c 'grep -E "^(CapEff|NoNewPrivs|NSpid):" /proc/self/status; if unshare -U true 2>/dev/null; then echo nested_userns=ALLOWED; else echo nested_userns=DENIED; fi'
rc=$?
echo "bwrap rc=$rc"
exit $rc
