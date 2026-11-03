# Custom team templates

Turns a saved team configuration or an imported portable JSON file into a reusable template and keeps the library in the internal-storage SQLite worker. Save As uses a server-owned preview; imports validate the file content in the application use case. Both paths allocate local identities and content digests on the backend.

## Layout

- `contracts/` — browser-safe operation unions, transport addresses (`channels.ts`), persistence requests and the `CustomTeamTemplatesApi` interface.
- `core/domain` — name/description policy, allowlisted projection policy, canonical serialization.
- `core/application` — preview, save, re-check, list, management, import and export use cases plus the bounded preview store.
- `main/` — composition and the IPC/HTTP input adapters, which call the same use cases. The public entrypoint also works in the standalone server; Electron is loaded only when a native file dialog is requested.
- `preload/` — `createCustomTeamTemplatesBridge`, registered as `window.electronAPI.customTeamTemplates`.
- `renderer/` — the user-facing surface (Phase 3B).

## Renderer surface

`renderer/index.ts` exports the two statically imported list actions plus the
creation picker, and nothing else:

- `SaveAsTemplateAction` — team-row action beside "Copy team". It renders nothing for a draft team, stops row navigation, and lazy-loads `SaveAsTemplateDialog`.
- `MyTemplatesAction` — team-list header action that lazy-loads `MyTemplatesDialog`.
- `CreateTeamTemplatePicker` — small dialog-free control rendered inline by the
  Create Team dialog. It prefills the existing creation form from a built-in
  catalogue entry or a saved custom template and sends no creation request
  itself; creation still goes through the dialog's unchanged `team:create` /
  `team:createConfig` path, so all team and member identities stay
  backend-generated.

Both dialogs are imported with `lazy()` so their code stays in its own chunk.

- `ui/SaveAsTemplateDialog.tsx` — shows the exact allowlisted preview (source team, team prompt, members with role/workflow, typed warnings) and lets the user edit only the template name and description. Every typed prepare/save/re-check outcome is rendered as its own state: blocked roster/source with Retry, inline name conflict with the typed fields preserved, stale preview refreshed through the API and requiring a renewed confirmation, and an unresolved write offering Re-check instead of a second create. Success is only ever shown for a confirmed `created`, `alreadySaved` or re-check `saved` result.
- `ui/MyTemplatesDialog.tsx` — library with edit, duplicate, delete, import and export actions. Empty, ready, partial, unavailable storage and failed requests have distinct presentations; the list is re-read on every open and after mutations.
- `hooks/useSaveAsTemplate.ts` — the prepare/save/re-check state machine (single in-flight request, request-sequence guards).
- `hooks/useCustomTemplateLibrary.ts` — the list read with the same request-sequence guard.
- `templateDraft.ts` — pure mapping from a picker selection to an
  `applyTeamTemplate`-compatible draft. Only allowlisted content
  (`description`, `teamPrompt`, member `name`/`role`/`workflow`) is copied into
  fresh objects; no template identity, revision, task, message, session or
  history survives, and unknown built-in ids never resolve.

Both dialogs reach the API only through `api` from `@renderer/api`, so Electron IPC and browser HTTP behave identically.

## Portable import and export

The JSON file contains `format: "agent-teams-custom-template"`, `schemaVersion: 1`, `name`, optional `description`, `teamPrompt` and ordered `members` with `name`, optional `role` and optional `workflow`. Local ids, revisions, timestamps and hashes are excluded. Export produces deterministic UTF-8 JSON; import accepts UTF-8 with or without a BOM and applies the existing content limits and normalization.

- `ui/ImportCustomTeamTemplateDialog.tsx` — file selection, validation feedback and duplicate-name rename flow. A conflict preserves the validated content for a retry under a new name; it never overwrites the existing template. A possibly committed write blocks another submission until the user closes the dialog and checks the library.
- `ui/ExportCustomTeamTemplateDialog.tsx` — exports a saved custom template through the available desktop or browser file capability.
- `main/services/CustomTeamTemplateDesktopFileService.ts` — native file workflow using the same import/export use cases. Paths stay in the main process; reads are bounded and exports use an exclusive temporary file followed by an atomic rename.
- `renderer/adapters/browserCustomTeamTemplatesFile.ts` — browser `File` reads and JSON downloads. The HTTP adapter distinguishes serialization failures before dispatch from uncertain outcomes after dispatch.

Focused coverage lives in `test/features/custom-team-templates/` and beside the renderer adapters and dialogs. It covers file validation, portable projection, name conflicts, write uncertainty, native file operations and standalone entrypoint loading.

## Localization

Strings live in the `customTemplates` group of `team.json`. Import/export messages are present in all 29 locale catalogs; missing messages use the existing English fallback (`fallbackLng`). Regenerate `resources.d.ts` with `pnpm i18n:types`.
