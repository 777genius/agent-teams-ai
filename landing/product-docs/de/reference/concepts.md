---
title: Konzepte – Agent Teams Dokumentation
description: Grundlegendes Vokabular für Agent Teams — Teams, Leads, Teammitglieder, Aufgaben, Kanban, Posteingänge, Runtimes und Review.
lang: de-DE
---

# Konzepte

Diese Seite definiert die grundlegenden Begriffe, die in Agent Teams verwendet werden. Nutzen Sie sie als gemeinsames Vokabular für die App, das Aufgabenboard, Nachrichten und den Review-Ablauf.

## Team

Ein Team ist eine benannte Gruppe von Agenten, die an einen Projektpfad gebunden ist. Es hat einen Lead, optionale Teammitglieder, Runtime-/Anbietereinstellungen, Prompts, Posteingänge, Aufgaben und einen lokalen Startzustand.

## Lead {#lead}

Der Lead ist der Koordinator des Teams. Er verwandelt ein Benutzerziel in Aufgaben, weist Teammitglieder zu oder leitet sie um, verfolgt Blocker, fordert Reviews an und hält die Arbeit über das Board am Laufen.

[Teammitglied →](#teammate)

Lead-Nachrichten verwenden einen anderen Zustellungspfad als Nachrichten von Teammitgliedern: Die App leitet Lead-Posteingangseinträge in die Lead-Runtime weiter, während Teammitglieder zwischen den Zügen ihre eigenen Posteingangsdateien lesen.

## Teammitglied {#teammate}

Ein Teammitglied ist ein Agent im Team, der nicht der Lead ist. Teammitglieder übernehmen üblicherweise fokussierte Rollen wie Builder, Reviewer, Researcher oder Tester. Ein Teammitglied kann Direktnachrichten, Aufgabenzuweisungen, Aufgabenkommentare und Review-Anfragen empfangen.

[Lead ↑](#lead)

## Aufgabe

Eine Aufgabe ist die dauerhafte Arbeitseinheit. Sie hat eine ID, einen Status, einen Eigentümer, eine Beschreibung, Kommentare, Logs, Anhänge, Aufgabenverweise und überprüfbare Änderungen.

Übliche Aufgabenzustände sind `todo`, `in_progress`, `done`, `review` und `approved`. Intern speichert die Aufgabendatei den Arbeitszustand, während die Review- und Freigabeplatzierung auch den Kanban-Overlay-Zustand verwenden kann.

## Kanban

Kanban ist die Boardansicht für die Teamarbeit. Damit können Sie Aufgaben nach Zustand durchsuchen, Aufgabendetails öffnen, Logs inspizieren, Diffs überprüfen, fertige Arbeit freigeben oder Änderungen anfordern.

## Posteingang

Ein Posteingang ist eine lokale Nachrichtendatei für einen Teamteilnehmer. Agent Teams nutzt Posteingänge für Benutzernachrichten, Lead-Nachrichten, Nachrichten von Teammitgliedern, Runtime-Zustellungsmetadaten, teamübergreifende Nachrichten und einige Systembenachrichtigungen.

Nachrichten sind dauerhafte lokale Datensätze. Die Zustellung hängt dennoch davon ab, dass die ausgewählte Runtime aktiv ist und ihren nächsten Zug verarbeiten kann.

## Agent-Block

Ein Agent-Block ist verborgener, nur für Agenten bestimmter Anweisungstext, der mit `<info_for_agent>...</info_for_agent>` umschlossen ist. Die Benutzeroberfläche entfernt diese Blöcke aus der normalen, für Menschen sichtbaren Darstellung, aber Agenten und die Runtime-Zustellung können sie für Koordinationsdetails verwenden.

Der aktuelle kanonische Marker ist `info_for_agent`. Ältere Dokumente verwenden möglicherweise umschlossene Codeblöcke mit einem `info_for_agent`-Marker oder XML-artige `<agent_block>`-Tags — dies sind veraltete Muster und sollten beim Auftreten zu `info_for_agent` migriert werden. (Der ursprüngliche Tag-Name war `agent-block`; die Unterstrich-Form `<agent_block>` wird im VitePress-Quellcode verwendet, um das HTML-Parsing zu vermeiden.)

## Kontextphase

Eine Kontextphase ist ein Segment einer Sitzungs-Kontextzeitleiste. Die Verdichtung (Compaction) startet eine neue Phase, sodass die Token- und Kontextnutzung vor und nach dem Zurücksetzen analysiert werden kann.

Die Kontextverfolgung trennt Kategorien wie Projektanweisungen, erwähnte Dateien, Tool-Ausgabe, Denktext, Teamkoordination und Benutzernachrichten. Diese Zahlen sind Diagnosewerte, keine Abrechnungsbelege der Anbieter.

## Runtime

Eine Runtime ist der lokale Ausführungspfad, der einen Agentenzug ausführt. Zu den unterstützten Runtime-Pfaden gehören Claude Code, Codex und OpenCode.

Die Runtime besitzt das Verhalten der Modellausführung, Authentifizierungsdetails, die Semantik der Tool-Ausführung, Ratenbegrenzungen, die Modellverfügbarkeit und einige Transkript-/Log-Formate.

## Anbieter

Ein Anbieter ist der Modellzugriffspfad hinter einer Runtime. Aktuelle Anbieter-IDs umfassen Anthropic, Codex und OpenCode. OpenCode kann über seine eigene Konfiguration an viele Modellanbieter weiterleiten.

Agent Teams orchestriert Aufgaben und Nachrichten, ersetzt aber nicht die Anbieter-Authentifizierung oder die Anbieterrichtlinien.

## Solo-Modus

Der Solo-Modus betreibt ein Team mit einem einzigen Mitglied. Er ist nützlich für schnelle Arbeit, geringeren Koordinationsaufwand und das Validieren eines Prompts, bevor zu einem vollständigen Team erweitert wird.

## Teamübergreifende Kommunikation

Agenten können innerhalb von Teams und teamübergreifend Nachrichten senden. Nutzen Sie dies, wenn separate Teams zusammenhängende Arbeit besitzen und sich koordinieren müssen, ohne alles in einem großen Team zusammenzufassen.

## Autonomiestufe

Die Autonomie steuert, wie viel Agenten tun dürfen, bevor sie nachfragen. Höhere Autonomie ist schneller; geringere Autonomie ist sicherer für sensible Codepfade, Persistenz, Anbieter-Authentifizierung, Git-Operationen und Releases.

## Review

Review ist der aufgabenbezogene Abnahmeablauf. Eine Aufgabe kann zu review wechseln, Kommentare oder angeforderte Änderungen erhalten und dann zu approved wechseln, wenn das Ergebnis akzeptiert wird.

Review ist an lokale Diffs und die Aufgabenhistorie gebunden und funktioniert daher am besten, wenn Aufgaben eng gefasst bleiben und Agenten die Aufgabe erwähnen, an der sie arbeiten.
