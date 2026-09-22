---
title: Fehlerbehebung – Agent Teams Dokumentation
description: Beheben Sie Probleme beim Team-Start, fehlende Agent-Antworten, Ratenbegrenzungen, CLI-Authentifizierungsprobleme und Hänger beim Lane-Bootstrap mit lokalen Diagnosen.
lang: de-DE
---

# Fehlerbehebung

Die meisten Team-Probleme fallen in eine von vier Kategorien: Runtime-Einrichtung, Start-Bestätigung, Aufgaben-Parsing und Anbieterlimits.

## Schnelle Beweissicherung

Definieren Sie bei jedem Problem im Team-Lebenszyklus zuerst diese Variablen und verwenden Sie dieselbe Shell weiter:

```bash
TEAM="<team-name>"
TEAM_DIR="$HOME/.claude/teams/$TEAM"
TASKS_DIR="$HOME/.claude/tasks/$TEAM"
```

Bestätigen Sie dann, dass die erwarteten Dateien existieren, bevor Sie den UI-Zustand interpretieren:

```bash
test -d "$TEAM_DIR" && find "$TEAM_DIR" -maxdepth 2 -type f | sort | sed -n '1,80p'
test -d "$TASKS_DIR" && find "$TASKS_DIR" -maxdepth 1 -name '*.json' | sort | sed -n '1,40p'
```

::: warning Beweise zuerst
Beheben Sie Prompts, Anbietereinstellungen oder Prozessbereinigungen nicht allein auf Basis eines hängenden Badges. Korrelieren Sie zuerst die UI mit den persistierten Dateien, Start-Artefakten und Runtime-Beweisen.
:::

## Team startet nicht

Prüfen Sie jeden Punkt der Reihe nach:

1. **Runtime verfügbar** — die ausgewählte CLI (`claude`, `codex`, `opencode`) ist installiert
2. **PATH erreichbar** — die Binärdatei ist im `PATH` der Umgebung verfügbar
3. **Modellzugriff** — der Anbieter hat Zugriff auf die angeforderte Modellzeichenfolge (besonders bei OpenCode sind exakte Anbieter-/Modellnamen wichtig)
4. **Projektpfad** — das Projektverzeichnis existiert und ist lesbar
5. **Netzwerk / VPN** — manche Anbieter verwerfen Datenverkehr, wenn ein VPN aktiv ist

::: tip
Führen Sie die Runtime-Binärdatei in einem Terminal aus, um `PATH` und Authentifizierung zu überprüfen. Beispiel: `claude --version` oder `opencode --version`.
:::

### OpenCode: registriert, aber Bootstrap unbestätigt

Wenn OpenCode `registered` anzeigt, der Bootstrap aber unbestätigt ist, untersuchen Sie zuerst die Artefakte, bevor Sie Team-Prompts ändern.

Details für Mitwirkende/zur Fehlersuche finden Sie unter [Architektur für Mitwirkende](/de/reference/contributor-architecture), die auf das maßgebliche Debugging-Runbook für Agent-Teams verweist.

Sehen Sie sich das neueste Artefakt eines fehlgeschlagenen Starts an:

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
MANIFEST_PATH="$(jq -r '.manifestPath' "$LATEST_FAILURE")"
jq '.classification, .bootstrapTransportBreadcrumb, .memberSpawnStatuses' "$MANIFEST_PATH"
```

`latest.json` verweist auf das neueste gepackte Artefaktverzeichnis und dessen `manifest.json`. Das Manifest enthält:

- `classification` — warum der Start als Fehlschlag gewertet wurde
- `bootstrapTransportBreadcrumb` — verwendeter Zustellungspfad
- Spawn-Status der Mitglieder
- Redigierte Logs und Traces

Prüfen Sie auch das Lane-Manifest:

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime/lanes" -maxdepth 2 -name manifest.json -print -exec jq '.activeRunId, .entries' {} \; 2>/dev/null
```

::: tip Nicht aus der UI raten
Korrelieren Sie UI-Diagnosen immer mit persistierten Dateien (`launch-state.json`, `bootstrap-journal.jsonl`) und runtime-spezifischen Beweisen.
:::

## Allgemeine Diagnose

Beginnen Sie mit den persistierten Dateien auf dem Datenträger statt allein mit der UI.

### Team-Wurzelverzeichnis

```bash
printf '%s\n' "$TEAM_DIR"
```

Wichtige Dateien und was sie Ihnen verraten:

- `launch-state.json` — Start-/Lebendigkeitszustand der Mitglieder (`.teamLaunchState`, `.summary`, `.members`)
- `bootstrap-journal.jsonl` — geordnete Bootstrap-Ereignisse von CLI/Runtime (`tail -80`)
- `bootstrap-state.json` — Zusammenfassung der Bootstrap-Phase
- `config.json` — Anbieter-, Modell- und Projektkonfiguration
- `inboxes/*.json` und `sentMessages.json` — Zustand der Nachrichtenzustellung

```bash
jq '.teamLaunchState, .summary, .members' "$TEAM_DIR/launch-state.json"
tail -80 "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

### OpenCode-Runtime-Beweise

Bei OpenCode-Teammitgliedern liegt der Sitzungsbeweis im Lane-Runtime-Speicher:

- `.opencode-runtime/lanes.json` — Lane-Index mit Zustand
- `.opencode-runtime/lanes/<lane>/manifest.json` — `activeRunId` und Beweiseinträge
- `.opencode-runtime/lanes/<lane>/opencode-sessions.json` — committete Sitzungsdatensätze

Erwarteter gesunder Zustand: Lane-Zustand `active`, das Manifest hat eine `activeRunId` mit mindestens einem Beweiseintrag, das Mitglied hat `bootstrapConfirmed: true`.

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime" -maxdepth 3 -type f | sort
```

### Artefakte fehlgeschlagener Starts

Wenn ein Start als Fehlschlag markiert ist, untersuchen Sie `latest.json`:

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
jq '.' "$LATEST_FAILURE"
jq '.' "$(jq -r '.manifestPath' "$LATEST_FAILURE")"
```

Das Manifest enthält:
- `classification` — warum der Start als Fehlschlag gewertet wurde
- `bootstrapTransportBreadcrumb` — verwendeter Zustellungspfad
- Spawn-Status der Mitglieder und redigierte Logs/Traces

## Agent-Antworten fehlen

Öffnen Sie Aufgabenprotokolle und Teammitglied-Nachrichten. Fehlende Antworten kommen häufig von:

- **Erneuter Zustellversuch der Runtime** — der Agent hat möglicherweise geantwortet, aber die Nachricht wurde nicht an die App zugestellt. Prüfen Sie das Zustellungsregister.
- **Parsing oder Filterung** — die Agent-Ausgabe enthielt nicht die erwarteten Marker oder Aufgabenreferenzen.
- **Aufgabenzuordnung** — die Arbeit fand während der Sitzung statt, wurde aber nicht mit der Aufgabe verknüpft, weil die korrekte Aufgaben-ID in der Ausgabe fehlte.

::: warning Schweigen nicht mit Ignorieren gleichsetzen
Gehen Sie nicht davon aus, dass das Modell die Nachricht ignoriert hat, bevor Logs dies bestätigen.
:::

Nutzen Sie den persistierten Nachrichtenzustand, um „nicht gesendet" von „gesendet, aber nicht gerendert" zu unterscheiden:

```bash
jq '.' "$TEAM_DIR/inboxes/user.json" 2>/dev/null
jq '.' "$TEAM_DIR/sentMessages.json" 2>/dev/null
```

Prüfen Sie `from`, `to`, `messageId`, `relayOfMessageId` und `taskRefs`. Untersuchen Sie bei OpenCode-Teammitgliedern auch die Runtime-Zustellungsbeweise, bevor Sie annehmen, dass das Modell den Prompt ignoriert hat.

## Aufgaben sind nicht mit Änderungen verknüpft

Verwenden Sie aufgabenspezifische Logs und Code-Review-Links. Wenn ein Diff losgelöst erscheint:

- Prüfen Sie, ob die Aufgaben-ID oder Aufgabenreferenz in der Agent-Ausgabe enthalten war.
- Verifizieren Sie, dass der Agent `task_add_comment` aufgerufen hat, bevor er Änderungen vorgenommen hat.
- Stellen Sie sicher, dass der Agent `task_start` aufgerufen hat, damit das Board weiß, dass die Arbeit begonnen hat.

Bei OpenCode-Teammitgliedern liegt der maßgebliche Beweis dafür, dass eine Sitzung zu einer Aufgabe gehört, in `opencode-sessions.json` und dem Eintrag im Lane-Manifest, nicht allein im UI-Nachrichtenstrom.

### Aufgabenprotokoll-Triage

Wenn ein Aufgabenprotokoll unvollständig erscheint, suchen Sie nach der Aufgaben-ID über Aufgaben-JSON, Inboxes und Bootstrap-Ereignisse hinweg:

```bash
TASK="<short-or-full-task-id>"
rg -n "$TASK" "$TASKS_DIR" "$TEAM_DIR/inboxes" "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

Interpretieren Sie das Ergebnis sorgfältig:

| Beweis | Was er belegt | Was er nicht belegt |
| --- | --- | --- |
| Nachricht zugestellt | Die App hat einen Prompt geschrieben oder weitergeleitet | Der Agent hat Fortschritt erzielt |
| Aufgabenkommentar | Der Agent hat board-sichtbaren Text gepostet | Der Kommentar ist bedeutsamer Fortschritt |
| Native Tool-Zeilen | Die Runtime hat in einer Sitzung gearbeitet | Die Arbeit gehört zu dieser Aufgabe, sofern die Zuordnung nicht passt |
| Eintrag im Änderungsregister | Die App hat Dateiänderungen aufgezeichnet | Die Implementierung ist korrekt |

Bei OpenCode enthält ein gesundes Aufgabenprotokoll üblicherweise native Runtime-Zeilen wie `read`, `bash`, `edit` oder `write` plus Agent-Teams-MCP-Zeilen. Wenn Sie nur `agent-teams_*`-Zeilen sehen, bestätigen Sie die Aufgabenzuordnung und Sitzungsgrenzen, bevor Sie die Log-Übereinstimmung erweitern.

## Ratenbegrenzungen

Wenn ein Anbieter eine bekannte Reset-Zeit meldet, kann Agent Teams den Lead anstoßen, nach der Abkühlphase fortzufahren. Ist die Reset-Zeit unbekannt, warten Sie oder wechseln Sie den Anbieter-/Runtime-Pfad.

| Anbieterverhalten | Empfohlene Maßnahme |
| --- | --- |
| Bekannte Reset-Zeit angezeigt | Auf Abkühlphase warten und fortfahren |
| Keine Reset-Zeit angezeigt | Anbieter oder Runtime-Pfad wechseln |
| Wiederholte 429er | Nebenläufigkeit senken oder eine andere Modell-Lane verwenden |

## CLI-Authentifizierungsprobleme

### `claude login` bleibt nicht erhalten

Wenn die CLI in einem Terminal authentifiziert ist, die App aber meldet, dass dies nicht der Fall ist, verifizieren Sie, dass die Authentifizierung im erwarteten Konfigurationspfad gespeichert ist und dass der App-Prozess dasselbe `$HOME` sieht.

### OpenCode-Anbieterschlüssel abgelehnt

- Überprüfen Sie noch einmal, ob der Anbietername in `config.json` mit dem Anbieter-Präfix in der Modellzeichenfolge übereinstimmt
- Stellen Sie sicher, dass der Schlüssel nicht abgelaufen oder im Anbieter-Dashboard widerrufen ist

### Authentifizierungs-Diagnoselog

Jeder Aufruf von `CliInstallerService.getStatus()` hängt eine Zeile an `claude-cli-auth-diag.ndjson` im Electron-Log-Ordner an (auf macOS üblicherweise `~/Library/Logs/<product-name>/`). Wenn die Datei **512 KiB** überschreitet, wird sie vor dem nächsten Schreibvorgang auf leer gekürzt.

Prüfen Sie diese Datei, wenn Sie in der gepackten App „Not logged in" oder Authentifizierungsfehler sehen.

## Lane-Bootstrap hängt

Für sekundäre OpenCode-Lanes:

- Eine fehlende `inboxes/<member>.json` ist nicht automatisch ein Fehler. OpenCode-Lanes müssen nicht zuerst per Primär-Inbox erstellt werden, bevor sie starten.
- Wenn die UI anzeigt, dass das Team noch startet, während primäre Mitglieder bereits nutzbar sind, wartet „all teammates joined" auf die sekundären Lanes.
- Wenn `Prepared communication channels for X/Y members` hängt, prüfen Sie, ob `Y` fälschlicherweise sekundäre OpenCode-Mitglieder einschließt.

### Leere Einträge im Lane-Manifest

Wenn die Bridge meldet, dass der Bootstrap erfolgreich war, aber `manifest.json` `entries: []` anzeigt, liegt das Problem beim **Commit der Beweise**, nicht am Modellverhalten. Das Mitglied darf erst als zustellbar gelten, wenn `opencode-sessions.json` und sein Manifest-Eintrag existieren.

## Häufige Mitgliedszustände

| Zustand | Bedeutung |
| --- | --- |
| `confirmed_alive` + `bootstrapConfirmed` | Gesund und bereit |
| `registered` / `runtime_pending_bootstrap` | Prozess oder Lane existiert, aber der Bootstrap-Beweis wurde noch nicht committet |
| `failed_to_start` + `runtime_process` | Prozess existiert, aber das Start-Gate ist fehlgeschlagen. Diagnose prüfen |
| `failed_to_start` + `stale_metadata` | Gespeicherte pid/Sitzung ist veraltet oder tot |

::: warning
`member_briefing` allein ist KEIN Runtime-Beweis. Bei OpenCode ist der maßgebliche Beweis committeter Runtime-Beweis wie `opencode-sessions.json` und der Manifest-Eintrag.
:::

## Runtime-Debug-Modus

Für lokales Debugging können Sie Teammitglieder dazu zwingen, in tmux-Panes zu laufen:

```bash
# Launch from a terminal
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev

# Or add to custom CLI args
--teammate-mode tmux
```

Verwenden Sie dies, um interaktives CLI-Verhalten zu untersuchen. Betrachten Sie dies nicht als vollständig gleichwertig mit dem Prozess-Backend.

## Rauchtests

Verwenden Sie die Desktop-Electron-App für die normale Validierung. Der Browser-/Web-Dev-Modus enthält nicht die vollständige Desktop-Runtime, IPC, Anbieter-Authentifizierung, das Terminal oder das Verhalten des Team-Lebenszyklus.

### Nur Dokumentationsänderungen

Vom Repository-Wurzelverzeichnis aus:

```bash
pnpm --dir landing docs:build
git diff --check -- landing/product-docs
```

### Änderungen am Team-Lebenszyklus

Beginnen Sie eng begrenzt und erweitern Sie dann:

```bash
pnpm test -- test/main/services/team/TeamProvisioningService.test.ts
pnpm test -- test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts
pnpm typecheck
git diff --check
```

### Live-Team-Rauchtest

Verwenden Sie ein kleines Team und ein Git-verfolgtes Wegwerfprojekt:

1. Starten Sie die Desktop-App mit `pnpm dev`.
2. Erstellen Sie einen Lead plus einen Builder.
3. Bitten Sie um eine winzige Änderung mit einem expliziten Verifizierungsbefehl.
4. Bestätigen Sie, dass die Aufgabe von `pending` -> `in_progress` -> `completed` wandert.
5. Öffnen Sie Aufgabenprotokolle und verifizieren Sie, dass Tool-Zeilen, Aufgabenkommentare und Dateiänderungen übereinstimmen.
6. Stoppen Sie beim Aufräumen nur das zum Rauchtest gehörende Team / die zugehörigen Prozesse.

::: warning Nur eng begrenztes Aufräumen
Beenden Sie beim Aufräumen eines Rauchtests nicht alle OpenCode-Hosts, nicht zusammenhängende tmux-Panes oder Benutzer-Teams.
:::

## Sicheres Aufräumen

Beim Aufräumen veralteter Prozesse:

1. Identifizieren Sie die pid und bestätigen Sie, dass sie zum aktuellen Team / zur aktuellen Lane gehört.
2. Stoppen Sie nur Prozesse, die explizit zu einem Rauchtest oder zu dem Start gehören, den Sie debuggen.
3. **Beenden Sie nicht** alle OpenCode- oder gemeinsam genutzten Host-Prozesse als Abkürzung.

## Wann Beweise zu sammeln sind

Bevor Sie um Hilfe bitten, sammeln Sie:

- Aufgaben-ID (kurz oder vollständig)
- Teamname
- Runtime-Pfad (`claude`, `codex` oder `opencode`)
- Auszug aus dem Start-Log (aus `latest.json` oder `bootstrap-journal.jsonl`)
- Anbieter-/Modellzeichenfolge
- Genaues Zeitfenster, in dem das Problem aufgetreten ist

Diese Daten reichen üblicherweise aus, um Probleme im Start- und Aufgabenlebenszyklus zu debuggen.

::: tip
Wenn das Problem weiterhin besteht, öffnen Sie die persistierten Dateien des Teams unter `~/.claude/teams/<teamName>/` und korrelieren Sie UI-Diagnosen mit dem Live-Prozesszustand, bevor Sie Code ändern.
:::
