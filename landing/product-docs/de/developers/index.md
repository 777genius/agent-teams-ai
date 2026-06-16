---
title: Entwickler-Hub – Agent Teams Dokumentation
description: Einstiegspunkt für Mitwirkende und Entwickler zur Architektur, zu den Guardrails, zum Debugging und zu den MCP-Erweiterungswegen von Agent Teams.
lang: de-DE
---

# Entwickler-Hub

Nutzen Sie diese Seite, wenn Sie Agent Teams selbst ändern, einen Team-Launch debuggen oder eine Runtime mit MCP-Tools erweitern möchten. Die folgenden Links verweisen auf die maßgeblichen Repo-Dokumente, damit die Implementierungsregeln an einer Stelle gebündelt bleiben.

## Hier starten

| Bedarf | Gehe zu |
| --- | --- |
| Repo-Überblick, Skripte und Quellcode-Einrichtung | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Agent-Navigation und Architektur-Index | [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) |
| Arbeitskonventionen für Agenten und Mitwirkende | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Strikte Implementierungs-Guardrails | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Aufbau mittlerer und großer Features | [Feature-Architektur-Standard](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Debugging von Launch, Bootstrap und Teammate-Messaging | [Runbook für das Debugging von Agent-Teams](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |
| Beitragsprozess | [Leitfaden für Beiträge](https://github.com/777genius/agent-teams-ai/blob/main/.github/CONTRIBUTING.md) |
| Versionshinweise / Changelog | [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) — [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) |

## Lokaler Entwicklungsweg

Führen Sie die Electron-Desktop-App für die normale Entwicklung aus:

```bash
pnpm install
pnpm dev
```

Der Browser-/Web-Weg ist kein Ersatz für die Desktop-Runtime. Der Desktop-Modus ist der unterstützte lokale Weg, da er IPC, Terminals, Anbieter-Authentifizierung, die Verwaltung des Team-Lebenszyklus, Launch-Diagnosen und die von echten Teams genutzten Runtime-Bridges umfasst.

## Architektur-Checkpoints

Bevor Sie ein Feature ändern, bestimmen Sie seine Grenze:

| Bereich | Erwarteter Speicherort |
| --- | --- |
| Mittleres oder großes Produkt-Feature | `src/features/<feature-name>/` |
| Orchestrierung im Electron-Hauptprozess | `src/main/` |
| Preload-sichere API-Oberfläche | `src/preload/` |
| Renderer-UI und App-Zustand | `src/renderer/` |
| Geteilte Typen und reine Hilfsfunktionen | `src/shared/` |
| MCP-Server des Agent-Teams-Boards | `mcp-server/` |
| Board-Datencontroller | `agent-teams-controller/` |

Verwenden Sie `src/features/recent-projects` als Referenz-Slice für die Feature-Organisation. Halten Sie prozessübergreifende Verträge explizit und vermeiden Sie tiefe Imports über Feature-Grenzen hinweg.

## Debugging-Weg

Bei hängenden Launches, OpenCode-Zuständen `registered` / Bootstrap nicht bestätigt, fehlenden Teammate-Antworten oder verdächtigen Task-Logs:

1. Beginnen Sie mit dem [Debugging-Runbook](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md).
2. Untersuchen Sie das neueste Artefakt-Paket unter `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`.
3. Öffnen Sie die Artefakt-`manifest.json` und prüfen Sie `classification`, Bootstrap-Breadcrumbs, Launch-Diagnosen, die Spawn-Status der Mitglieder und die redigierten Log-Auszüge.
4. Räumen Sie nur das Team, den Run, das Pane oder den Prozess auf, das bzw. den Sie als zum Smoke-Test oder zum fehlgeschlagenen Launch gehörig identifizieren können.

## MCP-Entwicklungsweg

Agent Teams nutzt einen integrierten MCP-Server namens `agent-teams` für Board-Operationen. Benutzer- und Projekt-MCP-Server können externe Fähigkeiten für Runtimes hinzufügen. Siehe [MCP-Integration](/de/guide/mcp-integration) für Einrichtungsbeispiele, die Struktur von `.mcp.json` und Hinweise zur Tool-Registrierung.

## Verwandte Dokumente

- [Architektur für Mitwirkende](/de/reference/contributor-architecture)
- [Runtime-Einrichtung](/de/guide/runtime-setup)
- [MCP-Integration](/de/guide/mcp-integration)
- [Fehlerbehebung](/de/guide/troubleshooting)
