# Desktop file-lock native V3

This package is the raw Node-API authority for project-adjacent Desktop file locks. It has no
JavaScript locking fallback and never exposes an operating-system descriptor or handle.

The permanent marker is `<relativeTarget>.lock`. Its immutable header contains the V3 brand and a
random 128-bit owner key. The bounded active/release record after that header may change while the
marker's advisory byte-range lock is held. Normal release only unlocks and closes the marker; it
does not unlink or replace it. Initial publication uses a flushed unpredictable temporary and an
atomic no-replace filesystem operation.

Limits are part of the native contract:

- relative target: 4096 UTF-8 bytes
- active marker: 4096 UTF-8 bytes
- release record: 4096 UTF-8 bytes
- complete native marker: 8192 bytes

Non-acquisition statuses are stable: `contended`, `uncertain`, and `unsupported`. Thrown errors use
these stable codes: `ERR_FILE_LOCK_INVALID_ARGUMENT`, `ERR_FILE_LOCK_INVALID_SCOPE`,
`ERR_FILE_LOCK_INVALID_LEASE`, `ERR_FILE_LOCK_SCOPE_BUSY`, `ERR_FILE_LOCK_OWNERSHIP_LOST`,
`ERR_FILE_LOCK_UNCERTAIN`, `ERR_FILE_LOCK_UNSUPPORTED`, and `ERR_FILE_LOCK_INTERNAL`.

Build and test offline with `node scripts/build.js` followed by
`node --test test/contract.test.js`. `node scripts/check-windows-source.js` checks the inactive
Windows guard and uses MinGW for a target syntax check when `MINGW_CXX` or a standard MinGW install
is available.
