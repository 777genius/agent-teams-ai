---
title: Runtime-Einrichtung – Agent Teams Dokumentation
description: Konfigurieren Sie die Runtimes Claude Code, Codex oder OpenCode. Behandelt Authentifizierung, Anbieterzugriff, Multimodell-Modus und Prüfungen vor dem Start.
lang: de-DE
---

# Runtime-Einrichtung

Agent Teams ist eine Koordinationsebene. Die eigentliche Modellarbeit läuft über unterstützte lokale Runtimes und Anbieter.

::: tip Schnellstart - die erste Runtime auswählen
| Wenn Sie ... | Beginnen Sie mit |
| --- | --- |
| Bereits Claude Code nutzen oder Zugriff auf Anthropic haben | **Claude** - vertraute Authentifizierung, minimale Einrichtung |
| Codex oder OpenAI-basierte Workflows nutzen | **Codex** - native Integration |
| Agent Teams ohne Registrierung oder API-Schlüssel ausprobieren möchten | **OpenCode** - nutzen Sie das enthaltene kostenlose Modell ohne Authentifizierung |
| Multimodell-Routing oder breite Anbieterabdeckung möchten | **OpenCode** - am flexibelsten, eine Konfiguration für viele Backends |
| Nicht sicher sind, welche Runtime passt | **OpenCode** - deckt die meisten Anbieteroptionen ab und lässt Sie später wechseln |

Beginnen Sie mit einer Runtime und einem Teammitglied. Bestätigen Sie, dass ein Start funktioniert, bevor Sie auf Multimodell erweitern.
:::

## Voraussetzungen

Stellen Sie vor dem Start eines Teams sicher, dass:

- Die Runtime-Binärdatei installiert ist und sich in Ihrem `PATH` befindet.
- Ihr Anbieterkonto aktiven Zugriff auf das Modell hat, das Sie verwenden möchten, es sei denn, Sie beginnen mit dem enthaltenen kostenlosen OpenCode-Modell ohne Authentifizierung.
- Der Projektpfad existiert und lesbar ist.
- Die App und Ihr Terminal dieselbe Home-/Konfigurationsumgebung verwenden, wenn Sie die Authentifizierung manuell testen.

::: tip
Beginnen Sie mit einem einzelnen Teammitglied und einem Anbieter. Bestätigen Sie, dass ein Start funktioniert, bevor Sie Multimodell-Lanes hinzufügen.
:::

Schnelle Terminal-Prüfungen:

```bash
command -v claude
command -v codex
command -v opencode
```

Führen Sie den Befehl für die Runtime aus, die Sie verwenden möchten. Wenn nichts ausgegeben wird, installieren Sie die Runtime oder korrigieren Sie den `PATH`, bevor Sie ein Team starten.

## Unterstützte Pfade

| Pfad | Standard-CLI | Typische Anbieter | Verwenden, wenn |
| --- | --- | --- | --- |
| Claude | `claude` | Anthropic | Sie bereits Claude Code oder Anthropic-gestützte Workflows nutzen |
| Codex | `codex` | OpenAI | Sie eine Codex-native Runtime-Integration möchten |
| OpenCode | `opencode` | OpenRouter und viele Backends | Sie Multimodell-Routing und breite Anbieterabdeckung möchten |

Die App erkennt unterstützte Runtimes und leitet die Einrichtung nach Möglichkeit über die Oberfläche an.


## Anbieterzugriff

Agent Teams hat keine eigene kostenpflichtige Stufe. Sie können mit dem enthaltenen kostenlosen OpenCode-Modell ohne Authentifizierung beginnen - keine Registrierung, keine API-Schlüssel, keine Kreditkarte. Für zusätzliche Modelle bringen Sie den Anbieterzugriff mit, den Sie bereits haben: Abonnements, lokale Runtime-Authentifizierung oder API-Schlüssel, je nach gewähltem Pfad.

- Die Pfade **Claude** und **Codex** stützen sich auf ihre jeweiligen CLI-Authentifizierungstools.
- **OpenCode** kann zunächst das enthaltene kostenlose Modell ohne Authentifizierung ausführen. Andere OpenCode-Modelle benötigen möglicherweise anbieterspezifische API-Schlüssel in einer Konfigurationsdatei (z. B. `openrouter`, `openai`, `anthropic`).

## Authentifizierungskonfiguration

### Claude Code

Führen Sie den standardmäßigen Authentifizierungsablauf in einem Terminal aus:

```bash
claude login
```

Überprüfen Sie dann, ob die CLI erreichbar ist:

```bash
claude --version
```

Wenn die paketierte App "nicht angemeldet" meldet, während Ihr Terminal funktioniert, vergleichen Sie die von der App gesehenen `$HOME`- und `PATH`-Werte mit dem Terminal, das Sie für die Anmeldung verwendet haben. Das in der [Fehlerbehebung](/de/guide/troubleshooting#auth-diagnostic-log) beschriebene Authentifizierungs-Diagnoseprotokoll ist der beste Ausgangspunkt.

### Codex

Installieren und authentifizieren Sie sich über den CLI-Ablauf von OpenAI:

```bash
codex login
```

Überprüfen Sie dann, ob die Runtime erreichbar ist:

```bash
codex --version
```

Codex-native Starts verwenden den Codex-Kontostatus und Modellkatalogdaten, sofern verfügbar. Wenn ein Modell in der Oberfläche fehlt, aktualisieren Sie den Anbieterstatus, bevor Sie Team-Prompts bearbeiten.

### OpenCode

Um das enthaltene kostenlose Modell ohne Authentifizierung zu verwenden, wählen Sie es in der App aus und starten Sie ohne Anbieterregistrierung. Um andere OpenCode-Backends zu verwenden, erstellen oder bearbeiten Sie `~/.opencode/config.json` (oder den entsprechenden Pfad auf Ihrer Plattform) mit dem gewünschten Anbieterschlüssel:

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-..."
    }
  }
}
```

Verwenden Sie den genauen Anbieternamen, den OpenCode erwartet. Wenn Sie einen benutzerdefinierten Anbieternamen festlegen, überprüfen Sie ihn anhand der Anbieter-ID, die Sie im Modell-String verwenden (zum Beispiel würde `openrouter/moonshotai/kimi-k2.6` den `openrouter`-Block verwenden).

Beispiele für Modell-Strings:

| Modell-String | Anbieterblock, der vorhanden sein muss |
| --- | --- |
| `openrouter/moonshotai/kimi-k2.6` | `openrouter` |
| `openai/gpt-5.4` | `openai` |
| `anthropic/claude-sonnet-4-6` | `anthropic` |

Wenn OpenCode startet, ein Teammitglied aber nie zustellbar wird, prüfen Sie die Lane-Belege, bevor Sie annehmen, dass das Modell den Prompt ignoriert hat. Siehe [Fehlerbehebung](/de/guide/troubleshooting#opencode-registered-but-bootstrap-unconfirmed).

## Multimodell-Modus

Der Multimodell-Modus kann Arbeit über viele Anbieter-Backends mittels OpenCode-kompatibler Konfiguration routen. Verwenden Sie ihn, wenn Sie Anbieterflexibilität benötigen oder möchten, dass Teammitglieder unterschiedliche Modell-Lanes nutzen.

::: info Modell-Lanes
Jedes Teammitglied kann ein anderes Paar aus `providerId` + `model` verwenden. Erweitern Sie in der Oberfläche zur Teambearbeitung die Mitgliedsoptionen, um die globalen Standardwerte zu überschreiben.
:::

Ein konservatives Multimodell-Setup:

| Rolle | Anbieter | Warum |
| --- | --- | --- |
| Lead | Claude oder Codex | Halten Sie die Koordination beim Anbieter, dem Sie am meisten vertrauen |
| Builder | OpenCode | Nutzen Sie breites Modell-Routing für Implementierungsarbeit |
| Reviewer | Claude, Codex oder ein zweites OpenCode-Modell | Trennen Sie das Review-Urteil von der Builder-Lane |

Vermeiden Sie es, beim ersten Start viele unbekannte Anbieter zu mischen. Bestätigen Sie eine kleine Aufgabe pro Lane, bevor Sie umfangreiche Arbeit zuweisen.

## Checkliste vor dem Start

Vor dem Start eines Teams:

1. Die ausgewählte Runtime ist installiert
2. Die Runtime-Binärdatei befindet sich im `PATH` der Umgebung
3. Die Anbieter-Authentifizierung ist für das gewählte Backend konfiguriert
4. Der Anbieter hat Zugriff auf den genauen Modell-String, den Sie angeben
5. Der Projektpfad existiert und ist lesbar

## Wann Runtime-Pfade gewechselt werden sollten

Wechseln Sie, wenn der aktuelle Pfad durch Modellverfügbarkeit, Ratenbegrenzungen, Anbieterfähigkeiten oder Anforderungen an Teamrollen blockiert ist. Behalten Sie denselben Projekt- und Team-Workflow bei, validieren Sie aber nach dem Wechsel eine kleine Aufgabe.

::: warning Behandeln Sie Einrichtungsfehler als Einrichtungsprobleme
Wenn die Authentifizierung fehlschlägt, ein Modellname abgelehnt wird oder die Runtime-Binärdatei nicht gefunden werden kann, beheben Sie zuerst die Einrichtung. Ändern Sie keine Team-Prompts oder Projektcode, um ein Problem mit der Runtime-Konfiguration zu umgehen.
:::

Verwenden Sie diese Entscheidungstabelle:

| Symptom | Bessere erste Maßnahme |
| --- | --- |
| Binärdatei nicht gefunden | Installation oder `PATH` korrigieren |
| Anmeldung funktioniert im Terminal, aber nicht in der App | Electron-Authentifizierungs-Diagnoseprotokoll und Umgebung prüfen |
| Modell abgelehnt | Genaue Modell-ID in der Anbieter-Runtime überprüfen |
| Wiederholte 429er | Parallelität senken oder Modell/Anbieter wechseln |
| OpenCode-Lane hängt | Lane-Manifest und `opencode-sessions.json` prüfen |
