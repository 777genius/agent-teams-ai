---
title: FAQ – Agent Teams Dokumentation
description: Häufig gestellte Fragen zu Agent Teams — Preise, Modellzugriff, Runtimes, Datenschutz, Review und Fehlerbehebung.
lang: de-DE
---

# FAQ

## Ist Agent Teams kostenlos?

Ja. Die App ist kostenlos und quelloffen. Der Zugriff auf Anbieter oder Runtimes kann je nach Nutzung dennoch Kosten verursachen.

## Beinhaltet Agent Teams einen Modellzugriff?

Nein. Agent Teams ist die lokale Orchestrierungs- und UI-Schicht. Der Modellzugriff stammt aus dem ausgewählten Runtime-/Anbieterpfad, etwa Claude Code, Codex oder OpenCode.

## Welche Runtimes werden unterstützt?

Die unterstützten Runtime-Pfade sind Claude Code, Codex und OpenCode. Die App erfasst außerdem Anbieter-IDs wie Anthropic, Codex und OpenCode, sofern die Runtime sie bereitstellt.

## Muss ich zuerst Claude Code oder Codex installieren?

Nicht immer. Die App leitet die Runtime-Erkennung und -Einrichtung über die UI an. Einige Pfade erfordern dennoch eine externe Runtime-Authentifizierung.

Die Einrichtung von OpenCode ist getrennt von der Einrichtung von Claude Code und Codex. Wenn ein Start fehlschlägt, prüfen Sie den Runtime-Status und die Anbieter-Authentifizierung, bevor Sie den Team-Prompt ändern.

## Wie prüfe ich, ob eine Runtime bereit ist?

Führen Sie den Runtime-Befehl zuerst in einem Terminal aus:

```bash
claude --version
codex --version
opencode --version
```

Bestätigen Sie anschließend die Anbieter-Authentifizierung für den ausgewählten Pfad. Wenn der Befehl oder die Authentifizierungsprüfung außerhalb von Agent Teams fehlschlägt, beheben Sie die Einrichtung, bevor Sie ein Team starten.

## Lädt es meinen Code auf die Server von Agent Teams hoch?

Nein. Agent Teams ist kein Cloud-Code-Sync-Dienst. Anbietergestützte Modellaufrufe können je nach ausgewählter Runtime Prompt-Kontext erhalten.

## Wo werden Team-Dateien gespeichert?

Team-Koordinationsdaten werden lokal unter `~/.claude/teams/<team>/` (macOS/Linux) oder `%APPDATA%\Claude\teams\<team>\` (Windows) gespeichert, Aufgabendateien unter `~/.claude/tasks/<team>/` oder `%APPDATA%\Claude\tasks\<team>\` und Projekt-Sitzungsdaten unter `~/.claude/projects/<encoded-project>/`, sofern verfügbar.

## Was kann meinen Rechner verlassen?

Prompt-Kontext, ausgewählte Dateiinhalte, Tool-Ergebnisse, Befehlsausgaben, Aufgabentexte, Kommentare und Anhänge können Ihren Rechner über den Runtime-/Anbieterpfad verlassen, wenn ein Agent ein anbietergestütztes Modell verwendet. Das genaue Verhalten hängt von der Runtime und dem Anbieter ab.

## Können Agenten miteinander kommunizieren?

Ja. Agenten können Teammitgliedern Nachrichten senden, Aufgaben kommentieren, sich teamübergreifend abstimmen und Aufgabenverweise nutzen, um Konversationen mit der Arbeit verknüpft zu halten.

## Was sollte ich in den ersten Team-Prompt schreiben?

Geben Sie dem Lead ein konkretes Ergebnis, Datei- oder Feature-Grenzen, Risikolimits und Erwartungen an die Verifizierung vor. Zum Beispiel:

```text
Improve the docs quickstart. Keep edits inside landing/product-docs, add practical examples, and run `pnpm --dir landing docs:build` before marking work done.
```

## Kann ich Code überprüfen, bevor ich ihn annehme?

Ja. Der Review-Ablauf ist auf aufgabenbezogene Diffs und Entscheidungen auf Hunk-Ebene ausgelegt.

## Was ist ein Agent Block?

Ein Agent Block ist verborgener, nur für Agenten bestimmter Text, der in Markern wie `<info_for_agent>...</info_for_agent>` eingeschlossen ist. Die App entfernt ihn aus der normalen, für Benutzer sichtbaren Anzeige, hält ihn aber für die Agentenkoordination verfügbar.

## Was ist der Solo-Modus?

Der Solo-Modus ist ein Team mit einem einzigen Agenten. Er eignet sich für kleinere Aufgaben und einen geringeren Koordinationsaufwand.

## Sollte ich Worktree-Isolation verwenden?

Verwenden Sie sie, wenn mehrere OpenCode-Teammitglieder dasselbe Git-Projekt parallel bearbeiten könnten. Sie reduziert Dateikonflikte, erfordert jedoch ein Git-verwaltetes Projekt und gilt derzeit für OpenCode-Mitglieder.

## Können verschiedene Teammitglieder verschiedene Anbieter verwenden?

Ja, Anbieter-/Modelleinstellungen können pro Teammitglied übernommen werden, wenn der ausgewählte Runtime-Pfad sie unterstützt. OpenCode ist der wichtigste Pfad für ein breites Multi-Anbieter-Routing.

## Warum wird eine Aufgabe getrennt von done als review oder approved angezeigt?

Der Arbeitsstatus und der Review-Status sind verwandt, aber nicht identisch. Eine Aufgabe kann aus Sicht des Agenten done sein und anschließend in der Kanban-UI den Review- und Genehmigungsprozess durchlaufen.

## Was sollte ich tun, wenn ein Start hängen bleibt?

Öffnen Sie die Fehlerbehebung, sammeln Sie Start-Diagnosen, prüfen Sie `~/.claude/teams/<team>/` und verifizieren Sie die Runtime-/Anbieter-Authentifizierung, bevor Sie Prompts ändern.

Prüfen Sie bei OpenCode die Lane-/Session-Evidenz, bevor Sie annehmen, dass ein Teammitglied online ist, aber Nachrichten ignoriert.

## Warum unterscheiden sich Logs zwischen den Runtimes?

Claude Code, Codex und OpenCode stellen unterschiedliche Transkriptformate und Runtime-Evidenz bereit. Agent Teams normalisiert, was es kann, aber die Vollständigkeit und Zuordnung der Logs kann je nach Runtime variieren.
