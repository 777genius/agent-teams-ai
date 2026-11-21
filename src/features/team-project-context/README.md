# Team project context

The feature separates a team **definition** from its project-specific **work history**.

- `contracts/` owns the browser-safe history-mode type.
- `core/` owns the two distinct defaults: existing persisted teams without a field remain shared; newly created teams default to `per_project`.
- The intended application boundary maps a verified logical team and selected project to a native-compatible physical execution team. Do not use a UI filter as isolation.
- Do not create physical contexts merely to read, or infer ownership from an alias prefix.
- Runtime/storage/renderer integration must not expose `per_project` as working until real inbox/task/session isolation is proven.

See [the reviewed implementation plan in Draft PR #1215](https://github.com/777genius/agent-teams-ai/pull/1215/files) in the plan PR #1215.

## What a team name is (one place for each question)

Every caller that has to treat a logical team, a project copy and an ordinary team differently asks these three questions through the same code. Do not re-implement them with a raw `meta.projectContextMode` check or a `list`/`listRetained` ternary.

| Question | Where | Policy on unreadable state |
| --- | --- | --- |
| What mode is the team in? | `main/projectContextMode.ts` `readTeamProjectContextMode` (`TeamProjectContextRuntimeResolver.getMode` delegates) | throws `TeamMetadataUnreadableError` for a file that exists but cannot be read, and the parse error for an unknown mode value; a caller may name what it refuses, the decision is the same |
| Which project contexts does it own, and does it carry history at all? | `main/ownedHistory.ts` `listOwnedContexts`, `ownsProjectHistory` | `listOwnedContexts` goes through the registry, which throws for a damaged or deleting index; `ownsProjectHistory` only checks that the index file exists (no read, never throws for a damaged index) |
| Logical team, project copy or ordinary team? | `core/classifyTeamKind.ts` `classifyTeamKind` and `createTeamKindPorts`; the `TeamKind` type is in `contracts/` (edit router, editor, schedules, launch, external team management) | fails closed |
| Which physical team receives a cross-team message? | `main/crossTeamRecipient.ts` `resolveCrossTeamRecipient` (`CrossTeamService`, OpenCode runtime delivery through `TeamProvisioningRuntimeDeliveryIdentity.ts`, and the cross-team HTTP routes the MCP tools use): a per-project team receives through its ready copy for the sender's project, never another one, and never a new one; a copy named exactly receives unless it belongs to the sender's own team, never finished its launch, or its team is being deleted or moved to trash; a damaged contexts index refuses messages to copies (deliberate) | refuses with `CrossTeamRecipientError` (code and what to do) |
| How is a project copy shown to a person, and which team does it belong to? | `core/projectCopyOwner.ts` `findProjectCopyOwner`, `formatProjectCopyLabel`, over the folded team list: cross-team targets in main; badges and the composer through `renderer/` (`useTeamDisplayLabel`, `useProjectCopyOwnerName`, `TeamDisplayLabel`) | an unknown name is shown as is |

Two vocabularies, on purpose. `TeamKind` (`logical` / `alias` / `native`) tells an **owned project copy** (`alias`) from an ordinary team (`native`), because edits, schedules and launch refuse a copy. `ResolvedTeamTarget.kind` (`logical` / `physical`) answers a different question for HTTP and MCP that take names literally: has the name a process of its own. A project copy is `physical` there (its name is the process) and `alias` in `TeamKind`; a retained shared team is `native` in `TeamKind` and `physical` with `retained` contexts in `ResolvedTeamTarget`.

Policies that are deliberately more tolerant than the fail-closed classification, each by name:
- `main/resolveTeamTarget.ts`: an HTTP/MCP caller may stop a team by its exact name when its metadata is unreadable and it has no contexts index (`projectContextUnresolved`);
- `main/projectTeamSummaries.ts`: a team whose metadata cannot be read stays visible and is not folded;
- `projectAliveTeamNames` in `src/main/ipc/teams/teamContextLifecycle.ts`: one unreadable team does not hide the alive state of the others.

Deliberately left alone, with the reason: `main/TeamProjectContextViewIpc.ts` needs the alias lookup data (logical name, project path), not a yes/no; the HTTP launch route (`src/main/http/teams/teamLaunchRoute.ts`) refuses a `ptc-` name by its shape before it classifies, which is stricter than ownership; `TeamProjectDefinitionBackup.ts` decides from the raw files of a snapshot it is reading (`hasIndex` and `projectContextMode` come from the same read, so asking the registry again would be a second read); `readRosterForMutation` in `teamProjectDefinitionEdit.ts` and `TeamConfigurationMutations` need the metadata record itself; the create paths read a request field, not a stored team; the MCP server is a separate package.

A new consumer adds a capability on top of these primitives; it does not add a branch to them.

Launching a logical team has one use case for every transport: `launchInProjectContext` in `main/projectContextLaunch.ts` (override check with the parser HTTP uses, then the `prepare` port: reservation, launch gate, materialization; then the transport launches the copy and the run is remembered under the team). The desktop IPC binds it in `src/main/ipc/teams/teamProjectContextLaunch.ts` (`withPreparedContextLaunch`); HTTP and MCP get a `ProjectTeamLaunch` port composed in `src/main/teamProjectContextLaunchPort.ts`, so `src/main/http` does not import the IPC layer. The run identity of a copy (`main/projectRunIdentity.ts`) is a pure in-memory map used by every transport. Known debt: the runtime parts and `prepareTeamContextLaunch` are application code that still lives in `src/main/ipc/teams/`; the composition module imports them from there until they move into `main/`. A schedule never creates a copy, so it calls `prepareTeamContextLaunch` with the copy it expects.

`test/features/team-project-context/teamKindMatrix.test.ts` pins what every consumer answers for each kind of name on the same on-disk state, read through the real metadata store.
