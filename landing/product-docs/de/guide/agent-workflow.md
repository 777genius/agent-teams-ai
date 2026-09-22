---
title: Agent-Workflow – Agent Teams Dokumentation
description: Verstehen Sie den Aufgabenlebenszyklus, das Kanban-Board, Nachrichten, Aufgabenprotokolle, Parallelarbeit, Live-Prozesse und teamübergreifende Kommunikation.
lang: de-DE
---

# Agent-Workflow

Agent Teams macht die Arbeit der Agenten als Aufgabenstatus, Nachrichten, Protokolle und überprüfbare Codeänderungen sichtbar.

## Modi

| Modus | Beschreibung |
| --- | --- |
| Solo | Ein Teammitglied mit selbst verwalteten Aufgaben |
| Team | Viele Teammitglieder, die parallel arbeiten und sich gegenseitig überprüfen |

Beide Modi teilen sich dieselben Oberflächen für Kanban, Aufgabenprotokolle und Code-Review.

## Aufgabenlebenszyklus

Agent Teams verfolgt jede Aufgabe entlang zweier unabhängiger Dimensionen: Arbeitsstatus und Review-Zustand.

| Dimension | Zustände | Beschreibung |
| --- | --- | --- |
| Arbeitsstatus | `pending`, `in_progress`, `completed` | Verfolgt, ob die Aufgabe wartet, gerade bearbeitet wird oder vom Eigentümer abgeschlossen wurde |
| Review-Zustand | `none`, `review`, `needsFix`, `approved` | Verfolgt, an welcher Stelle des Review-Ablaufs nach Abschluss sich die Aufgabe befindet |

Das Kanban-Board zeigt die kombinierte Ansicht, aber die beiden Dimensionen bewegen sich unabhängig voneinander.

### Arbeitsstatus-Ablauf

| Phase | Was passiert | Eigentümer |
| --- | --- | --- |
| Pending | Die Aufgabe ist erstellt und bereit, aber noch hat niemand mit der Arbeit begonnen | Lead oder Benutzer |
| In progress | Agenten arbeiten und aktualisieren den Aufgabenzustand über die Board-MCP-Tools | Teammitglieder |
| Completed | Der Eigentümer postet einen Ergebniskommentar und markiert die Aufgabe als erledigt | Teammitglied |

### Review-Zustand-Ablauf

| Phase | Was passiert | Eigentümer |
| --- | --- | --- |
| None | Die Aufgabe befindet sich noch nicht im Review (kann pending, in progress oder neu completed sein) | — |
| Review | Ein Review wurde angefordert; ein Reviewer prüft das Diff und das Ergebnis | Reviewer |
| Needs fix | Während des Reviews wurden Änderungen angefordert; der Eigentümer muss aktualisieren | Teammitglied (Eigentümer) |
| Approved | Der Review wurde bestanden; die Aufgabe ist finalisiert | Reviewer |

### Planung → In progress

Wenn ein Teammitglied eine Aufgabe beginnt, wechselt der Arbeitsstatus auf `in_progress`. Der Agent erstellt einen Aufgabenkommentar mit seinem Plan und arbeitet weiter. Alle nativen Tool-Aktionen (read, bash, edit, write) werden in ein Aufgabenprotokoll gestreamt.

### Completed → Review

Wenn das Teammitglied die Arbeit beendet, postet es einen Ergebniskommentar und setzt den Arbeitsstatus auf `completed`. Der Lead oder Reviewer kann dann ein Review anfordern, um den Review-Ablauf zu starten.

### Review → Approved

Wenn die Review-Oberfläche akzeptable Änderungen zeigt, genehmigen Sie das Review. Die Aufgabe wird finalisiert und mit ihrem Diff verknüpft.

::: warning Fix-first-Review
Wenn ein Teammitglied während des Reviews um Änderungen gebeten wird, sollte es einen Folgekommentar mit den Korrekturen posten, woraufhin der Lead genehmigen kann.
:::

## Kanban-Board

Das Board ist die primäre Arbeitsoberfläche. Es ermöglicht Ihnen:

- Offene, blockierte und im Review befindliche Arbeit zu überblicken
- Die Aufgabendetails zu öffnen und Laufzeitprotokolle zu inspizieren
- Änderungen zu überprüfen, ohne rohe Session-Dateien zu lesen
- Eigentümer zuzuweisen oder neu zuzuweisen

::: tip
Verwenden Sie die Schnellaktions-Schaltflächen auf den Karten, um eine Aufgabe zu starten, abzuschließen oder ein Review anzufordern, ohne das Detailfenster zu öffnen.
:::

## Nachrichten und Kommentare

| Kanal | Wann verwenden |
| --- | --- |
| Direktnachricht | Einen Agenten umleiten, eine kurze Frage stellen |
| Aufgabenkommentar | Notizen, die zu einer bestimmten Aufgabe gehören |

Kommentare bewahren den Kontext für ein späteres Review und erscheinen in der Aufgaben-Timeline.

::: tip Aufgabenkommentare bevorzugen
Wenn sich die Anmerkung auf eine bestimmte Aufgabe bezieht, fügen Sie sie als Kommentar zu dieser Aufgabe hinzu, anstatt eine Direktnachricht zu senden. So bleibt der Verlauf mit der Arbeit verknüpft.
:::

## Aufgabenprotokolle

Aufgabenspezifische Protokolle isolieren Laufzeitausgaben, Aktionen und Nachrichten für eine Zuweisung. Verwenden Sie sie, um folgende Fragen zu beantworten:

- Was hat dieser Agent ausgeführt?
- Warum hat er diese Datei geändert?
- Hat er ein anderes Teammitglied um Hilfe gebeten?
- Welche Aufgabe hat dieses Diff erzeugt?

### Validierungs-Checkliste

Wenn eine Aufgabe festzustecken scheint oder ihr Diff losgelöst wirkt, überprüfen Sie den Lebenszyklus in dieser Reihenfolge:

1. Die Aufgabe hat den erwarteten Eigentümer und ist auf `in_progress` gewechselt.
2. Der Eigentümer hat einen Aufgabenkommentar mit dem Plan oder dem ersten Fortschrittsupdate gepostet.
3. Die Aufgabenprotokolle zeigen Laufzeitaktivität innerhalb des Aufgabenfensters.
4. Dateiänderungen sind mit derselben Aufgabe, demselben Eigentümer und derselben Session verknüpft.
5. Der abschließende Aufgabenkommentar enthält den Verifizierungsbefehl und das Ergebnis.

Für tiefergehendes Debugging verwenden Sie die Befehle für persistierte Belege unter [Fehlerbehebung](/de/guide/troubleshooting#task-log-triage). Die Benutzeroberfläche ist die Arbeitsoberfläche, aber die persistierten Aufgabendateien, Postfächer und Laufzeitbelege sind die Quelle für schwerwiegende Launch- oder Attributionsfehler.

## Muster für Parallelarbeit

Teammitglieder können gleichzeitig an unabhängigen Aufgaben arbeiten. Sie können auch Abhängigkeitsverknüpfungen (`blocked-by`) erstellen, sodass eine Aufgabe wartet, bis eine andere abgeschlossen ist. Behalten Sie das Board auf blockierte Bahnen im Auge und weisen Sie Eigentümer neu zu, wenn ein Teammitglied untätig ist, während ein anderes überlastet ist.

## Live-Prozesse

Der Live-Prozess-Bereich zeigt URLs und laufende Prozesse an, wenn Agenten lokale Server oder Tools starten. Öffnen Sie URLs direkt aus der App, um die Ergebnisse zu inspizieren. Prozesse bleiben registriert, bis sie explizit gestoppt werden oder die Runtime beendet wird.

## Teamübergreifende Kommunikation

Agenten können Nachrichten an andere Teams senden, wenn die Teams verknüpft sind. Verwenden Sie dies für Übergaben, gemeinsam genutzte Bibliotheken oder Statusabfragen zwischen Squads.
