---
title: Agent Teams Dokumentation – KI-Agententeams aus einer lokalen Desktop-App ausführen
description: Dokumentation für Agent Teams, eine kostenlose Desktop-App zur Orchestrierung von KI-Agenten. Erstellen Sie Teams, verfolgen Sie die Arbeit auf einem Kanban-Board, überprüfen Sie Codeänderungen und koordinieren Sie Claude-, Codex-, OpenCode- und Multimodell-Workflows.
lang: de-DE
layout: home
hero:
  name: Agent Teams Dokumentation
  text: KI-Agententeams aus einer lokalen Desktop-App ausführen
  tagline: Erstellen Sie Teams, verfolgen Sie, wie sich die Arbeit über ein Kanban-Board bewegt, überprüfen Sie Codeänderungen und koordinieren Sie Claude-, Codex-, OpenCode- und Multimodell-Workflows, ohne die lokale Kontrolle aufzugeben.
  actions:
    - theme: brand
      text: Schnellstart
      link: /de/guide/quickstart
    - theme: alt
      text: Installieren
      link: /de/guide/installation
    - theme: alt
      text: Konzepte
      link: /de/reference/concepts
features:
  - icon: '01'
    title: Team-orientierter Workflow
    details: Definieren Sie Rollen, starten Sie einen Lead und lassen Sie Agenten Aufgaben aufteilen, übernehmen und koordinieren.
    link: /de/guide/create-team
    linkText: Team erstellen
  - icon: '02'
    title: Live-Kanban-Board
    details: Verfolgen Sie, wie Aufgaben durch todo, in progress, review, done und approved wandern, während die Agenten arbeiten.
    link: /de/guide/agent-workflow
    linkText: Workflow verstehen
  - icon: '03'
    title: Integriertes Code-Review
    details: Untersuchen Sie aufgabenbezogene Diffs, akzeptieren oder verwerfen Sie Hunks und kommentieren Sie dort, wo Agenten eine Richtung brauchen.
    link: /de/guide/code-review
    linkText: Änderungen überprüfen
  - icon: '04'
    title: Runtime-bewusste Einrichtung
    details: Nutzen Sie Claude, Codex, OpenCode oder Multimodell-Anbieter über den Zugang, den Sie bereits haben.
    link: /de/guide/runtime-setup
    linkText: Runtimes konfigurieren
  - icon: '05'
    title: Local-first-Kontrolle
    details: Die Desktop-App liest den lokalen Projekt- und Runtime-Zustand. Ihr Code bleibt auf Ihrem Rechner, sofern nicht ein ausgewählter Anbieter Prompt-Kontext erhält.
    link: /de/reference/privacy-local-data
    linkText: Datenschutzmodell
  - icon: '06'
    title: Debugbare Teams
    details: Verfolgen Sie Aufgabenprotokolle, Runtime-Ausgaben, Teamkollegen-Nachrichten und laufende Prozesse, wenn ein Start oder eine Aufgabe hängen bleibt.
    link: /de/guide/troubleshooting
    linkText: Fehler beheben
---

<InstallBlock label="Kopieren" copied-label="Kopiert" />

## Hier starten

Agent Teams ist eine kostenlose Desktop-App zur Orchestrierung von KI-Agententeams. Sie senden nicht nur isolierte Prompts an einen einzelnen Agenten: Sie erstellen ein Team, weisen Rollen zu und verfolgen, wie Agenten ihre Arbeit über ein Aufgaben-Board koordinieren.

<DocsCardGrid />

## Nächste Schritte nach dem Start

Nachdem Sie Ihr erstes Team erstellt haben, erkunden Sie diese Anleitungen, um weiterzukommen:

- **Runtime-Einrichtung** - konfigurieren Sie Claude-, Codex-, OpenCode- oder Multimodell-Anbieter: [Runtimes konfigurieren](/de/guide/runtime-setup)
- **Agent-Workflow** - verstehen Sie, wie Agenten ihre Arbeit über das Aufgaben-Board koordinieren: [Workflow verstehen](/de/guide/agent-workflow)
- **Team-Briefing-Beispiele** - lernen Sie Prompt-Muster anhand realer Briefings: [Beispiele ansehen](/de/guide/team-brief-examples)
- **Code-Review** - untersuchen Sie Diffs, akzeptieren oder verwerfen Sie Änderungen: [Änderungen überprüfen](/de/guide/code-review)
- **Fehlerbehebung** - diagnostizieren Sie hängende Starts, fehlende Teamkollegen und fehlgeschlagene Aufgaben: [Fehler beheben](/de/guide/troubleshooting)
- **Git- und Worktree-Strategie** - nutzen Sie Worktree-Isolation, wenn mehrere Teamkollegen parallel dasselbe Repository bearbeiten: [Mehr über Worktrees erfahren](/de/guide/git-worktree-strategy)
- **Versionshinweise** - sehen Sie, was in jeder Version neu ist: [Releases ansehen](/de/reference/release-notes)

## Referenz

Nutzen Sie die Referenzseiten, wenn Sie exakte Terminologie, das Anbieterverhalten, die Architektur für Mitwirkende oder Datenschutzgrenzen benötigen.

<DocsCardGrid type="reference" />

## Produktvorschau

<ZoomImage src="/screenshots/product-preview.png" alt="Agent Teams Kanban-Board" caption="Aufgabenstatus, Teamkollegen-Aktivität und Review-Workflow bleiben in einem Arbeitsbereich sichtbar." />
