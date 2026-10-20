# Custom team templates

Turns a saved team configuration into a reusable template and keeps the library in the internal-storage SQLite worker. The renderer never supplies the source team identity, the reviewed content, the template id or the content digest: only a preview token, an optional name/description edit and the re-check token cross the process boundary.

## Layout

- `contracts/` — browser-safe operation unions, transport addresses (`channels.ts`), persistence requests and the `CustomTeamTemplatesApi` interface.
- `core/domain` — name/description policy, allowlisted projection policy, canonical serialization.
- `core/application` — prepare, confirm-save, re-check and list use cases plus the bounded preview store.
- `main/` — composition and the IPC/HTTP input adapters, which call the same use cases.
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
- `ui/MyTemplatesDialog.tsx` — read-only library. `empty`, `ready`, `hasUnreadableRecords`, `storageUnavailable` and a failed request are five distinct presentations; the list is re-read on every open.
- `hooks/useSaveAsTemplate.ts` — the prepare/save/re-check state machine (single in-flight request, request-sequence guards).
- `hooks/useCustomTemplateLibrary.ts` — the list read with the same request-sequence guard.
- `templateDraft.ts` — pure mapping from a picker selection to an
  `applyTeamTemplate`-compatible draft. Only allowlisted content
  (`description`, `teamPrompt`, member `name`/`role`/`workflow`) is copied into
  fresh objects; no template identity, revision, task, message, session or
  history survives, and unknown built-in ids never resolve.

Both dialogs reach the API only through `api` from `@renderer/api`, so Electron IPC and browser HTTP behave identically.

## Localization

Strings live in the `customTemplates` group of `team.json`, in English and Russian; other locales use the existing English fallback (`fallbackLng`). Regenerate `resources.d.ts` with `pnpm i18n:types`.
