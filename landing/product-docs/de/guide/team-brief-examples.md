---
title: Team-Briefing-Beispiele – Agent Teams Dokumentation
description: Praktische Team-Briefing-Vorlagen für kleine Korrekturen, Dokumentationsarbeit, Implementierungsaufgaben, Reviews und Hochrisikobereiche.
lang: de-DE
---

# Team-Briefing-Beispiele

Ein gutes Team-Briefing gibt dem Lead genug Struktur, um kleine Aufgaben zu erstellen, ohne jedes Implementierungsdetail im Voraus festzulegen.

Verwenden Sie folgendes Schema:

```text
Outcome:
Scope:
Boundaries:
Coordination:
Verification:
Review:
```

## Minimales Briefing

Für kleine, risikoarme Arbeiten verwenden.

```text
Outcome: Improve the quickstart so a new user can launch one team successfully.
Scope: Keep edits inside landing/product-docs.
Boundaries: Do not rewrite the whole docs structure.
Coordination: Create one or two tasks, keep comments on the task.
Verification: Run `pnpm --dir landing docs:build`.
Review: Summarize changed pages and any remaining gaps.
```

## Implementierungs-Briefing

Verwenden, wenn Codeänderungen einen Funktionsbereich betreffen.

```text
Outcome: Add a focused improvement to task comment filtering.
Scope: Work inside the task/comment feature files unless a shared helper is clearly needed.
Boundaries: Do not change task storage format or review state semantics.
Coordination: Split parser, UI, and tests into separate tasks if they can be reviewed independently.
Verification: Run the focused unit tests first, then the feature typecheck if touched.
Review: Call out parsing edge cases and any behavior that affects existing task comments.
```

## Dokumentations-Briefing

Für Dokumentations- und Anleitungsarbeit verwenden.

```text
Outcome: Draft practical workflow guides from the docs audit.
Scope: Add concise VitePress pages under landing/product-docs/guide.
Boundaries: Avoid moving existing navigation hubs owned by other tasks.
Coordination: Check related docs tasks before editing nav.
Verification: Run `pnpm --dir landing docs:build`.
Review: Include links added to sidebar and any pages intentionally left as drafts.
```

## Review-intensives Briefing

Für riskante Bereiche wie IPC, Anbieter-Authentifizierung, Persistenz, Git oder Logik des Aufgaben-Lebenszyklus verwenden.

```text
Outcome: Fix the launch failure without changing successful launch behavior.
Scope: Start from the newest launch-failure artifact and the affected runtime adapter.
Boundaries: Do not change provider prompts until setup and runtime evidence are inspected.
Coordination: Make one diagnostic task and one fix task if the cause is confirmed.
Verification: Run focused tests and one desktop smoke check when practical.
Review: Lead must inspect the diff before approval.
```

## Briefing für gemischte Anbieter

Verwenden, wenn Teammitglieder unterschiedliche Anbieter-/Modell-Lanes nutzen.

```text
Outcome: Implement and review a small feature using separate builder and reviewer lanes.
Scope: Builder edits the feature. Reviewer inspects only the task diff and tests.
Boundaries: Do not switch model ids mid-task unless launch fails before work begins.
Coordination: Builder posts result comment first. Reviewer posts findings as task comments.
Verification: Builder runs focused tests. Reviewer checks failure output and changed scope.
Review: Lead approves only after reviewer comments are resolved.
```

## Agent-Blöcke in Briefings

Agent-Blöcke sind versteckter, ausschließlich für Agenten bestimmter Text, der in Markierungen wie `<info_for_agent>...</info_for_agent>` eingeschlossen ist. Die App entfernt sie aus der normalen Anzeige, hält sie aber für die Agentenkoordination verfügbar. Verwenden Sie sie, wenn das Briefing den Agenten etwas mitteilen muss, das für einen menschlichen Leser nur Rauschen wäre.

Beispiel – ein Briefing, das dem Lead mitteilt, wie die Arbeit aufgeteilt werden soll, ohne die Koordinationsanweisungen dem Benutzer preiszugeben:

```text
Outcome: Add a dark mode toggle to the application settings.
Scope: Settings UI, theme context, and CSS variables.
Boundaries: Do not change existing light theme values or provider auth screens.

<info_for_agent>
Split this into three tasks: (1) theme context and CSS vars, (2) toggle component and settings wiring, (3) dark mode preview in existing docs screenshots if practical.
</info_for_agent>
```

Der Block hält das an Menschen gerichtete Briefing übersichtlich und gibt dem Lead gleichzeitig eine strukturierte Anleitung zur Aufgabenaufteilung.

## Was zu vermeiden ist

| Schwaches Briefing | Bessere Alternative |
| --- | --- |
| „Verbessere die App" | Benennen Sie den Workflow, die Dateien und die Erfolgsprüfung |
| „Behebe alle Docs" | Wählen Sie eine Anleitungsgruppe und einen Build-Befehl |
| „Nutze das beste Modell" | Benennen Sie Anbieter-/Modellauswahl oder lassen Sie die App-Standards gelten |
| „Refaktoriere nach Bedarf" | Geben Sie an, welche Module geändert werden dürfen |
| „Mach es produktionsreif" | Definieren Sie Review, Tests und Rollout-Prüfungen |

## Vor dem Start

Prüfen Sie diese Punkte, bevor Sie das Team starten:

1. Das Briefing benennt ein konkretes Ergebnis.
2. Risikogrenzen sind explizit.
3. Der Lead kann die Arbeit in überprüfbare Aufgaben aufteilen.
4. Verifizierungsbefehle sind enthalten, sofern bekannt.
5. Sensible Bereiche erfordern eine Überprüfung vor der Freigabe.

Wenn das Briefing noch zu breit ist, starten Sie zunächst einen Solo-Agenten oder ein kleines Team und bitten Sie es, einen Aufgabenplan statt einer Implementierung zu erstellen.

## Verwandte Anleitungen

- [Team erstellen](/de/guide/create-team)
- [MCP-Integration](/de/guide/mcp-integration)
- [Git- und Worktree-Strategie](/de/guide/git-worktree-strategy)
