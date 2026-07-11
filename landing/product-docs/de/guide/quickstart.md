---
title: Schnellstart – Agent Teams Dokumentation
description: Kommen Sie in wenigen Minuten von einer frischen Installation zu einem laufenden KI-Agententeam. Behandelt Installation, Runtime-Auswahl, Team-Erstellung und das erste Code-Review.
lang: de-DE
---

# Schnellstart

Diese Anleitung bringt Sie in wenigen Minuten von einer frischen Installation zu einem laufenden Team.

## Kürzester Weg

```bash
# 1. Install prerequisites
node --version    # need 20+
pnpm --version    # need 10+

# 2. Clone and install
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install

# 3. Start the desktop app (default workflow)
pnpm dev

# 4. Verify a docs-only change
pnpm --dir landing docs:build
```

Die Desktop-Electron-App (`pnpm dev`) ist das primäre Ziel — verwenden Sie für die normale Entwicklung nicht den Browser-/Web-Dev-Server. Dem Browser-Pfad fehlen Desktop-IPC, Terminal, Anbieter-Authentifizierung und das Verhalten des Team-Lebenszyklus.

## Bevor Sie beginnen

Sie benötigen:

- **Einen Computer** mit macOS, Windows oder Linux
- **(Empfohlen) Ein Git-getracktes Projekt** — Worktree-Isolierung und Diff-Review setzen Git voraus
- **(Optional) Anbieterzugang** — die Runtime-Einrichtung erkennt verfügbare Anbieter über die UI, aber einige Pfade benötigen vorhandene Authentifizierung (Anthropic, OpenAI usw.)

Falls ein Schritt unten nicht funktioniert, sehen Sie in der [Fehlerbehebungsanleitung](/de/guide/troubleshooting#team-does-not-launch) nach gängigen Lösungen.

Konsultieren Sie für Projektkonventionen und Architekturhinweise diese maßgeblichen Dateien, bevor Sie Änderungen vornehmen:

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — Repo-Navigation und Architektur-Wegweiser
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — Arbeitskonventionen und Projektregeln
- [Feature-Architekturstandard](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — Struktur für neue Features
- [Debugging-Runbook](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — Diagnose von Launch und Teammitgliedern

## 1. Aus dem Quellcode ausführen oder herunterladen

**Laden Sie die paketierte App** für macOS, Windows oder Linux von der <a href="/de/download/" target="_self">Download-Seite</a> herunter – keine Voraussetzungen nötig. Beginnen Sie mit dem kostenlosen Modell ohne Authentifizierung oder verbinden Sie die Anbieter-Authentifizierung über die UI, wenn Sie mehr Modelle möchten.

**Oder führen Sie aus dem Quellcode aus** für die Entwicklung:

Erfordert Node.js 24.16.0 LTS und pnpm 10+. Unter macOS erfordern die offiziellen vorkompilierten Node.js-24-Binärdateien macOS 13.5+.

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` startet die Desktop-Electron-App mit Hot Reload. Dies ist das standardmäßige Entwicklungsziel. Starten Sie für die normale Entwicklung keinen Browser-Web-Dev-Server — dem Browser-Pfad fehlen das vollständige Desktop-IPC, das Terminal, die Anbieter-Authentifizierung und das Verhalten des Team-Lebenszyklus.

## 2. Ein Projekt öffnen oder erstellen

Starten Sie die App und wählen Sie das Projektverzeichnis aus, in dem die Agenten arbeiten sollen. Agent Teams liest lokale Projektdateien sowie den Runtime-/Session-Status, damit die UI Aufgaben, Logs, Diffs und die Aktivität der Teammitglieder anzeigen kann.

::: tip
Wählen Sie für die beste Erfahrung ein Git-getracktes Projekt. Sowohl die Worktree-Isolierung als auch das Diff-basierte Review setzen Git voraus.
:::

Bevor Sie ein Team starten, prüfen Sie, ob das Projekt eine ausreichend saubere Ausgangsbasis hat:

```bash
git status --short
```

Sie brauchen keinen perfekt sauberen Baum, aber Sie sollten wissen, welche Änderungen von Ihnen stammen, bevor die Agenten mit dem Bearbeiten beginnen. Das macht Aufgaben-Diffs und das Review auf Hunk-Ebene deutlich vertrauenswürdiger.

## 3. Einen Runtime-Pfad wählen

Der Einrichtungsablauf erkennt installierte Runtimes auf Ihrem Rechner automatisch. Eine gängige erste Einrichtung ist:

| Runtime  | Gut für                                        |
| -------- | ----------------------------------------------- |
| Claude   | Claude-Code-Nutzer und vorhandenen Anthropic-Zugang |
| Codex    | Codex-native Workflows und OpenAI-Zugang        |
| OpenCode | Kostenloses Modell ohne Authentifizierung, Multimodell-Teams und viele Anbieter-Backends |


Siehe [Runtime-Einrichtung](/de/guide/runtime-setup) für eine detaillierte Konfiguration pro Anbieter.

Um eine kostenpflichtige oder kontogebundene Runtime außerhalb der App zu überprüfen, prüfen Sie die Binärdatei und testen Sie die Authentifizierung:

```bash
# Check that the runtime is installed and on PATH
command -v claude && claude --version
command -v codex && codex --version
command -v opencode && opencode --version
```

Wenn der Befehl fehlschlägt, beheben Sie zuerst die Runtime-Installation oder den `PATH`. Team-Prompts können eine fehlende Binärdatei oder eine fehlende Anbieter-Authentifizierung für Modelle, die sie benötigen, nicht umgehen.

::: tip
Wenn die Binärdatei gefunden wird, die App aber "not logged in" meldet, kann sich die Umgebung zwischen Ihrem Terminal und der App unterscheiden. Siehe das [Authentifizierungs-Diagnoselog](/de/guide/troubleshooting#auth-diagnostic-log), um sie zu vergleichen.
:::

## 4. Ihr erstes Team erstellen

Erstellen Sie ein Team mit einem Lead und einem oder mehreren Spezialisten. Halten Sie das erste Team klein: ein Lead, ein Implementierungs-Agent und ein review-orientierter Agent reichen aus, um den Workflow zu validieren.

Siehe [Team erstellen](/de/guide/create-team) für die empfohlene Struktur und Tipps.

Bevorzugen Sie für den ersten Start eine Teamform wie diese:

| Mitglied | Verantwortung | Hinweise |
| --- | --- | --- |
| Lead | Das Ziel in Aufgaben aufteilen und den Status koordinieren | Beim zuverlässigsten Anbieter belassen, den Sie haben |
| Builder | Eng abgegrenzte Aufgaben umsetzen | Klare Datei- oder Feature-Grenzen vorgeben |
| Reviewer | Abgeschlossene Arbeit überprüfen | Bitten Sie ihn, sich auf Regressionen und fehlende Tests zu konzentrieren |

Vermeiden Sie es, mit fünf oder mehr Teammitgliedern zu beginnen. Mehr Agenten erhöhen Parallelität, Logs, Anbieternutzung und Konfliktrisiko, bevor Sie wissen, dass die Einrichtung gesund ist.

## 5. Dem Lead ein konkretes Ziel geben

Formulieren Sie das Ziel so, wie Sie einen Engineering-Lead briefen würden:

```text
Improve the onboarding flow. Split the work into tasks, keep changes small, and ask for review before broad refactors.
```

Gute erste Prompts enthalten konkreten Umfang, Sicherheitsgrenzen und Verifizierung:

```text
Improve the docs quickstart. Keep edits inside landing/product-docs. Add practical examples, preserve existing VitePress syntax, and run `pnpm --dir landing docs:build` before marking tasks done.
```

Vermeiden Sie für den ersten Lauf vage Prompts wie "make the app better". Der Lead kann große Ziele aufschlüsseln, aber bessere Eingaben führen zu kleineren Aufgaben und einem saubereren Review.

::: tip
Wenn das Team startet, aber keine Aufgaben erscheinen, prüfen Sie, ob der Lead Ihren Prompt erhalten hat. Siehe [Antworten der Agenten fehlen](/de/guide/troubleshooting#agent-replies-are-missing) für die Diagnose.
:::

Der Lead erstellt Aufgaben, weist Arbeit zu und koordiniert die Teammitglieder. Sie können den Fortschritt auf dem Kanban-Board verfolgen und jederzeit mit Kommentaren oder Direktnachrichten eingreifen.

## 6. Ergebnisse überprüfen

Öffnen Sie abgeschlossene oder review-bereite Aufgaben, prüfen Sie das Diff und akzeptieren, lehnen Sie ab oder kommentieren Sie einzelne Änderungen. Verwenden Sie die Aufgaben-Logs, wenn Sie verstehen müssen, warum ein Agent eine Entscheidung getroffen hat.

Siehe [Code-Review](/de/guide/code-review) für den vollständigen Review-Workflow.

Bevor Sie die erste Aufgabe genehmigen, prüfen Sie drei Dinge:

1. Der Aufgabenkommentar erklärt, was sich geändert hat
2. Die geänderten Dateien entsprechen dem Aufgabenumfang
3. Das Verifizierungsergebnis ist im Aufgabenkommentar oder in den Logs sichtbar

## Häufige Fallstricke

| Symptom | Wahrscheinliche Ursache | Prüfen |
| --- | --- | --- |
| App erkennt eine Runtime nicht | Binärdatei nicht im `PATH`, oder App und Terminal sehen unterschiedliche Umgebungen | Führen Sie `command -v <runtime>` in einem Terminal aus und starten Sie die App dann mit derselben Terminal-Umgebung |
| Team-Launch hängt | Fehlende Anbieter-Authentifizierung für ein kostenpflichtiges/kontogebundenes Modell, falscher Modell-String oder Runtime-Binärdatei nicht gefunden | Siehe [Fehlerbehebung](/de/guide/troubleshooting#team-does-not-launch) |
| OpenCode-Lane bleibt auf `registered` hängen | Lane-Nachweis noch nicht committet, oder Modell-String-Diskrepanz | Untersuchen Sie `~/.claude/teams/<team>/.opencode-runtime/lanes/` |
| Antworten der Agenten fehlen | Problem mit Runtime-Zustellung, Wiederholung, Parsing oder Aufgabenzuordnung | Öffnen Sie die Aufgaben-Logs und prüfen Sie das Zustellungs-Ledger |
| Anbieter liefert 429er | Ratenlimit erreicht | Auf das Zurücksetzen warten oder Modell/Anbieter wechseln |

## Nächste Schritte

- [Team erstellen](/de/guide/create-team) — empfohlene Teamformen und das Schreiben von Briefings
- [Runtime-Einrichtung](/de/guide/runtime-setup) — Anbieter-Authentifizierung und Modellauswahl
- [Code-Review](/de/guide/code-review) — überprüfen, genehmigen oder Änderungen anfordern

### Für Mitwirkende

Wenn Sie Agent Teams oder diese Dokumentation ändern, beginnen Sie mit den maßgeblichen Projektdateien im Repo-Stammverzeichnis:

- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — Arbeitskonventionen und Projektregeln
- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — Navigationsebene für Architektur- und Implementierungshinweise
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — harte Implementierungs-Guardrails
- [Feature-Architekturstandard](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — Struktur für neue Features
- [Debugging-Runbook für Agent-Teams](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — Diagnose von Launch, Bootstrap und Teammitgliedern

Um zu überprüfen, ob diese Dokumentationsseite korrekt baut:

```bash
pnpm --dir landing docs:build
```
