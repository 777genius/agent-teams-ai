# Stopped snapshot excluded-file metadata plan

Status: source-reviewed proposal against d4b1e1c7752cefdf9123f39eb91ecd63fba07be4. The relevant source paths are unchanged at incoming 2076ae58a646d0bd250f984e3c032ca9d50e2b58. Execution is available again; implementation and runtime checks remain pending. This is a separate stopped-import follow-up; it is not a claim that C profile identity or all secret-capable archive contents are closed.

## Problem and exact source

The canonical exporter classifies auth.json, credential-prefixed names, .env files, checkpoints and several physical ownership/runtime artifacts as excluded. It omits their base64 but still emits SHA256(actual bytes) in every files[].sha256 row. FileStoppedSnapshotResolver then persists the complete snapshot under .host-team-registry/snapshots. FileStoppedTeamImport also keeps that snapshot in its original intent and projects the file census into .host-owner/import/source.json. The excluded file's contents never need to be copied for this fast verifier to survive.

Evidence: stopped-team-import/snapshot.ts blob 6dc75fbc94301dbd2b1b5d2b29a87dd3d6865c16, disposition92–126, private identity252, emitted row254–260, returned body428–439; FileStoppedSnapshotResolver.ts f54d3ed4cfc1236e7201c5bf539350368ce72b96, stage80–132; FileStoppedTeamImport.ts d8fa3540a2e1d999aca96e04284d2876d527d991, intent.snapshot55/371, skip292, census356.

The private first/second source census and the emitted file row are separate objects. Only the emitted verifier is being removed. No random nonce, new salt, KDF, substitute checksum, companion journal or mutable cache is needed.

## Fresh format and legacy branch

Canonical exportStoppedTeam emits snapshot schemaVersion:2 after this change.

A V2 excluded row has exactly these own data fields:
{ category:<existing ImportCategory>, path:<existing safe relative path>, size:<actual bounded nonnegative integer byte length>, disposition:'excluded' }

It has no sha256, base64, checksum, fingerprint, opaque placeholder or other field. Both a secret-derived hash and a constant/synthetic hash are invalid; an excluded row makes no content-checksum claim.

V2 product/archive rows retain their genuine current fields exactly:
{ category, path, sha256:<SHA256 of copied bytes>, size, disposition:'product'|'archive', base64:<exact canonical bytes> }

New V2 validation uses strict allowlists for the snapshot root, each file row and the existing roots/blobs/references records, plus the existing strict snapshotHeaderSchema. The root has only schemaVersion, header, roots, files, blobs, references and digest. Roots have category/exists/identity; blobs have originalPath/category/path; references have taskId/displayId/teamName/target. Existing safe-path, category, disposition classifier, cardinality, size, required configuration, reference/blob, base64 and content-integrity checks remain. In particular, a caller cannot relabel auth.json as archive, smuggle sha256 into an excluded row, or add another fast verifier under an unknown property.

The snapshot digest stays the existing structural digest of its versioned serialized body. For V2, no private excluded-content observation enters that body. No new digest algorithm or alternate identity authority is introduced.

V1 is an explicit retained branch. Keep its current validation semantics and exact hash/serialization recipe; do not remove hashes, strengthen unrelated old allowlists, relabel, rewrite or upgrade original V1 bytes on read. Unknown snapshot versions hold. A V1 row cannot become V2 by changing only schemaVersion, and V2 excluded rows cannot be treated as old rows with an invented SHA.

Types preserve the existing public names and encode the branch rather than merely making every checksum optional. The intended structural contract (existing SnapshotCommon fields unchanged) is:

```ts
type SnapshotFileBase = { category: ImportCategory; path: string; size: number };
type LegacySnapshotFile = SnapshotFileBase & {
  disposition: 'product' | 'archive' | 'excluded';
  sha256: string;
  base64?: string;
};
type CopiedSnapshotFile = SnapshotFileBase & {
  disposition: 'product' | 'archive';
  sha256: string;
  base64: string;
};
type ExcludedSnapshotFile = SnapshotFileBase & {
  disposition: 'excluded';
  sha256?: never;
  base64?: never;
};
export type SnapshotFile =
  | LegacySnapshotFile | CopiedSnapshotFile | ExcludedSnapshotFile;
export type StoppedTeamSnapshot = SnapshotCommon & (
  | { schemaVersion: 1; files: LegacySnapshotFile[] }
  | { schemaVersion: 2; files: (CopiedSnapshotFile | ExcludedSnapshotFile)[] }
);
```

SnapshotCommon contains the existing header/roots/blobs/references/digest fields, with identical types. Fresh captureFiles has the V2 files type. Version-specific validation narrows the snapshot before examining its rows; shared non-version checks can still receive SnapshotFile. The optional-never fields keep existing common property access type-safe, but the V2 runtime decoder rejects their own-property presence even if a caller supplies undefined. Internal aliases are sufficient; no new wire method, public export name or renderer field is required.

## Source reads and original authority

Excluded content is not required by detached import, reference validation, attachment extraction or product installation: those consumers skip excluded rows before copied-byte/hash processing. Nevertheless, the current exporter promises two exhaustive, fenced byte censuses, not merely a path/size check.

For this narrow correction, retain the current bounded open/read/fstat and private SHA in captureFiles.identities for excluded files. Retain the existing source/header reread, root/file identity and directory census checks, and the comparison of both full private captures. Do not serialize identities or a digest of identities, and do not retain the excluded raw buffer after its existing local read scope. This keeps a same-size excluded-content mutation DURING one export a refusal without adding any new persisted verifier.

An excluded-file change BETWEEN two independently successful exports may now yield the same V2 snapshotDigest when path/size, header and all transported product/archive bytes are unchanged. This is intended: excluded content grants no imported authority and is not transported. Do not reintroduce a nonce/hash merely to preserve the old artificial distinction.

All original bounds stay unchanged: 4,096 files, existing traversal-entry bound, 20 MiB per file and 64 MiB total observed bytes, including excluded bytes. No extra pass or larger I/O budget is introduced. FileStoppedSnapshotResolver's 96-MiB artifact cap and 256-file namespace cap stay unchanged.

## Consumer compatibility and minimality

FileStoppedTeamImport already skips excluded rows at292. Its source.json census at356 spreads the validated row after dropping base64, so the V2 row naturally omits sha256 there too. The source.json/import-intent schemaVersion:1 identifies those separate publication maps, not the nested snapshot-file format; do not bump or rewrite them. Import intent read reconstructs the exact expected publication from its saved versioned snapshot. Its existing checksum of actual source.json bytes remains a real checksum of transported metadata, without the removed per-excluded-file content hashes in fresh V2. The separately produced header.sourceRevision is unchanged and is not claimed protected by this correction.

FileStoppedSnapshotResolver already validates the nested snapshot, keys it by exact original snapshotDigest, compares exact existing artifact bytes, and returns the original digest. No version-specific code there needs changing.

Existing publish/lookup/retry/list and Main original lookup ordering stay unchanged. Existing original V1 lookup/retry works after source/staging disappearance; it does not call fresh export or substitute a new V2 snapshot. A changed request for an existing command remains a conflict. No read-side repair, receipt rewrite, new owner or source/native effect is added.

Production manifest is exactly two existing files:
1. packages/legacy-agent-host/src/stopped-team-import/contracts.ts — versioned types; approximately 25–45 added lines.
2. packages/legacy-agent-host/src/stopped-team-import/snapshot.ts — V2 fresh row/export and strict V2 decoder branch, reusing common checks; approximately 50–90 added lines. Current554 lines remains below800.

Read-only checked consumers: FileStoppedSnapshotResolver.ts, FileStoppedTeamImport.ts, importPublication.ts, references.ts, stoppedTeamImportRoutes.ts, index.ts, composition/createStoppedImportComposition.ts, Main prepareStoppedLegacyImport.ts and importStoppedLegacyTeam.ts. No edits to those paths are proposed. If implementation reveals an additional version-specific consumer, stop and amend the manifest before changing it.

Test edits are confined to the existing packages/legacy-agent-host/tests/stopped-team-import.test.ts, reusing its real-file fixture and actual exporter/resolver/importer. Its existing assertion requiring SHA for excluded Main ownership rows at443 must change to the new metadata-only contract. Existing stopped-team-import-rpc.test.ts and import-publication.test.ts are validation cohorts, not planned edit paths.

## Finite baseline and regression gates

Before production changes, preserve a canonical V1 snapshot vector and its exact digest from the unchanged exporter using a minimal TEST-only source with no absolute attachment mappings. Retain that original vector as a fixed compatibility fixture, not a V2 export relabelled as V1. This original vector must still be captured and executed in the recovered environment before production changes.

1. Meaningful baseline RED: the existing real auth.json fixture is classified excluded and has no base64, but still carries sha256 and is copied into actual staged/intended census metadata. Assert the required fresh absence against unchanged compiled source. Failure must be the persisted verifier assertion, not a missing future type/export.
2. Fresh V2 end-to-end: actual export, validate, resolver stage/read, importer publication and source.json census contain exact excluded metadata and no raw bytes/raw-content SHA; copied task/archive/attachment integrity and normal product state remain unchanged.
3. Public/private separation: hold the fixture header (including sourceRevision), root metadata and all transported bytes constant; two successful exports differing only in equal-length TEST excluded auth bytes then have identical V2 snapshots/digests. A change during the second describe/census of ONE export still holds before any destination/staging publication. Existing header/root/cap/currentness refusals remain.
4. Strict V2 negatives: excluded sha256 (real or synthetic), base64, alternate checksum/unknown field; extra root/row field; wrong version/disposition; missing checksum or damaged base64 for copied rows. Recompute the outer digest in mutation controls so the test reaches the actual strict/semantic validator, rather than failing only the enclosing hash.
5. V1 byte compatibility: fixed original vector validates with exact original digest; real staging/cold read and importer original lookup/retry retain bytes and receipt identity, including after source/staging removal. No V2 mint or old receipt rewrite on those paths.
6. Integration control: existing real Host NDJSON import/cold lookup and import publication/restore tests pass unchanged, with the normal bounds and timeouts. No native launch or external credentials/services are required.

Only after the reviewed plan is published and execution is available: run the finite baseline, apply the two production changes and focused fixture edits, perform the normal canonical Host build plus changed test type/lint gates, then the three named test cohorts. Broaden tests only for an actual remaining failure. Do not label this source proposal, a mocked-only check or a skipped suite as runtime qualification.

## Review and execution status

The design was independently reviewed before recovery and is being published before implementation. Recheck the exact three source/test paths at implementation handoff. Preserve the finite RED, original V1 compatibility vector and actual exporter/resolver/importer validation; source review alone is not an execution result.
