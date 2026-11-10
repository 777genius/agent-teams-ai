---
title: Code-Review – Agent Teams Dokumentation
description: Aufgabenbezogene Diffs prüfen, Hunks akzeptieren oder ablehnen, Inline-Kommentare hinterlassen und Review-Zustände von none bis approved verwalten.
lang: de-DE
---

# Code-Review

Code-Review in Agent Teams ist aufgabenzentriert. Sie prüfen, was sich für eine bestimmte Aufgabe geändert hat, anstatt einen großen unstrukturierten Diff zu durchsuchen.

## Review-Oberfläche

Für jede abgeschlossene Aufgabe, die Dateien berührt hat, ermöglicht Ihnen die Review-Oberfläche Folgendes:

- Geänderte Dateien mit Kontext vorher/nachher prüfen
- Einzelne Hunks akzeptieren oder ablehnen
- Inline-Kommentare hinterlassen
- Den Diff mit der Aufgabenbeschreibung und den Agent-Logs verknüpfen

## Entscheidungen auf Hunk-Ebene

Akzeptieren Sie kleine korrekte Änderungen und lehnen Sie isolierte Fehler ab, ohne die gesamte Aufgabe zu verwerfen. Das ist nützlich, wenn ein Agent die Aufgabe größtenteils gelöst, aber in einer Datei über das Ziel hinausgeschossen ist.

::: tip Schrittweise akzeptieren
Wenn ein Diff größtenteils korrekt ist, akzeptieren Sie zuerst die guten Hunks und fordern Sie nur für die Teile Änderungen an, die korrigiert werden müssen. So bleibt das Board in Bewegung.
:::

Nutzen Sie Entscheidungen auf Hunk-Ebene für:

| Situation | Aktion |
| --- | --- |
| Korrekte, eng begrenzte Änderung | Den Hunk akzeptieren |
| Korrekte Idee, falsche Datei oder breites Refactoring | Den Hunk ablehnen und eine engere Korrektur anfordern |
| Unklare Verhaltensänderung | Kommentieren und um Verifizierung bitten |
| Generiertes Formatierungsrauschen | Ablehnen, sofern die Formatierung nicht Teil der Aufgabe war |

## Review starten

1. Öffnen Sie eine abgeschlossene Aufgabe
2. Sehen Sie sich den Tab **Changes** an
3. Wenn der Diff angemessen aussieht, klicken Sie auf **Request Review**, um die Aufgabe in die Review-Spalte zu verschieben

Während des Reviews gilt die Aufgabe noch nicht als done, sodass andere Teammitglieder oder der Lead sie weiterhin kommentieren können.

## Review-Schleife

Eine gesunde Review-Schleife sieht so aus:

1. Der Eigentümer postet einen Ergebniskommentar mit dem geänderten Umfang und der Verifizierung
2. Der Reviewer öffnet den Aufgaben-Diff und prüft die Hunks anhand der Aufgabenbeschreibung
3. Der Reviewer akzeptiert gute Hunks, lehnt schlechte Hunks ab oder fordert Änderungen an
4. Der Eigentümer korrigiert nur den angeforderten Umfang und postet einen Folgekommentar
5. Der Reviewer genehmigt, wenn Aufgabenergebnis und Diff übereinstimmen

Beispiel für einen Kommentar mit Änderungsanforderung:

```text
Please keep the copy improvements, but revert the unrelated runtime wording in the provider table. Add the `pnpm --dir landing docs:build` result before resubmitting.
```

## Review-Zustände

| Zustand | Bedeutung |
| --- | --- |
| `none` | Aufgabe ist neu, in Bearbeitung oder abgeschlossen, aber noch nicht im Review |
| `review` | Die Aufgabe befindet sich aktiv im Review |
| `needsFix` | Es wurden Änderungen angefordert; der Eigentümer muss vor der erneuten Genehmigung aktualisieren |
| `approved` | Das Review wurde akzeptiert und die Aufgabe ist abgeschlossen |

## Agent-Review-Workflow

Teams können die Arbeit der jeweils anderen prüfen, bevor Sie die endgültige Entscheidung treffen. Das fängt offensichtliche Regressionen ab und hält das Board ehrlich, aber Sie sollten riskante Bereiche dennoch selbst überprüfen.

Ein Agent-Review ist am nützlichsten, wenn der Reviewer ein klares Bewertungsraster hat. Weisen Sie einen Reviewer beispielsweise an, nur die Verständlichkeit der Dokumentation, nur die IPC-Sicherheit oder nur die Testabdeckung zu prüfen. Breite Aufforderungen wie "alles überprüfen" führen tendenziell zu schwächerem Feedback.

### MCP-gesteuerter Review-Zustand

Änderungen des Review-Zustands (Review anfordern, Änderungen anfordern, genehmigen) sind tool-gesteuert. Das Hinterlassen eines Kommentars mit Änderungsanforderung an einer Aufgabe verschiebt die Kanban-Spalte **nicht** auf `needsFix` — ein Lead oder Agent muss das passende MCP-Tool aufrufen:

- `review_request_changes` — verschiebt die Aufgabe auf `needsFix` und benachrichtigt den Eigentümer
- `review_approve` — verschiebt die Aufgabe auf `approved` und schließt das Review ab

Kommentare allein reichen für Zustandsübergänge nicht aus. Die vollständige Liste der Review-MCP-Tools und ihrer Parameter finden Sie unter [MCP-Integration](/de/guide/mcp-integration).

## Review-Teilnehmer

Der Team-Lead ist der Standard-Reviewer. Sie können in den Kanban-Einstellungen zusätzliche Reviewer konfigurieren, wenn Sie möchten, dass Kollegen die Arbeit der jeweils anderen prüfen.

## Was manuell zu prüfen ist

Priorisieren Sie diese Bereiche beim Review:

- **Anbieter-Authentifizierung und Runtime-Erkennung** — hat der Agent die Runtime-Einrichtung so geändert, dass andere Pfade dadurch beeinträchtigt würden?
- **IPC-, Preload- und Dateisystemgrenzen** — halten Sie die Electron-Zuständigkeiten getrennt
- **Git- und Worktree-Verhalten** - überprüfen Sie Branch-Benennung, Commits und Pushes; siehe [Git- und Worktree-Strategie](/de/guide/git-worktree-strategy) für Isolationsmuster.
- **Parsing- und Aufgabenlebenszyklus-Logik** — Änderungen an Aufgabenreferenzen, Chunking oder Filterung können die Nachrichtenzustellung beeinträchtigen
- **Persistenz- und Code-Review-Abläufe** — Änderungen am Aufgabenspeicher oder Review-Zustand müssen über die IPC-Schichten hinweg konsistent bleiben

Den kanonischen Feature-Aufbau und Links zu den harten Guardrails finden Sie unter [Architektur für Mitwirkende](/de/reference/contributor-architecture).

## Verifizierung

Bevorzugen Sie gezielte Verifizierungsbefehle. Breite Formatierungs- oder Lint-Fix-Befehle sollten nicht verwendet werden, sofern die Aufgabe nicht ausdrücklich eine breite Formatierungsänderung beabsichtigt.

Gute Verifizierungskommentare enthalten den Befehl und das Ergebnis:

```text
Verified with `pnpm --dir landing docs:build`. Build passed.
```

Wenn die Verifizierung übersprungen wird, sollte der Aufgabenkommentar den Grund nennen:

```text
Docs-only wording change. Build not run because the existing dev server was busy; checked Markdown links manually.
```

::: warning Nicht projektweit automatisch formatieren
Sofern es bei der Aufgabe nicht ausdrücklich um Formatierung geht, vermeiden Sie es, `pnpm lint:fix` auf nicht zugehörige Dateien auszuführen. Das erzeugt Rauschen in der Review-Oberfläche.
:::
