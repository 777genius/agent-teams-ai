---
title: Versionshinweise – Agent Teams Dokumentation
description: Versionshinweise und Changelog für Agent Teams. Verweist auf die maßgeblichen Dateien RELEASE.md und CHANGELOG.md mit allen Details.
lang: de-DE
---

# Versionshinweise

Zuletzt veröffentlichte Version: **[v2.15.0](https://github.com/777genius/agent-teams-ai/releases/tag/v2.15.0)** (2026-09-19). Die aktuelle Version und Downloads stehen unter [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases).

## So funktionieren Releases

Agent Teams folgt der [semantischen Versionierung](https://semver.org/). Der [Release-Workflow](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) wird manuell gestartet, erstellt Pakete für macOS, Windows und Linux und veröffentlicht sie anschließend in GitHub Releases.

## Neueste Version

### v2.15.0 - Arbeit fortsetzen, Einzelchats und lokale Modelle

Sie können festgefahrene Arbeit auf der Teamseite fortsetzen, mit Teammitgliedern einzeln in Messages chatten, zusätzliche lokale Modelle auswählen und Ollama ohne Projekt testen. Außerdem wurden die Sichtbarkeit lokaler Modelle und das Wiederaufnehmen von Restarbeit nach dem Stoppen gemischter Teams korrigiert. Siehe die [Versionshinweise zu v2.15.0](https://github.com/777genius/agent-teams-ai/releases/tag/v2.15.0).

## Frühere Versionen

### v1.2.0 — Agent Graph, Tool-Freigabe pro Team, interaktives AskUserQuestion

Agent Graph mit kraftgesteuerter Visualisierung und Kanban-Aufgabenlayout, Steuerungen für die Tool-Freigabe pro Team mit lesbaren Berechtigungsabfragen, Benachrichtigungen zu Aufgabenkommentaren und interaktive AskUserQuestion-Schaltflächen. Überarbeitung des Berechtigungssystems mit Vorabfreigabe von Write/Edit/NotebookEdit und Integration des MCP-Tool-Katalogs. Siehe [vollständiges Changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#120---2026-03-31).

### v1.1.0 — React 19 + Electron 40, vom Benutzer initiierte Aufgabenstarts

Migration auf React 19 + Electron 40, vom Benutzer initiierte Aufgabenstarts über das Kanban-Board, Leitfaden zur Behebung von Authentifizierungsproblemen, Syntaxhervorhebung für R/Ruby/PHP/SQL, 3-mal schnellere Transkriptsuche, Korrekturen für WSL-/Windows-Pfade und Behebung einer XSS-Sicherheitslücke. Siehe [vollständiges Changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#110---2026-03-25).

### v1.0.0 — Erste öffentliche Veröffentlichung

Erster stabiler Build: Zuverlässigkeit von CLI/Authentifizierung in paketierten Apps, IPC-Härtung, plattformübergreifende Paketierung mit signierten macOS-Builds, Governance-Dokumente für Open Source (LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY). Siehe [vollständiges Changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#100---2026-03-23).

## Maßgebliche Quellen

| Dokument | Beschreibung |
| --- | --- |
| [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) | Release-Prozess, Leitfaden zur Versionierung, Benennung von Artefakten, Einrichtung automatischer Updates und Vorlage für Versionshinweise. |
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | Historisches Changelog früherer Versionen; aktuelle Versionen stehen in GitHub Releases. |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | Herunterladbare Installationsprogramme für alle Plattformen. |

## Verwandte Seiten

- [Installation](/de/guide/installation)
- [Schnellstart](/de/guide/quickstart)
- [Architektur für Mitwirkende](/de/reference/contributor-architecture)
- [Entwickler](/de/developers/)
