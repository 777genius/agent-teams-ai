---
title: Installation – Agent Teams Dokumentation
description: Laden Sie Agent Teams für macOS, Windows oder Linux herunter und installieren Sie es. Behandelt paketierte Builds, Einrichtung aus dem Quellcode, automatische Updates und Voraussetzungen.
lang: de-DE
---

# Installation

Agent Teams wird als Desktop-App für macOS, Windows und Linux ausgeliefert.

::: tip Kürzester Weg
1. Laden Sie unten den Build für Ihre Plattform herunter
2. Starten Sie die App - beginnen Sie mit dem kostenlosen Modell ohne Authentifizierung oder verbinden Sie die Anbieter-Authentifizierung über die Benutzeroberfläche
3. Starten Sie den [Schnellstart](/de/guide/quickstart), um Ihr erstes Team zu erstellen

Start der Desktop-App: Führen Sie `pnpm dev` für die Electron-App aus. Starten Sie für die normale Nutzung nicht den Browser-/Web-Entwicklungsmodus.
:::

## Builds herunterladen

Verwenden Sie die <a href="/de/download/" target="_self">Download-Seite</a> oder das neueste [GitHub-Release](https://github.com/777genius/agent-teams-ai/releases), wenn Sie die paketierte App möchten:

- macOS Apple Silicon: `.dmg`
- macOS Intel: `.dmg`
- Windows: `.exe`
- Linux: `.AppImage`, `.deb`, `.rpm` oder `.pacman`

::: warning Windows SmartScreen
Nicht signierte oder neu veröffentlichte Open-Source-Apps können SmartScreen auslösen. Wenn Sie der Release-Quelle vertrauen, wählen Sie **More info** und dann **Run anyway**.
:::

## Voraussetzungen

Die paketierte App ist auf ein Onboarding ohne Einrichtungsaufwand ausgelegt. Sie können mit dem kostenlosen Modell ohne Authentifizierung beginnen - ohne Registrierung, API-Schlüssel oder Kreditkarte. Wenn Sie weitere Modelle möchten, führt die App Sie über die Benutzeroberfläche durch die Runtime-Erkennung und die Anbieter-Authentifizierung.

Für kostenpflichtige oder kontogebundene Modelle verbinden Sie mindestens einen Anbieter:

| Anbieter           | Zugriffsmethode                                   |
| ------------------ | ------------------------------------------------- |
| Claude (Anthropic) | Anmeldung über Claude Code CLI oder API-Schlüssel |
| Codex (OpenAI)     | Anmeldung über Codex CLI oder API-Schlüssel       |
| Gemini (Google)    | Google ADC, Gemini CLI oder API-Schlüssel         |
| OpenCode           | Enthaltenes kostenloses Modell ohne Authentifizierung oder API-Schlüssel für ein unterstütztes Backend (z. B. OpenRouter) |

::: info
Gemini ist als unterstützter Anbieter-Pfad verfügbar. Siehe [Anbieter und Runtimes](/de/reference/providers-runtimes) für Authentifizierungsoptionen und den aktuellen Status über alle Anbieter hinweg.
:::

Für die Entwicklung aus dem Quellcode benötigen Sie außerdem:

| Werkzeug | Version |
| ------- | ------- |
| Node.js | 24.16.0 LTS |
| pnpm    | 10+     |

Unter macOS erfordern die offiziellen vorkompilierten Node.js-24-Binaries macOS 13.5+.

## Aus dem Quellcode ausführen

<InstallBlock command="git clone https://github.com/777genius/agent-teams-ai.git && cd agent-teams-ai && pnpm install && pnpm dev" label="Kopieren" copied-label="Kopiert" />

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` startet die Electron-Desktop-App mit Hot Reload. Dies ist das standardmäßige Entwicklungsziel — starten Sie für die normale Entwicklung keinen Browser-Web-Entwicklungsserver. Dem Browser-Pfad fehlen das vollständige Desktop-IPC, das Terminal, die Anbieter-Authentifizierung und das Verhalten im Team-Lebenszyklus.

Der `main`-Branch enthält die neueste stabile Entwicklung. Wechseln Sie nur dann zu Feature-Branches, wenn Sie eine bestimmte, noch nicht veröffentlichte Änderung benötigen.

## Einrichtung überprüfen

Stellen Sie nach der Installation sicher, dass der Build fehlerfrei ist:

```bash
# Prüfen, ob die Desktop-App kompiliert und startet
pnpm typecheck

# Überprüfen, ob die VitePress-Dokumentationsseite baut
pnpm --dir landing docs:build
```

Wenn `pnpm typecheck` Typfehler meldet, prüfen Sie auf eine neuere Version der Abhängigkeiten oder auf festgepinntes TypeScript. Wenn `pnpm --dir landing docs:build` fehlschlägt, untersuchen Sie `landing/product-docs/` auf Syntaxfehler in Markdown oder Konfiguration.

Wenn Sie diese Dokumentation bearbeiten, führen Sie den Build aus, um Ihre Änderungen zu überprüfen:

```bash
pnpm --dir landing docs:build
```

## Automatische Updates

Die paketierte App prüft beim Start und periodisch während der Ausführung automatisch auf Updates. Wenn ein Update verfügbar ist, fordert die App Sie auf, es herunterzuladen und zu installieren. Sie können auch manuell über das App-Menü prüfen.

::: tip
Automatische Updates sind beim Ausführen aus dem Quellcode nicht verfügbar. Ziehen Sie die neuesten Änderungen und führen Sie `pnpm install` erneut aus, wenn sich Abhängigkeiten ändern.
:::

## Aus dem Quellcode aktualisieren

Wenn Sie aus dem Quellcode ausführen, ziehen Sie den `main`-Branch und führen Sie die Installation erneut aus, wenn sich Abhängigkeiten ändern:

```bash
git pull
pnpm install
```

Überprüfen Sie nach dem Aktualisieren den Build und die Dokumentation:

```bash
pnpm typecheck
pnpm --dir landing docs:build
```

Verwenden Sie für die normale Entwicklung immer `pnpm dev` (Electron) — nicht den Browser-Entwicklungsserver.

## Nächste Schritte

- [Schnellstart](/de/guide/quickstart) — von der Installation bis zum ersten laufenden Team
- [Runtime-Einrichtung](/de/guide/runtime-setup) — Anbieter-Authentifizierung und Modellauswahl pro Runtime
- [Team erstellen](/de/guide/create-team) — empfohlene Teamstrukturen und das Verfassen von Briefings

### Für Mitwirkende

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — Repository-Navigation und Architekturhinweise
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — Arbeitskonventionen und Projektregeln
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — harte Implementierungs-Guardrails
