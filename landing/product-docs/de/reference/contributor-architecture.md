---
title: Architektur für Mitwirkende – Agent Teams Dokumentation
description: Leitfaden für Mitwirkende zum Feature-Aufbau, den Grenzen zwischen Runtime und Anbieter, harten Guardrails und den kanonischen Architekturdokumenten.
lang: de-DE
---

# Architektur für Mitwirkende

Diese Seite ist eine Landkarte für Mitwirkende. Sie verweist auf die kanonische Repo-Anleitung, anstatt jede Implementierungsregel erneut darzustellen.

## Kanonische Quellen

Verwenden Sie diese Dateien als Quelle der Wahrheit, wenn Sie die App ändern:

| Bedarf | Kanonische Quelle |
| --- | --- |
| Repo-Übersicht und Befehle | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Lokale Arbeitskonventionen | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Harte Guardrails | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Aufbau mittelgroßer und großer Features | [docs/FEATURE_ARCHITECTURE_STANDARD.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Debugging von Agent-Team-Starts | [docs/team-management/debugging-agent-teams.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |

## Feature-Aufbau

Mittelgroße und große Features sollten unter `src/features/<feature-name>/` liegen und dem Feature-Architekturstandard folgen. Halten Sie die Interna eines Features hinter öffentlichen Einstiegspunkten und vermeiden Sie tiefe Importe über Feature-Grenzen hinweg.

Beginnen Sie bei neuer Arbeit mit dem vorhandenen Slice `src/features/recent-projects` als lokaler Referenzimplementierung. Kleine Fixes können nahe am bestehenden Codepfad bleiben, wenn das Erstellen eines Feature-Slice mehr Struktur als Nutzen brächte.

## Grenzen zwischen Runtime und Anbieter

Agent Teams ist für die Orchestrierung zuständig: Teams, Aufgaben, Nachrichten, Startzustand, Review-UI, Diagnostik und lokale Persistenz.

Der ausgewählte Runtime-/Anbieterpfad ist für Modellausführung, Authentifizierung, Modellverfügbarkeit, Ratenbegrenzungen, Tool-Semantik und runtime-spezifische Transkript-Nachweise zuständig. Lassen Sie Prompts oder UI-Zustand nicht für fehlende Authentifizierung, fehlende Binärdateien, abgelehnte Modell-IDs oder Anbieterausfälle kompensieren. Details zur nutzerseitigen Einrichtung finden Sie unter [Anbieter und Runtimes](/de/reference/providers-runtimes).

## Debugging von Agent-Teams

Beginnen Sie bei hängenden Starts, OpenCode-Zuständen `registered` / Bootstrap-unbestätigt, ausbleibenden Antworten von Teammitgliedern oder verdächtigen Aufgabenprotokollen mit dem dedizierten Debugging-Runbook. Untersuchen Sie das neueste Start-Fehler-Artefakt unter `~/.claude/teams/<team>/launch-failure-artifacts/latest.json` und korrelieren Sie anschließend den UI-Zustand mit den persistierten Dateien und runtime-spezifischen Nachweisen.

Vermeiden Sie umfangreiche Aufräumarbeiten während des Debuggings. Stoppen Sie nur den Prozess, die Lane, das Team oder den Smoke-Run, den Sie dem Problem zuordnen können.

## Konventionen für Mitwirkende

- Verwenden Sie `pnpm dev` für die Desktop-Electron-App während der normalen Entwicklung.
- Verwenden Sie den Browser-Dev-Modus nicht als Ersatz für Desktop-Runtime, IPC, Terminal, Anbieter-Authentifizierung oder das Verhalten des Team-Lebenszyklus.
- Halten Sie die Verantwortlichkeiten von Electron-Main, Preload, Renderer, Shared und Feature getrennt.
- Verwenden Sie `wrapAgentBlock(text)` für reine Agent-Blöcke, anstatt Marker manuell zu verketten.
- Bevorzugen Sie eine fokussierte Verifizierung. Vermeiden Sie umfangreiche `lint:fix`- oder Formatierungsänderungen, sofern die Aufgabe nicht ausdrücklich die Formatierung betrifft.
- Behandeln Sie Parsing, Aufgaben-Lebenszyklus, Anbieter-/Runtime-Erkennung, Persistenz, IPC, Git und Review-Abläufe als Hochrisikobereiche, die gezielte Tests oder einen klaren Verifizierungspfad benötigen.

## Verwandte Seiten

- [Runtime-Einrichtung](/de/guide/runtime-setup)
- [Fehlerbehebung](/de/guide/troubleshooting)
- [Code-Review](/de/guide/code-review)
- [Datenschutz und lokale Daten](/de/reference/privacy-local-data)
