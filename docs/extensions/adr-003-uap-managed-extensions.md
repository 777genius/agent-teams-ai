# ADR-003: UAP-managed extensions alongside local Skills

**Date**: 2026-10-24
**Status**: Proposed; implementation under qualification

## Context

The user has requested installation and updates of universal plugin packages and
standalone Skills, including signed Directory discovery and direct source URLs.
ADR-001 defines native Claude marketplace identity. ADR-002 deliberately limited
its first phase to local Skill discovery and authoring. The new lifecycle must
preserve those identities and authoring workflows while adding managed remote
dependencies.

## Decision

1. UAP is the authority for managed acquisition, manifests, locks, native
   projections, updates, repair and recovery. Agent Teams does not parse or edit
   UAP state and does not implement a second installer in TypeScript.
2. Embed the existing Go engine as an owned local process using its versioned
   OpenAPI contract and TypeScript SDK. Generated wire types are shared by the
   browser-safe app contract; process bootstrap remains in main.
3. Add managed package controls to the existing Plugins tab and managed standalone
   Skills to the existing Skills tab. Reuse the current shell, Radix primitives,
   search and Markdown viewer. Preserve native `name@marketplace` plugin identity
   and the local Skills editor/import workflows.
4. Remote Skills are explicit dependencies. Their managed projections are read
   only to local authoring; editing requires a distinct unowned copy. Authoring
   mutations and ownership validation must occur under UAP's shared mutation lock
   when the target can overlap UAP projections.
5. Review the retained engine plan before mutation. Preserve one request identity
   through acceptance uncertainty; display actual terminal and recovery states.
   Startup/profile drift and runtime mutation admission are host responsibilities.
6. Vendor an exact SDK tarball and build native UAP from the same reviewed source
   commit during packaging. No public package release is implied by integration.

## Consequences and limits

ADR-002's no-remote-install restriction is superseded only for the managed
dependency path described here. Skills remain a separate product domain, and no
marketplace publishing or moderation system is introduced. The native Claude
marketplace remains separate from universal package ownership.

Project/worktree activation depends on the separately qualified UAP project
workstream. A working user-scope foundation is not evidence that a project or
worktree reads the intended locked environment. Full completion requires the
matrix and real Electron evidence in the integration plan, including local Skill
ownership races, packaging identity, keyboard access and narrow-window UX.
