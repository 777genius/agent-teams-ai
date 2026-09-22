---
title: Team erstellen – Agent Teams Dokumentation
description: Rollen definieren, Anbieter und Modelle zuweisen, ein Team-Briefing schreiben sowie Worktree-Isolation und Autonomiestufen konfigurieren.
lang: de-DE
---

# Team erstellen

Ein Team ist eine benannte Gruppe von Agenten mit Rollen, einem Lead, einem Zielprojekt und einem Koordinations-Prompt.

## Empfohlenes erstes Team

Beginnen Sie mit einem kleinen Team:

| Rolle    | Zweck                                                       |
| -------- | ----------------------------------------------------------- |
| Lead     | Teilt die Arbeit auf, erstellt Aufgaben, koordiniert Teammitglieder |
| Builder  | Setzt abgegrenzte Aufgaben um                               |
| Reviewer | Überprüft die Ergebnisse, erkennt Regressionen, fordert Korrekturen an |

Dieser Zuschnitt gibt Ihnen genug Koordination, um den Produktnutzen zu sehen, ohne den ersten Start unübersichtlich zu machen.

::: tip
Sie können später weitere Mitglieder hinzufügen. Beginnen Sie klein, validieren Sie den Workflow und skalieren Sie dann hoch.
:::

## Anbieter und Modelle zuweisen

Jedes Teammitglied läuft auf einem Anbieter-Backend. Wählen Sie im Team-Editor für jedes Mitglied einen Anbieter (Claude, Codex oder OpenCode) und ein Modell. Die App zeigt nur Anbieter an, bei denen Sie sich bereits authentifiziert haben.

Das Mischen von Anbietern innerhalb eines Teams wird unterstützt — zum Beispiel ein Claude-Lead mit OpenCode-Buildern.


## Ein gutes Team-Briefing schreiben

Das Team-Briefing sollte Folgendes enthalten:

- das gewünschte Ergebnis
- die relevanten Dateien oder Funktionsbereiche
- Risikogrenzen, etwa "keine unbeteiligten Module refaktorieren"
- Erwartungen an das Review
- Verifizierungsbefehle, sofern Sie sie kennen

Beispiel:

```text
Build a focused improvement to the download flow. Keep changes inside the landing app unless a shared helper is clearly needed. Create tasks before implementation, review each task diff, and run landing lint/build checks.
```

## Worktree-Isolation

OpenCode-Mitglieder können die **Worktree-Isolation** nutzen, um in einem separaten Git-Worktree statt im Hauptarbeitsverzeichnis zu arbeiten. Das verhindert Dateikonflikte, wenn mehrere Agenten dasselbe Projekt bearbeiten.

::: warning
Die Worktree-Isolation setzt ein Git-verwaltetes Projekt voraus und ist derzeit auf OpenCode-Mitglieder beschränkt.
:::

Um sie zu aktivieren, schalten Sie die Option **Worktree-Isolation** beim Hinzufügen oder Bearbeiten eines OpenCode-Teammitglieds ein.

## Autonomie wählen

Agent Teams unterstützt verschiedene Kontrollstufen. Nutzen Sie mehr Autonomie für Routineänderungen und engeres Review für riskante Bereiche wie Anbieter-Authentifizierung, IPC, Persistenz, Git-Workflows und Release-Tooling.

### Aufwandsstufe

Jedes Teammitglied hat eine **Aufwand**-Einstellung, die steuert, wie viel Reasoning der Anbieter vor einer Antwort investiert. Höherer Aufwand erzeugt gründlichere Ergebnisse, kostet jedoch Zeit und Tokens.

| Stufe   | Wann verwenden                                              |
| ------- | ---------------------------------------------------------- |
| Low     | Schnelle Nachschläge, kleine Formatierungsänderungen, Routine-Edits |
| Medium  | Standard für die meisten Implementierungsaufgaben          |
| High    | Komplexe Refactorings, übergreifende Änderungen, riskante Codepfade |

Die App bietet zusätzliche Stufen (minimal, xhigh, max) für Anbieter, die diese unterstützen. Wenn ein Modell keinen konfigurierbaren Aufwand unterstützt, ist die Auswahl deaktiviert und der Standardwert des Anbieters wird verwendet.

### Fast Mode

Schalten Sie pro Mitglied den **Fast Mode** ein, um Geschwindigkeit gegenüber Tiefe zu priorisieren. Dies entspricht dem nativen Fast-/Speed-Modus des Anbieters, sofern verfügbar. Setzen Sie ihn auf **On** für Routineaufgaben, auf **Off** für sorgfältige Arbeit oder auf **Inherit**, um dem teamweiten Standard zu folgen.

### Kontext begrenzen

Aktivieren Sie **Kontext begrenzen**, um das Kontextfenster für ein Mitglied zu verkleinern. Das ist nützlich für Claude-Modelle, die erweiterten Kontext unterstützen (z. B. 1M Tokens) — das Begrenzen des Kontexts vermeidet unnötigen Token-Verbrauch und kann die Latenz für Aufgaben verbessern, die keinen großen Kontext benötigen.

## Kontext hinzufügen

Hängen Sie Dateien, Screenshots oder spezifische Notizen an, wenn sie die Aufgabe wesentlich verändern. Agenten können Aufgabenbeschreibungen, Kommentare und Anhänge als dauerhaften Kontext nutzen.

## Auf Aufgabenqualität achten

Gute Teams erstellen Aufgaben, die:

- spezifisch genug sind, um sie zu überprüfen
- klein genug sind, um sie abzuschließen
- mit sichtbaren Ergebnissen verknüpft sind
- durch einen Verifizierungspfad abgesichert sind

Wenn der Lead vage Aufgaben erstellt, senden Sie eine Direktnachricht mit der Bitte um kleinere, testbare Aufgaben.

## Nächste Schritte

- [Runtime-Einrichtung](/de/guide/runtime-setup) — Anbieter-Authentifizierung und Modelle konfigurieren
- [Code-Review](/de/guide/code-review) — Agentenänderungen akzeptieren, ablehnen oder kommentieren
- [Fehlerbehebung](/de/guide/troubleshooting) — häufige Probleme und Lösungen
