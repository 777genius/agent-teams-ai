# OAuth intent original-file reads on Windows

Status: R1 root, independent R2 and root R3 source review approved. Implementation and platform execution remain pending. The retained plan was designed at d4b1e1c7752cefdf9123f39eb91ecd63fba07be4; source files below are unchanged at incoming 2076ae58a646d0bd250f984e3c032ca9d50e2b58. The normal executor is available again.

## Problem

FileProviderOAuthIntentStore rejects every regular Windows record because libuv synthesizes group/other read bits; fresh OAuth fails at assertOriginal after immutable intent create and before native start. Existing read also treats any ENOENT, including after original observation, as fresh absence.

## Evidence

- src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore.ts: read() unconditional POSIX &077 gate; catch returns null for any ENOENT.
- src/features/runtime-provider-management/main/adapters/output/CapturedProviderOAuth.ts: admit() lines329–339 create→assertOriginal→run; replay/cold controls depend on same store.
- https://github.com/nodejs/node/blob/v26.12.1/deps/uv/src/win/fs.c#L1956-L1960: readonly mode replicates read bits to owner/group/other; writable mode replicates read/write.
- https://nodejs.org/download/release/v26.12.1/docs/api/fs.html#file-modes: Windows permission classes are not implemented.
- src/features/agent-backend/main/infrastructure/FileTeamModelProbeIntents.ts: Existing BigIntStats lstat/open/read/post-stat/post-lstat pattern; platform-aware POSIX record mode; observed-only ENOENT; excludes ctime/nlink to permit original atomic temp-link cleanup.

## Implementation

- Use local physical-record equality predicate within existing OAuth intent store: plain non-symlink file; exact bigint dev, ino, size, mtimeNs; POSIX &077 only on non-Windows. Do not add owner or shared generic FS layer.
- lstat original path with bigint before open. Return null only when this initial observation is ENOENT. After observed original, missing/replaced/read/close failure stays unavailable, so Main cannot turn an uncertain original into a new native start.
- Check opened descriptor against original; retain existing 16385-byte bounded read and UTF-8/schema/operationId checks; require exact length==original.size and final descriptor/path identity before returning.
- Preserve same pathname, immutable atomic create, v1 bytes/fingerprint recipe, existing public error text and workflow. Coordinate the independent C v2 codec/16KiB prewrite bound in this same existing path.
- Confirm existing caller userData/root boundary. Do not impose new 0700 parent requirement on directories originally created via default-mode atomicCreateAsync. No ACL claim or broad filesystem-policy change.
- No ctime/nlink equality: unlinking the normal temporary hardlink after atomic publication may change both while leaving exact original bytes/inode.

## Exact changed-path manifest

- docs/plans/provider-migration/oauth-intent-windows-original-read-plan.md
- src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore.ts
- test/features/runtime-provider-management/fileProviderOAuthIntentStore.test.ts
- .github/workflows/ci.yml

## Finite regression checks

- Actual native Windows create/read/cold-original replay of valid immutable intent succeeds; valid Unix 0600 record succeeds.
- Unix broad group/other permission record rejected; do not present simulated process.platform as native qualification.
- Linked/reparse final file refused; regular directory/special/oversized/malformed/operation-mismatched record refused.
- Original exists then disappears before open/after bounded read/final path check: unavailable, never null; no second OAuth native start.
- Descriptor/path replacement and same-size content mutation caught by actual identity/mtime; bigint inode values above MAX_SAFE_INTEGER remain distinct.
- Valid immutable file survives atomic temporary hardlink unlink during read; no false ctime/nlink failure.
- Existing capturedProviderOAuth suite retains cold complete/cancel, duplicate admission and uncertain-create semantics on original target.

## Source reviews

- R1 root: actual store/current libuv source and repeat-original call chain.
- R2 provider_team_parity: exact source/caller/atomic publication guards approved; no other platform fallback.
- R3 root: independently re-read original.userDataPath caller and existing BigInt physical-record precedent; verified default parent mkdir compatibility.

## Publication and Windows qualification

Publish this reviewed plan with a normal local commit and expected-head CAS before production edits. Preserve the normal Husky hooks, exact runtime/compiler and existing source limits. Coordinate this store with the separate C v2 codec and prewrite bound; no parallel overwrite.

Add new file-store finite fixture plus existing capturedProviderOAuth.test.ts to existing ci.yml task-change-ledger-windows Vitest run; retain current runner, full-scope gate, reusable-evidence guard, timeout, setup and normal PR-trigger only. No new workflow/runner/matrix or manual dispatch.

ci-feedback.mts windowsFeedback requires push-to-main + exact workflow/head; PR source runs return reuse:false. ci-feedback-reuse.mts compares entire source/current tree and workflow bytes. No new freshness exception needed.

Windows runtime regression is unqualified until actual existing Windows smoke runs these paths on the published fix; published native Host success does not cover Main OAuth.
