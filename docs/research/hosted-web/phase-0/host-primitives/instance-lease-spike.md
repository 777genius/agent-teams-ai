# P0.W4.INSTANCE_LEASE_SPIKE

Status: `characterized`.

Under `phase-00-r3`, this current-host fixture does not admit hosted mutation/runtime behavior.

`instance_lock_spike.c` opens a stable root-owned regular anchor beneath a non-writable deployment
parent, verifies expected dev/inode and mode, obtains nonblocking `flock`, duplicates the same open
file description into a controller fixture, and prevents that descriptor from reaching exec children.
Metadata never grants or steals ownership.

Current-host results:

- a second start returned typed exit 73 before its effect marker;
- `SIGSTOP` of the owner did not make the lease stealable;
- killing the launcher caused controller EOF/exit, after which exactly one clean handoff succeeded;
- closing the launcher duplicate left exclusion held by the controller duplicate;
- rename/recreate of `instance.lock` was rejected by expected inode identity and produced no effect.

Negative control: pathname replacement would allow a new `flock` on a different inode without the
provisioned-parent and expected-identity checks. The spike deliberately treats that replacement as
anchor error, not as a lease opportunity.

Not proven: two final-image containers or a manual start sharing the final volume, runtime-UID inability
to replace the root-owned anchor, Node's retained descriptor, launcher/controller crash ordering under
container init, NFS/CIFS refusal in the release image, and descendant FD scans through real adapters.
