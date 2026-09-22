---
title: MCP-Integration – Agent Teams Dokumentation
description: Konfigurieren Sie MCP in Agent Teams für Board-Operationen, Teamkoordination, externe Tool-Server und die Entwicklung eigener Tools.
lang: de-DE
---

# MCP-Integration

Agent Teams nutzt MCP in zwei praktischen Schichten:

| Schicht | Funktion | Wer es nutzt |
| --- | --- | --- |
| Integrierter Board-Server | Stellt die Tools von Agent Teams für Aufgaben, Nachrichten, Reviews, Prozesse, Runtimes und teamübergreifende Zusammenarbeit bereit | Leads und von der App gestartete Teammitglieder |
| Externe MCP-Server | Fügen optionale Tools hinzu, etwa Browser-Automatisierung, Design-Kontext, Doku-Suche oder Unternehmenssysteme | Benutzer und konfigurierte Runtimes |

Halten Sie diese Schichten getrennt. Der integrierte MCP-Server `agent-teams` ist der Weg, über den Agenten innerhalb von Agent Teams koordinieren. Externe MCP-Server sind optionale Runtime-Tools.

## Wie Agent Teams MCP einspeist

Wenn die Desktop-App Claude-basierte Teammitglieder startet, schreibt sie eine temporäre `--mcp-config`-JSON-Datei, die den integrierten Server `agent-teams` enthält:

```json
{
  "mcpServers": {
    "agent-teams": {
      "command": "node",
      "args": ["/path/to/agent-teams-mcp/index.js"],
      "env": {
        "AGENT_TEAMS_MCP_CLAUDE_DIR": "/Users/you/.claude"
      }
    }
  }
}
```

In der Entwicklung kann der Befehl über `tsx` auf `mcp-server/src/index.ts` zeigen. In paketierten Builds kopiert die App den gebündelten MCP-Server an einen stabilen App-Daten-Pfad und führt ihn mit Node aus. Die generierte Datei gehört der App und wird nach bestem Bemühen wieder bereinigt.

Benutzer- und Projekt-MCP-Server bleiben getrennt. Die App liest installierte Server aus:

| Geltungsbereich | Speicherort |
| --- | --- |
| Benutzer | `~/.claude.json` unter `mcpServers` |
| Lokaler Projekteintrag in der Claude-Konfiguration | `~/.claude.json` unter `projects[projectPath].mcpServers` |
| Projekt | `<project>/.mcp.json` unter `mcpServers` |

Bevorzugen Sie den Projekt-Geltungsbereich für Tools, die zu einem einzelnen Repository gehören. Bevorzugen Sie den Benutzer-Geltungsbereich für Tools, die Sie projektübergreifend wiederverwenden.

## Beispiel für ein Projekt-`.mcp.json`

Legen Sie diese Datei im Projekt-Stammverzeichnis ab, wenn ein Team denselben projektbezogenen Server sehen soll:

```json
{
  "mcpServers": {
    "docs-search": {
      "command": "npx",
      "args": ["-y", "@acme/docs-search-mcp"],
      "env": {
        "DOCS_INDEX_PATH": "./docs-index"
      }
    },
    "local-browser": {
      "command": "node",
      "args": ["./tools/mcp/browser-server.js"]
    }
  }
}
```

Halten Sie Geheimnisse aus eingecheckten `.mcp.json`-Dateien heraus. Legen Sie Zugangsdaten in Ihrer Shell, in einer benutzerbezogenen Konfiguration oder im benutzerdefinierten MCP-Installationsablauf der App ab, wenn der Wert lokal bleiben muss.

## Board-MCP-Workflow

Agenten sollten Board-MCP-Tools nutzen, wenn die Arbeit zu einer Aufgabe gehört:

1. Lesen Sie den aktuellen Aufgabenkontext.
2. Starten Sie die Aufgabe erst, wenn Sie tatsächlich mit der Arbeit beginnen.
3. Fügen Sie Aufgabenkommentare für Blocker, Pläne und Endergebnisse hinzu.
4. Markieren Sie die Aufgabe als abgeschlossen, nachdem der Ergebniskommentar gepostet wurde.
5. Senden Sie eine kurze Nachricht, wenn ein Lead oder Teammitglied das Ergebnis kennen muss.

Beispiel für einen Agentenablauf:

```text
task_get -> task_start -> edit/test -> task_add_comment -> task_complete -> message_send
```

Verwenden Sie eine Direktnachricht für die Koordination. Verwenden Sie einen Aufgabenkommentar für eine dauerhafte Aufgabenhistorie.

::: tip
Wenn der Hinweis Review, Verifizierung, geänderten Umfang oder einen Blocker betrifft, hinterlegen Sie ihn an der Aufgabe.
:::

## Integrierte Agent-Teams-Tools

Der MCP-Server registriert Tools aus `agent-teams-controller/src/mcpToolCatalog.js`. Die Registrierungsschleife befindet sich in `mcp-server/src/tools/index.ts`, und jede Gruppe hat ihre eigene Datei unter `mcp-server/src/tools/`.

Häufige Betriebstools:

| Tool | Verwendung |
| --- | --- |
| `task_get` | Liest den aktuellen Aufgabenkontext, Kommentare, Anhänge, Status und Beziehungen |
| `task_start` | Markiert eine Aufgabe als in Arbeit, wenn die Arbeit tatsächlich beginnt |
| `task_add_comment` | Fügt Blocker-Notizen, Verifizierungsnotizen, Pläne und abschließende Ergebniszusammenfassungen hinzu |
| `task_complete` | Schließt eine Aufgabe ab, nachdem der abschließende Ergebniskommentar gepostet wurde |
| `message_send` | Sendet eine sichtbare Posteingangsnachricht an einen Lead, ein Teammitglied oder einen Benutzer |
| `review_request`, `review_start`, `review_approve`, `review_request_changes` | Bewegen aufgabenbezogene Review-Workflows |
| `process_register`, `process_list`, `process_stop`, `process_unregister` | Verfolgen teammitgliedseigene Dev-Server, Watcher und andere Hintergrunddienste |

Tool-Namen können Runtimes mit MCP-Namespace-Präfixen erscheinen, zum Beispiel `mcp__agent-teams__task_get`. Der kanonische Tool-Name innerhalb des MCP-Servers bleibt `task_get`.

## Ein neues integriertes Tool registrieren

Für Arbeiten am Agent-Teams-Repository fügen Sie integrierte Board-Tools über die vorhandene FastMCP-Struktur hinzu:

1. Fügen Sie die Tool-Implementierung in die passende Datei unter `mcp-server/src/tools/` ein, oder erstellen Sie eine neue Gruppendatei, wenn die Domäne tatsächlich neu ist.
2. Fügen Sie den Tool-Namen der entsprechenden Gruppe in `agent-teams-controller/src/mcpToolCatalog.js` hinzu.
3. Binden Sie eine neue Gruppe nur dann über `mcp-server/src/tools/index.ts` ein, wenn eine neue Domänengruppe benötigt wird.
4. Validieren Sie die Eingabe mit `zod` und rufen Sie die Controller-API auf, anstatt Board-Dateien direkt zu lesen.
5. Fügen Sie gezielte Tests in `mcp-server/test/tools.test.ts` hinzu oder einen e2e-Fall, wenn der Transport eine Rolle spielt.

Minimale Struktur:

```ts
server.addTool({
  name: 'task_example',
  description: 'Explain what this tool does for agents.',
  parameters: z.object({
    teamName: z.string().min(1),
    claudeDir: z.string().min(1).optional(),
    taskId: z.string().min(1)
  }),
  execute: async ({ teamName, claudeDir, taskId }) => {
    assertConfiguredTeam(teamName, claudeDir);
    const controller = getController(teamName, claudeDir);
    return jsonTextContent(controller.tasks.getTask(taskId));
  }
});
```

Erstellen Sie kein Tool, das die Controller-Validierung umgeht, unzusammenhängende Team-Dateien verändert oder breiten Datei-/Prozesszugriff ohne eng begrenzten Aufgabenbedarf offenlegt.

## Externe MCP-Server

Verwenden Sie externe MCP-Server, wenn ein Teammitglied eine dauerhafte Tool-Verbindung benötigt und nicht nur einen einzelnen Prompt mit eingefügtem Kontext.

Gute Anwendungsfälle:

- Browser- oder Website-Test-Tools
- Design- oder Produktdaten-Tools
- interne Doku- und Suchsysteme
- Issue-Tracker- oder Support-Systeme
- Datenbankinspektions-Tools mit schreibgeschützten Zugangsdaten

Schlechte Anwendungsfälle:

- Geheimnisse, die in Prompts eingefügt werden
- einmalige Dateien, die direkt angehängt werden können
- Tools, die Produktionssysteme ohne Review verändern
- breiter lokaler Dateisystemzugriff, wenn ein engerer Projekt-Geltungsbereich ausreicht

## Geltungsbereiche

Agent Teams erkennt gemeinsam genutzte und projektorientierte MCP-Geltungsbereiche.

| Geltungsbereich | Verwenden, wenn |
| --- | --- |
| Benutzer oder Global | Derselbe Server soll projektübergreifend verfügbar sein |
| Projekt oder Lokal | Der Server gehört zu einem Repository, Arbeitsbereich oder Team-Kontext |

Bevorzugen Sie den engsten Geltungsbereich, der den Workflow weiterhin nutzbar macht. Projektbezogene Server sind beim Review leichter nachzuvollziehen, weil das Tool zum geänderten Projekt gehört.

## Einrichtungs-Checkliste

Bevor Sie eine Aufgabe zuweisen, die von einem MCP-Server abhängt:

1. Installieren oder konfigurieren Sie den Server.
2. Bestätigen Sie, dass er in der Liste der installierten MCP-Server der App im vorgesehenen Geltungsbereich erscheint.
3. Führen Sie Diagnosen aus der MCP-Registry oder der Erweiterungs-UI aus, sofern verfügbar.
4. Beginnen Sie mit einer risikoarmen, schreibgeschützten Aufgabe.
5. Erwähnen Sie die erwartete MCP-Tool-Nutzung in der Aufgabenbeschreibung oder im Team-Briefing.

Wenn ein Server die Diagnose nicht besteht, beheben Sie das zuerst. Ein besserer Aufgaben-Prompt repariert weder einen fehlenden Befehl noch einen falschen Konfigurationspfad oder abgelehnte Zugangsdaten.

## Einen eigenen Server aus der App installieren

Die Desktop-App stellt MCP-Registry-APIs über Electron-IPC bereit – für Suche, Durchsuchen, Installation, benutzerdefinierte Installation, Deinstallation, das Lesen des Installationszustands und Diagnosen. Benutzerdefinierte Installationen validieren den Servernamen, den Geltungsbereich, den Projektpfad, die Namen der Umgebungsvariablen und die HTTP-Header, bevor der Installationspfad der Runtime aufgerufen wird.

Verwenden Sie die benutzerdefinierte Installation, wenn Sie ein MCP-Paket haben, das noch nicht in der Registry ist:

| Feld | Beispiel |
| --- | --- |
| Servername | `docs-search` |
| Geltungsbereich | `project` für dieses Repository, `user` für alle Projekte |
| Typ | `stdio` für lokale Befehle, `http` oder `sse` für entfernte Server |
| Paket | `@acme/docs-search-mcp` |
| Env | `DOCS_INDEX_PATH=./docs-index` |

Führen Sie nach der Installation eine Diagnose durch und erstellen Sie eine kleine, schreibgeschützte Aufgabe, um die Tool-Oberfläche zu prüfen, bevor Sie größere Arbeit zuweisen.

## Aufgabenbeispiel

```text
Audit the docs home page with the browser MCP. Check desktop and mobile widths, capture any layout issue as a task comment, and only edit landing/product-docs files. Run `pnpm --dir landing docs:build` before completion.
```

Das funktioniert, weil es das Tool, die Oberfläche, die Schreibgrenze und den Verifizierungsschritt benennt.

## Sicherheitsregeln

- Geben Sie nicht standardmäßig jedem Teammitglied jeden MCP-Server.
- Halten Sie schreibfähige Tools aus breiten Teams heraus, sofern der Review sie nicht erfordert.
- Bevorzugen Sie schreibgeschützte Zugangsdaten für Inspektionsaufgaben.
- Stellen Sie produktionswirksame Tool-Nutzung hinter explizite Aufgabenkommentare und Review.
- Behandeln Sie MCP-Diagnosefehler als Einrichtungsfehler, nicht als Agentenfehler.
- Vermeiden Sie es, Geheimnisse in `.mcp.json` oder Prompts einzuchecken.
- Verwenden Sie absolute `projectPath`-Werte, wenn Sie projektbezogene Server über die App installieren.
- Bearbeiten Sie nicht die von der App generierten `agent-teams-mcp-*.json`-Dateien; sie sind temporäre Start-Artefakte.

## Verwandte Anleitungen

- [Runtime-Einrichtung](/de/guide/runtime-setup)
- [Team-Briefing-Beispiele](/de/guide/team-brief-examples)
- [Agent-Workflow](/de/guide/agent-workflow)
- [Entwickler](/de/developers/)
