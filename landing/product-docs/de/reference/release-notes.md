---
title: Versionshinweise – Agent Teams Dokumentation
description: Versionshinweise und Changelog für Agent Teams. Verweist auf die maßgeblichen Dateien RELEASE.md und CHANGELOG.md mit allen Details.
lang: de-DE
---

# Versionshinweise

Aktuelle Version: **v1.2.0** (2026-03-31). Die aktive Entwicklung läuft weiter auf dem `main`-Branch mit unveröffentlichten Änderungen für die Arbeitssynchronisierung von Mitgliedern, die Härtung der OpenCode-Auslieferung und die CI-Stabilisierung.

## So funktionieren Releases

Agent Teams folgt der [semantischen Versionierung](https://semver.org/). Tags, die in das Repository gepusht werden, lösen einen automatisierten [Release-Workflow](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) aus, der signierte Pakete für macOS, Windows und Linux erstellt und sie anschließend in GitHub Releases veröffentlicht.

## Aktuelle Releases

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
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | Vollständiges Changelog mit allen Versionen, Funktionen, Verbesserungen und Fehlerbehebungen aus Benutzersicht. |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | Herunterladbare Installationsprogramme für alle Plattformen. |

## Verwandte Seiten

- [Installation](/de/guide/installation)
- [Schnellstart](/de/guide/quickstart)
- [Architektur für Mitwirkende](/de/reference/contributor-architecture)
- [Entwickler](/de/developers/)
