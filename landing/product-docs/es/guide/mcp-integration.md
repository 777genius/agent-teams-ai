---
title: Integración de MCP – Documentación de Agent Teams
description: Configura MCP en Agent Teams para operaciones del tablero, coordinación entre compañeros de equipo, servidores de herramientas externas y desarrollo de herramientas personalizadas.
lang: es-ES
---

# Integración de MCP

Agent Teams utiliza MCP en dos capas prácticas:

| Capa | Qué hace | Quién la usa |
| --- | --- | --- |
| Servidor de tablero integrado | Expone las herramientas de tareas, mensajes, revisión, procesos, runtime y comunicación entre equipos de Agent Teams | Leads y compañeros de equipo lanzados por la aplicación |
| Servidores MCP externos | Añaden herramientas opcionales como automatización de navegador, contexto de diseño, búsqueda en documentación o sistemas de la empresa | Usuarios y runtimes configurados |

Mantén esas capas separadas. El servidor MCP integrado `agent-teams` es la forma en que los agentes se coordinan dentro de Agent Teams. Los servidores MCP externos son herramientas de runtime opcionales.

## Cómo inyecta MCP Agent Teams

Cuando la aplicación de escritorio lanza miembros de equipo basados en Claude, escribe un archivo JSON temporal `--mcp-config` que contiene el servidor integrado `agent-teams`:

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

En desarrollo, el comando puede apuntar a `mcp-server/src/index.ts` a través de `tsx`. En las compilaciones empaquetadas, la aplicación copia el servidor MCP incluido a una ruta estable de datos de la aplicación y lo ejecuta con Node. El archivo generado es propiedad de la aplicación y se limpia con el mejor esfuerzo posible.

Los servidores MCP de usuario y de proyecto permanecen separados. La aplicación lee los servidores instalados desde:

| Ámbito | Ubicación |
| --- | --- |
| Usuario | `~/.claude.json` bajo `mcpServers` |
| Entrada de proyecto local en la configuración de Claude | `~/.claude.json` bajo `projects[projectPath].mcpServers` |
| Proyecto | `<project>/.mcp.json` bajo `mcpServers` |

Prefiere el ámbito de proyecto para herramientas que pertenecen a un único repositorio. Prefiere el ámbito de usuario para herramientas que reutilizas en proyectos no relacionados.

## Ejemplo de `.mcp.json` de proyecto

Coloca este archivo en la raíz del proyecto cuando un equipo deba ver el mismo servidor con ámbito de proyecto:

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

Mantén los secretos fuera de los archivos `.mcp.json` confirmados en el control de versiones. Coloca las credenciales en tu shell, en una configuración con ámbito de usuario o en el flujo de instalación de MCP personalizado de la aplicación si el valor debe permanecer local.

## Flujo de trabajo de MCP del tablero

Los agentes deben usar las herramientas MCP del tablero cuando el trabajo pertenece a una tarea:

1. Lee el contexto más reciente de la tarea.
2. Inicia la tarea solo cuando realmente comiences a trabajar.
3. Añade comentarios de tarea para bloqueos, planes y resultados finales.
4. Marca la tarea como completada después de publicar el comentario con el resultado.
5. Envía un mensaje breve cuando un lead o un compañero de equipo necesite conocer el resultado.

Ejemplo de flujo de un agente:

```text
task_get -> task_start -> edit/test -> task_add_comment -> task_complete -> message_send
```

Usa un mensaje directo para la coordinación. Usa un comentario de tarea para dejar un historial duradero de la tarea.

::: tip
Si la nota afecta a la revisión, la verificación, un cambio de alcance o un bloqueo, ponla en la tarea.
:::

## Herramientas integradas de Agent Teams

El servidor MCP registra herramientas desde `agent-teams-controller/src/mcpToolCatalog.js`. El bucle de registro vive en `mcp-server/src/tools/index.ts`, y cada grupo tiene su propio archivo bajo `mcp-server/src/tools/`.

Herramientas operativas habituales:

| Herramienta | Uso |
| --- | --- |
| `task_get` | Lee el contexto más reciente de la tarea, los comentarios, los adjuntos, el estado y las relaciones |
| `task_start` | Marca una tarea en in progress cuando el trabajo realmente comienza |
| `task_add_comment` | Añade notas de bloqueo, notas de verificación, planes y resúmenes de resultado final |
| `task_complete` | Completa una tarea después de publicar el comentario con el resultado final |
| `message_send` | Envía un mensaje visible en la bandeja de entrada a un lead, un compañero de equipo o un usuario |
| `review_request`, `review_start`, `review_approve`, `review_request_changes` | Avanzan los flujos de trabajo de revisión con ámbito de tarea |
| `process_register`, `process_list`, `process_stop`, `process_unregister` | Hacen seguimiento de los servidores de desarrollo, watchers y otros servicios en segundo plano propiedad de los compañeros de equipo |

Los nombres de las herramientas pueden aparecer ante los runtimes con prefijos de espacio de nombres de MCP, por ejemplo `mcp__agent-teams__task_get`. El nombre canónico de la herramienta dentro del servidor MCP sigue siendo `task_get`.

## Registrar una nueva herramienta integrada

Para el trabajo en el repositorio de Agent Teams, añade herramientas integradas del tablero a través de la estructura existente de FastMCP:

1. Añade la implementación de la herramienta al archivo correspondiente en `mcp-server/src/tools/`, o crea un nuevo archivo de grupo si el dominio es realmente nuevo.
2. Añade el nombre de la herramienta al grupo apropiado en `agent-teams-controller/src/mcpToolCatalog.js`.
3. Conecta un nuevo grupo a través de `mcp-server/src/tools/index.ts` solo cuando se necesite un nuevo grupo de dominio.
4. Valida la entrada con `zod` y llama a la API del controlador en lugar de leer los archivos del tablero directamente.
5. Añade pruebas específicas en `mcp-server/test/tools.test.ts` o un caso e2e cuando el transporte sea relevante.

Estructura mínima:

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

No crees una herramienta que omita la validación del controlador, modifique archivos de equipo no relacionados o exponga un acceso amplio al sistema de archivos o a los procesos sin una necesidad concreta de la tarea.

## Servidores MCP externos

Usa servidores MCP externos cuando un compañero de equipo necesite una conexión duradera a una herramienta, no solo un prompt con contexto pegado.

Buenos casos de uso:

- herramientas de pruebas de navegador o de sitios web
- herramientas de datos de diseño o de producto
- documentación interna y sistemas de búsqueda
- sistemas de seguimiento de incidencias o de soporte
- herramientas de inspección de bases de datos con credenciales de solo lectura

Malos casos de uso:

- secretos pegados en los prompts
- archivos puntuales que se pueden adjuntar directamente
- herramientas que modifican sistemas de producción sin revisión
- acceso amplio al sistema de archivos local cuando basta con un ámbito de proyecto más reducido

## Ámbitos

Agent Teams reconoce ámbitos de MCP compartidos y orientados al proyecto.

| Ámbito | Úsalo cuando |
| --- | --- |
| Usuario o Global | El mismo servidor debe estar disponible en varios proyectos |
| Proyecto o Local | El servidor pertenece a un único repositorio, espacio de trabajo o contexto de equipo |

Prefiere el ámbito más reducido que aún haga utilizable el flujo de trabajo. Los servidores con ámbito de proyecto son más fáciles de razonar durante la revisión porque la herramienta pertenece al proyecto que se está modificando.

## Lista de comprobación de configuración

Antes de asignar una tarea que dependa de un servidor MCP:

1. Instala o configura el servidor.
2. Confirma que aparece en la lista de MCP instalados de la aplicación para el ámbito previsto.
3. Ejecuta los diagnósticos desde el registro de MCP o la interfaz de extensiones cuando esté disponible.
4. Empieza con una tarea de solo lectura de bajo riesgo.
5. Menciona el uso previsto de la herramienta MCP en la descripción de la tarea o en el briefing del equipo.

Si un servidor falla en los diagnósticos, corrige eso primero. Un mejor prompt de tarea no reparará un comando ausente, una ruta de configuración incorrecta o unas credenciales rechazadas.

## Instalar un servidor personalizado desde la aplicación

La aplicación de escritorio expone las API del registro de MCP a través de IPC de Electron para búsqueda, exploración, instalación, instalación personalizada, desinstalación, lectura del estado instalado y diagnósticos. Las instalaciones personalizadas validan el nombre del servidor, el ámbito, la ruta del proyecto, los nombres de las variables de entorno y las cabeceras HTTP antes de llamar a la ruta de instalación del runtime.

Usa la instalación personalizada cuando tengas un paquete MCP que aún no esté en el registro:

| Campo | Ejemplo |
| --- | --- |
| Nombre del servidor | `docs-search` |
| Ámbito | `project` para este repositorio, `user` para todos los proyectos |
| Tipo | `stdio` para comandos locales, `http` o `sse` para servidores remotos |
| Paquete | `@acme/docs-search-mcp` |
| Env | `DOCS_INDEX_PATH=./docs-index` |

Tras la instalación, ejecuta los diagnósticos y crea una pequeña tarea de solo lectura para comprobar la superficie de la herramienta antes de asignar trabajo más grande.

## Ejemplo de tarea

```text
Audit the docs home page with the browser MCP. Check desktop and mobile widths, capture any layout issue as a task comment, and only edit landing/product-docs files. Run `pnpm --dir landing docs:build` before completion.
```

Esto funciona porque nombra la herramienta, la superficie, el límite de escritura y el paso de verificación.

## Reglas de seguridad

- No des todos los servidores MCP a todos los compañeros de equipo por defecto.
- Mantén las herramientas con capacidad de escritura fuera de los equipos amplios, salvo que la revisión las requiera.
- Prefiere credenciales de solo lectura para las tareas de inspección.
- Pon el uso de herramientas con impacto en producción detrás de comentarios de tarea explícitos y de revisión.
- Trata los fallos de diagnóstico de MCP como fallos de configuración, no como fallos del agente.
- Evita confirmar secretos en `.mcp.json` o en los prompts.
- Usa valores absolutos de `projectPath` al instalar servidores con ámbito de proyecto a través de la aplicación.
- No edites los archivos `agent-teams-mcp-*.json` generados por la aplicación; son artefactos temporales de lanzamiento.

## Guías relacionadas

- [Configuración del runtime](/es/guide/runtime-setup)
- [Ejemplos de briefing de equipo](/es/guide/team-brief-examples)
- [Flujo de trabajo de los agentes](/es/guide/agent-workflow)
- [Desarrolladores](/es/developers/)
