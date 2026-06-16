---
title: Git- und Worktree-Strategie – Agent Teams Dokumentation
description: Entscheiden Sie, wann Sie den Haupt-Worktree, Feature-Branches oder die OpenCode-Worktree-Isolierung für parallele Agentenarbeit verwenden.
lang: de-DE
---

# Git- und Worktree-Strategie

Git bietet Agent Teams den stärksten Review-Pfad: schmale Diffs, Branch-Sichtbarkeit, aufgabenbezogene Änderungen und sicherere parallele Arbeit.

## Eine Strategie wählen

| Strategie | Verwenden, wenn | Kompromiss |
| --- | --- | --- |
| Haupt-Worktree | Einzelarbeit, reine Doku-Bearbeitungen oder ein Teammitglied nach dem anderen | Einfach, aber parallele Bearbeitungen können kollidieren |
| Feature-Branch | Ein Team arbeitet an einer zusammenhängenden Änderung | Sauberes Review-Ziel, aber Teammitglieder teilen sich weiterhin Dateien |
| Worktree-Isolierung | Mehrere OpenCode-Teammitglieder bearbeiten möglicherweise dasselbe Repository parallel | Bessere Isolierung, aber Merge/Review erfordert mehr Disziplin |

Fangen Sie einfach an. Fügen Sie die Worktree-Isolierung hinzu, wenn parallele Bearbeitungen wahrscheinlich sind, nicht weil jede Aufgabe ein eigenes Checkout benötigt.

## Wann die Worktree-Isolierung aktiviert werden sollte

Aktivieren Sie sie für OpenCode-Teammitglieder, wenn:

- zwei oder mehr Teammitglieder gleichzeitig dasselbe Repository bearbeiten könnten
- eine Aufgabe Formatierer, Codegeneratoren oder umfangreiche Tests ausführen könnte
- Sie möchten, dass der Branch und das Diff jedes Teammitglieds getrennt bleiben
- der Lead-Workspace unsauber ist und keine direkten Bearbeitungen erhalten sollte

Lassen Sie sie deaktiviert, wenn:

- die Aufgabe schreibgeschützt ist
- ein Teammitglied alle Bearbeitungen verantwortet
- das Repository nicht von Git verfolgt wird
- Sie einen Runtime-Pfad benötigen, der diesen Isolierungsmodus nicht unterstützt

::: warning
Die Worktree-Isolierung gilt derzeit für OpenCode-Mitglieder und erfordert ein von Git verfolgtes Projekt.
:::

## Branch-Hygiene

Bevor Sie parallele Arbeit beginnen:

```bash
git status --short
git branch --show-current
```

Verwenden Sie nach Möglichkeit einen sauberen Branch. Wenn der Haupt-Worktree bereits Benutzeränderungen enthält, weisen Sie die Agenten an, nicht zugehörige Dateien nicht zurückzusetzen, und halten Sie den Aufgabenumfang eng.

Empfohlener Branch-Stil:

```text
agent/<team-or-task>/<short-purpose>
```

Beispiele:

```text
agent/docs/mcp-guide
agent/review/task-log-filtering
agent/ui/code-review-polish
```

## Review-Ablauf

Bei isolierten Worktrees prüfen Sie das Diff des Teammitglieds, bevor Sie Änderungen mergen oder zurück in den Haupt-Workspace übernehmen.

1. Bestätigen Sie, dass der Kommentar zum Aufgabenergebnis den geänderten Umfang und die Verifizierung benennt.
2. Prüfen Sie das Aufgaben-Diff in der Review-UI.
3. Fordern Sie Änderungen an der Aufgabe an, wenn das Diff nicht zugehörige Dateien berührt.
4. Genehmigen Sie erst, nachdem Tests oder manuelle Prüfungen dem Aufgabenrisiko entsprechen.
5. Mergen oder übernehmen Sie Änderungen bewusst.

Mergen Sie Worktree-Ausgaben nicht automatisch, nur weil die Aufgabe abgeschlossen ist. Abschluss bedeutet, dass der Agent die Arbeit für reviewbereit hält.

## Konfliktrichtlinie

Verwenden Sie diese Richtlinie für parallele Teams:

| Situation | Aktion |
| --- | --- |
| Zwei Teammitglieder bearbeiten dieselbe Datei | Pausieren Sie eine Aufgabe oder machen Sie eine Person für die Integration verantwortlich |
| Generierte Dateien wurden umfangreich geändert | Verlangen Sie einen Kommentar, der den Generator und den Befehl erklärt |
| Der Haupt-Worktree enthält nicht zugehörige Änderungen | Bewahren Sie sie auf und prüfen Sie nur die aufgabeneigenen Änderungen |
| Der Worktree-Branch divergiert | Rebasen oder mergen Sie nach dem Review manuell, nicht innerhalb einer vagen Agentenaufgabe |

## Beispiel für einen Aufgaben-Prompt

```text
Implement the settings validation fix in your assigned worktree. Keep edits inside src/features/settings and focused tests. Do not touch provider auth or task storage. Post the test command and result before completing the task.
```

Dieser Prompt funktioniert, weil er den erlaubten Bereich, die sensiblen Grenzen und den Abschlussnachweis benennt.

## Verwandte Anleitungen

- [Team erstellen](/de/guide/create-team)
- [Code-Review](/de/guide/code-review)
- [Team-Briefing-Beispiele](/de/guide/team-brief-examples)
- [Runtime-Einrichtung](/de/guide/runtime-setup)
