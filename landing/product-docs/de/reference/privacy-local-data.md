---
title: Datenschutz und lokale Daten – Agent Teams Dokumentation
description: Was Agent Teams lokal speichert, was über anbieterbasierte Modellaufrufe Ihr Gerät verlassen kann und praktische Datenschutzhinweise.
lang: de-DE
---

# Datenschutz und lokale Daten

Agent Teams ist local-first, aber der gewählte Runtime-/Anbieterpfad spielt dennoch eine Rolle. Diese Seite beschreibt, was die Desktop-App lokal speichert und was Ihr Gerät verlassen kann, wenn Agenten anbieterbasierte Modelle aufrufen.

## Was lokal bleibt

Die Desktop-App läuft auf Ihrem Gerät und liest lokale Projekt-/Runtime-Daten, um die Benutzeroberfläche zu betreiben. Typische lokale Daten umfassen:

- Projektdateien
- Teamkonfiguration und Mitglieder-Metadaten
- Aufgaben-Metadaten, Aufgabenkommentare und Aufgabenreferenzen
- Posteingangsnachrichten
- Runtime-/Sitzungsprotokolle
- Startzustand und Bootstrap-Diagnosen
- Review-Status
- Lokale App-Einstellungen

Wichtige lokale Speicherorte umfassen:

| Plattform | Speicherort | Zweck |
| --- | --- | --- |
| macOS/Linux | `~/.claude/teams/<team>/` | Teamkonfiguration, Mitglieder-Metadaten, Posteingänge, Startzustand, Bootstrap-Nachweise, Runtime-Diagnosen, Aufzeichnungen gesendeter Nachrichten, Kanban-Status und review-bezogene Teamdateien. |
| Windows | `%APPDATA%\Claude\teams\<team>\` | Dasselbe — Teamkonfiguration, Mitglieder-Metadaten, Posteingänge, Startzustand und Diagnosen. |
| macOS/Linux | `~/.claude/tasks/<team>/` | Dauerhafte Aufgaben-JSON-Dateien für das Team-Board. |
| Windows | `%APPDATA%\Claude\tasks\<team>\` | Dasselbe — dauerhafte Aufgaben-JSON-Dateien. |
| macOS/Linux | `~/.claude/projects/<encoded-project>/` | Claude-/Codex-artige Projektsitzungsdateien, die für Sitzungsverlauf, Kontextanalyse und transkriptgestützte Benutzeroberfläche verwendet werden. |
| Windows | `%APPDATA%\Claude\projects\<encoded-project>\` | Dasselbe — Projektsitzungsdateien. |

Die genauen Dateien können je nach Runtime und App-Version variieren. Beim Debugging von Starts befinden sich die neuesten Nachweise üblicherweise im jeweiligen Ordner `~/.claude/teams/<team>/` (oder `%APPDATA%\Claude\teams\<team>\`).

## Was Ihr Gerät verlassen kann

Agent Teams selbst ist kein Cloud-Code-Sync-Dienst für Ihr Repository. Die App muss Ihr gesamtes Projekt nicht auf einen Agent-Teams-Server hochladen, um das Board, den Posteingang, Protokolle oder die Review-Benutzeroberfläche anzuzeigen.

Wenn ein Agent jedoch ein anbieterbasiertes Modell mit einer Aufgabe betraut, können Prompt-Kontext, ausgewählte Dateiinhalte, Aufgabentext, Kommentare, Tool-Ergebnisse, Befehlsausgaben und anderer von der Runtime bereitgestellter Kontext über den gewählten Runtime-/Anbieterpfad gesendet werden. Was gesendet wird, hängt von der Runtime, dem Modell, den Tool-Aufrufen, dem Prompt und der Anbieterkonfiguration ab.

Anbieter-Authentifizierung, anbieterseitige Aufbewahrung, Training, Protokollierung, regionale Verarbeitung und Abrechnung werden durch den Anbieter/die Runtime geregelt, den/die Sie wählen. Überprüfen Sie diese Richtlinien für sensible Projekte.

Häufige Beispiele:

| Aktion | Daten, die über die Runtime/den Anbieter gesendet werden können |
| --- | --- |
| Einen Agenten bitten, eine Datei zu bearbeiten | Der Aufgaben-Prompt, relevante Dateiinhalte, Tool-Ergebnisse und Befehlsausgaben |
| Einen Screenshot anhängen | Der Inhalt des Anhangs und der umgebende Aufgaben-/Kommentartext |
| Um ein Code-Review bitten | Diff-Kontext, ausgewählte Dateien, Kommentare und Verifizierungsprotokolle |
| Einen fehlschlagenden Befehl debuggen | Fehlerausgaben, Stack-Traces und referenzierte Quellcode-Ausschnitte |

## Was die App nicht garantiert

- Sie kann nicht garantieren, dass anbieterbasierte Modellaufrufe niemals privaten Code erhalten.
- Sie kann Aufbewahrungs- oder Abrechnungsrichtlinien der Anbieter nicht außer Kraft setzen.
- Sie kann einen entfernten Anbieter nicht dazu bringen, sich wie ein vollständig lokales Modell zu verhalten.
- Sie kann keine Geheimnisse schützen, die ein Agent angewiesen wird, in Prompts, Aufgabenkommentare, Dateien oder Befehle einzufügen.
- Sie kann nicht dafür sorgen, dass jede Runtime dieselben Transkript- oder Audit-Details offenlegt.

## Praktische Hinweise

- Hängen Sie keine Geheimnisse an Aufgaben, Kommentare oder Direktnachrichten an.
- Überprüfen Sie die Anbieterrichtlinien für sensible Projekte.
- Verwenden Sie eine geringere Autonomie für riskante Repositorys.
- Halten Sie den Aufgabenumfang eng, wenn Sie mit privatem Code arbeiten.
- Bevorzugen Sie lokale Nachweise und Protokolle beim Debugging.
- Prüfen Sie generierte Prompts, Aufgabenbeschreibungen und angehängte Dateien, bevor Sie Agenten mit vertraulichem Material betrauen.
- Verwenden Sie Anbieter-/Modellpfade, die Ihren Datenschutzanforderungen entsprechen.

Bevor Sie Agent Teams auf einem sensiblen Repository verwenden:

1. Entfernen Sie Geheimnisse aus dem Arbeitsverzeichnis und den Aufgabenanhängen
2. Wählen Sie den Runtime-/Anbieterpfad, den Sie verwenden dürfen
3. Beginnen Sie mit geringer Autonomie und kleinen Aufgaben
4. Überprüfen Sie Aufgaben-Prompts und generierte Kommentare, bevor Sie den Umfang erweitern
5. Halten Sie Protokolle lokal, sofern Sie sie nicht absichtlich für den Support teilen

## Open-Source-Modell

Die App selbst ist quelloffen und kostenlos. Sie können im Repository nachvollziehen, wie lokale Orchestrierung, Aufgabenverfolgung, Posteingänge, Runtime-Diagnosen und Review-Abläufe funktionieren.
