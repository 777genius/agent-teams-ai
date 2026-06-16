---
title: Anbieter und Runtimes – Agent Teams Dokumentation
description: Unterstützte Runtime-Pfade (Claude Code, Codex, OpenCode), Anbieter-IDs, Modellbenennung, Multi-Anbieter-Strategien und Funktionsprüfungen.
lang: de-DE
---

# Anbieter und Runtimes

Agent Teams trennt die Orchestrierung vom Modellzugriff. Die App verwaltet Teams, Aufgaben, Nachrichten, den Startzustand und die Review-UI; der ausgewählte Runtime-/Anbieter-Pfad führt die eigentliche Modellarbeit aus.

## Was die App bereitstellt

Agent Teams stellt bereit:

- Team- und Aufgabenorchestrierung
- Kanban-Board-UI
- Teammitglieder-Messaging
- Aufgabenprotokolle
- Review-UI
- lokale Projektintegration
- Runtime-Erkennung und Funktionsprüfungen
- lokale Protokolle und Diagnosen

## Was die Runtime bereitstellt

Die Runtime stellt bereit:

- Modellausführung
- Anbieter-Authentifizierung
- Verhalten bei der Tool-Ausführung
- modellspezifische Rate-Limits und Funktionen
- runtime-spezifische Transkripte und Zustellungsnachweise

## Unterstützte Runtime-Pfade

| Runtime-Pfad | Anbieter-/Modell-Pfad | Beste Eignung | Hinweise |
| --- | --- | --- | --- |
| Claude Code | Anthropic / Claude-Modelle | Claude-Code-Nutzer und Anthropic-gestützte Workflows | Standardmäßiger Local-First-Pfad für Claude-Teams. Erfordert, dass die Runtime und der Kontozugriff lokal verfügbar sind. |
| Codex | Codex / OpenAI-gestützte Modelle | Codex-native Workflows | Nutzt die Codex-Runtime-Integration sowie den Codex-Auth-/Kontostatus, sofern verfügbar. Einige Diagnosen unterscheiden sich von Claude-Transkripten. |
| OpenCode | OpenCode-verwaltetes Modell-Routing | Multi-Anbieter-Teams und breite Modellabdeckung | OpenCode kann über viele Modellanbieter routen. Agent Teams behandelt OpenCode-Lanes als runtime-spezifischen Nachweis und vermeidet Rätselraten, wenn die Lane-Identität mehrdeutig ist. |

Gemini ist als unterstützter Anbieter-Pfad mit Google ADC (gcloud auth), Gemini CLI OAuth und API-Schlüssel-Authentifizierung verfügbar. Es erscheint zusammen mit anderen Anbietern in der UI für die Teamerstellung und Runtime-Einrichtung, wenn die Runtime es als verfügbar meldet.

## Anbieter-IDs

Die App erkennt derzeit diese Anbieter-IDs in der Team-/Runtime-Konfiguration:

| Anbieter-ID | Anzeigeabsicht |
| --- | --- |
| `anthropic` | Anthropic-/Claude-Code-Pfad |
| `codex` | Codex-Pfad |
| `gemini` | Gemini-Anbieter-Pfad (Google ADC, Gemini CLI oder API-Schlüssel) |
| `opencode` | OpenCode-Pfad, einschließlich OpenCode-verwaltetem Anbieter-Routing |

Lesen Sie diese Tabelle nicht als Garantie dafür, dass jeder Anbieter für jedes Modell auf jedem Rechner authentifiziert, installiert oder verfügbar ist. Der Runtime-Status und die Funktionsprüfungen sind die maßgebliche Quelle für einen bestimmten Start.

## Modell-IDs

Modell-IDs werden an die ausgewählte Runtime übergeben. Agent Teams schreibt den Modellkatalog eines Anbieters nicht in ein universelles Benennungsschema um.

Beispiele:

| Anbieter-Pfad | Beispiel-Modell-ID | Hinweise |
| --- | --- | --- |
| Claude Code | `opus`, `sonnet` oder eine vollständige Claude-Modell-ID | Verfügbarkeit hängt von Claude Code und dem Kontozugriff ab |
| Codex | `gpt-5.4`, `gpt-5.3-codex` | Verfügbarkeit ergibt sich aus dem Codex-Konto-/Runtime-Status |
| OpenCode | `openrouter/moonshotai/kimi-k2.6` | Das Präfix muss mit einer OpenCode-Anbieterkonfiguration übereinstimmen |

Wenn ein Modellname abgelehnt wird, überprüfen Sie ihn zuerst direkt in der Runtime/beim Anbieter. Das Ändern eines Team-Briefings kann ein nicht verfügbares Modell nicht starten.

## Multi-Anbieter-Strategie

Agent Teams hält die Orchestrierung anbieterbewusst, aber nicht anbietergebunden:

- Teams, Aufgaben, Posteingänge, Kommentare, Review-Zustand und Start-Diagnosen verbleiben im lokalen Agent-Teams-Speicher
- jedes Mitglied kann Anbieter-/Modelleinstellungen über die Team-Start-Metadaten mitführen
- Modellverfügbarkeit, Auth, Rate-Limits und Tool-Verhalten bleiben in der Verantwortung von Runtime/Anbieter
- OpenCode ist der breiteste Routing-Pfad, wenn ein Team mehrere Anbieter-/Modell-Lanes nutzen soll

Für die Grenzen aus Sicht von Mitwirkenden und kanonische Implementierungshinweise siehe [Architektur für Mitwirkende](/de/reference/contributor-architecture).

Empfohlene Muster:

| Muster | Wann es hilft | Risiko |
| --- | --- | --- |
| Ein Anbieter für alle Mitglieder | Erster Start, sensible Repos, einfachstes Debugging | Geteilte Rate-Limits können das gesamte Team stoppen |
| Starker Lead + günstigere Builder | Planung/Review zuverlässig halten und gleichzeitig die Implementierungskosten senken | Builder-Output benötigt möglicherweise eine strengere Überprüfung |
| Getrennte Builder- und Reviewer-Modelle | Modellspezifische blinde Flecken erkennen | Mehr Einrichtung und Attribution zu prüfen |

## Anbieterkosten

Agent Teams ist kostenlos und quelloffen. Sie können mit dem enthaltenen kostenlosen Modell ohne Auth starten - ohne Registrierung, API-Schlüssel oder Kreditkarte. Bezahlte oder kontogestützte Anbieternutzung unterliegt der von Ihnen ausgewählten Runtime/dem Anbieter: Abonnementlimits, API-Schlüssel, Konto-Auth, Rate-Limits und Anbieterrichtlinien bleiben allesamt außerhalb der App.

## Funktionsprüfungen

Während der Einrichtung kann die App Zugriffs- und Funktionsprüfungen durchführen. Dies hilft, fehlende Runtime-Auth zu erkennen, bevor ein Team-Start mitten in der Bereitstellung fehlschlägt.

Funktionsprüfungen können melden, dass ein Anbieter existiert, aber nicht authentifiziert ist, dass eine Modellliste nicht verfügbar ist, dass ein Runtime-Pfad fehlt oder dass eine bestimmte Erweiterungsfunktion nicht unterstützt wird. Behandeln Sie diese Ergebnisse als Einrichtungsdiagnosen, nicht als Aufgabenfehler.

Typische Einrichtungsbehebungen:

| Prüfergebnis | Was zu tun ist |
| --- | --- |
| Runtime fehlt | Installieren Sie die CLI oder korrigieren Sie `PATH` |
| Anbieter nicht authentifiziert | Führen Sie den Anbieter-Login-Flow aus oder fügen Sie den erforderlichen API-Schlüssel hinzu |
| Modell nicht verfügbar | Wählen Sie ein Modell, das in der Modellliste dieser Runtime sichtbar ist |
| Funktion nicht unterstützt | Verwenden Sie für dieses Teammitglied einen anderen Runtime-Pfad |

## Zu erwartende Einschränkungen

- Runtime-Unterstützung bedeutet keine gleiche Funktionsparität über Claude Code, Codex und OpenCode hinweg.
- Die Abdeckung von Protokollen und Transkripten unterscheidet sich je nach Runtime.
- OpenCode-Lanes benötigen stabile Lane-/Session-Nachweise, bevor die App Runtime-Protokolle sicher zuordnen kann.
- Anbieter-Modellnamen und -Verfügbarkeit können sich außerhalb der App ändern.
- Ein Team-Prompt kann fehlende Auth, fehlende PATH-Einträge, Anbieterausfälle oder erschöpfte Rate-Limits nicht beheben.
