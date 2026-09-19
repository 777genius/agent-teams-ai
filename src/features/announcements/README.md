# Announcements

Desktop feature for static Markdown news published with the landing site. The production catalog starts empty and automatic display is disabled.

## Public surfaces

- `contracts`: browser-safe DTOs, API fragment, IPC channels and limits.
- `main`: feature composition and IPC registration. `src/main/announcementsLifecycle.ts` supplies actual main-window and power events.
- `preload`: typed announcement bridge; HTTP mode exposes an unavailable capability.
- `renderer`: global `AnnouncementHost`, history navigation and the editor's News button.

`core/domain` owns metadata/state normalization, cohort eligibility, latest-only selection and monotonic consumption. `core/application/ports.ts` defines clock, repository, source and ownership boundaries. Main application services coordinate runtime lifecycle and durable writes; infrastructure owns filesystem, process ownership and anonymous HTTP access.

## Behavior

Each profile stores accumulated open-window time and handled/dismissed IDs under `userData/data/announcements`. One owner writes a profile at a time. Usage counts the union of its main windows, including minimized windows, and excludes sleep or unexplained long timer gaps. Historical usage is not reconstructed for existing profiles.

An automatic article requires current-session feed validation, eligibility, foreground readiness and a durable claim. Consuming an article advances a persistent ordering floor, so closing the newest article never starts a backlog of older popups. A crash after the claim may skip that automatic presentation; manual history remains available. Editing an existing ID does not create another automatic presentation.

Raw HTML is disabled. Markdown reuses existing presentation components with separate URL rules: HTTPS external links and images within the article's published asset bundle. Local file, task, team and command navigation is unavailable in this content.

Default development runs do not fetch production announcements. An explicit loopback fixture URL is accepted only with both isolated dev profile roots; production uses the fixed HTTPS source.

## Authoring and verification

- [Implementation contract](../../../docs/announcements-implementation-plan.md)
- [Publishing runbook](../../../scripts/announcements/README.md)
- [Isolated desktop QA](../../../docs/announcements-e2e-checklist.md)

Focused checks: `pnpm exec vitest run test/features/announcements`, `pnpm announcements:test`, `pnpm typecheck`. Shared overlay behavior is covered by `test/renderer/hooks/useOverlayOccupancy.test.tsx` and `test/renderer/components/ui/DialogContentFocusScope.test.tsx`.

The feature does not synchronize devices, display notifications while the app is closed, or publish telemetry about reading activity. Live hosting headers and first real publication must be verified during deployment using the publishing runbook.
