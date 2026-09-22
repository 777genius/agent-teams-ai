---
title: Solución de problemas – Documentación de Agent Teams
description: Resuelve problemas de lanzamiento de equipos, respuestas de agentes faltantes, límites de uso, problemas de autenticación de la CLI y bloqueos en el bootstrap de los lanes con diagnósticos locales.
lang: es-ES
---

# Solución de problemas

La mayoría de los problemas de equipo entran en una de cuatro categorías: configuración del runtime, confirmación del lanzamiento, análisis de tareas y límites del proveedor.

## Configuración rápida de evidencias

Para cualquier problema del ciclo de vida del equipo, define primero estas variables y reutiliza el mismo shell:

```bash
TEAM="<team-name>"
TEAM_DIR="$HOME/.claude/teams/$TEAM"
TASKS_DIR="$HOME/.claude/tasks/$TEAM"
```

Luego confirma que los archivos esperados existen antes de interpretar el estado de la interfaz:

```bash
test -d "$TEAM_DIR" && find "$TEAM_DIR" -maxdepth 2 -type f | sort | sed -n '1,80p'
test -d "$TASKS_DIR" && find "$TASKS_DIR" -maxdepth 1 -name '*.json' | sort | sed -n '1,40p'
```

::: warning Las evidencias primero
No corrijas los prompts, la configuración del proveedor ni la limpieza de procesos basándote únicamente en una insignia atascada. Primero correlaciona la interfaz con los archivos persistidos, los artefactos de lanzamiento y la evidencia del runtime.
:::

## El equipo no se lanza

Comprueba cada elemento en orden:

1. **Runtime disponible** — la CLI seleccionada (`claude`, `codex`, `opencode`) está instalada
2. **PATH accesible** — el binario está disponible en el `PATH` del entorno
3. **Acceso al modelo** — el proveedor tiene acceso a la cadena de modelo solicitada (especialmente en OpenCode, donde los nombres exactos de proveedor/modelo importan)
4. **Ruta del proyecto** — el directorio del proyecto existe y se puede leer
5. **Red / VPN** — algunos proveedores descartan el tráfico cuando hay una VPN activa

::: tip
Ejecuta el binario del runtime en una terminal para verificar el `PATH` y la autenticación. Por ejemplo: `claude --version` u `opencode --version`.
:::

### OpenCode: registrado pero bootstrap sin confirmar

Si OpenCode muestra `registered` pero el bootstrap no está confirmado, inspecciona los artefactos primero antes de cambiar los prompts del equipo.

Los detalles para colaboradores/depuración están en [Arquitectura para colaboradores](/es/reference/contributor-architecture), que enlaza con el runbook canónico de depuración de equipos de agentes.

Observa el artefacto de fallo de lanzamiento más reciente:

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
MANIFEST_PATH="$(jq -r '.manifestPath' "$LATEST_FAILURE")"
jq '.classification, .bootstrapTransportBreadcrumb, .memberSpawnStatuses' "$MANIFEST_PATH"
```

`latest.json` apunta al directorio de artefactos empaquetados más reciente y a su `manifest.json`. El manifiesto incluye:

- `classification` — por qué se consideró que el lanzamiento fue un fallo
- `bootstrapTransportBreadcrumb` — ruta de entrega utilizada
- Los estados de spawn de los miembros
- Registros y trazas redactados

Comprueba también el manifiesto del lane:

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime/lanes" -maxdepth 2 -name manifest.json -print -exec jq '.activeRunId, .entries' {} \; 2>/dev/null
```

::: tip No adivines a partir de la interfaz
Correlaciona siempre los diagnósticos de la interfaz con los archivos persistidos (`launch-state.json`, `bootstrap-journal.jsonl`) y la evidencia específica del runtime.
:::

## Diagnósticos generales

Empieza por los archivos persistidos en disco en lugar de basarte solo en la interfaz.

### Raíz del equipo

```bash
printf '%s\n' "$TEAM_DIR"
```

Archivos clave y lo que te indican:

- `launch-state.json` — estado de lanzamiento/actividad de los miembros (`.teamLaunchState`, `.summary`, `.members`)
- `bootstrap-journal.jsonl` — eventos de bootstrap ordenados desde la CLI/runtime (`tail -80`)
- `bootstrap-state.json` — resumen de la fase de bootstrap
- `config.json` — configuración del proveedor, el modelo y el proyecto
- `inboxes/*.json` y `sentMessages.json` — estado de entrega de los mensajes

```bash
jq '.teamLaunchState, .summary, .members' "$TEAM_DIR/launch-state.json"
tail -80 "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

### Evidencia del runtime de OpenCode

Para los compañeros de equipo de OpenCode, la prueba de la sesión está en el almacén del runtime del lane:

- `.opencode-runtime/lanes.json` — índice de lanes con su estado
- `.opencode-runtime/lanes/<lane>/manifest.json` — `activeRunId` y entradas de evidencia
- `.opencode-runtime/lanes/<lane>/opencode-sessions.json` — registros de sesión confirmados

Estado saludable esperado: estado del lane `active`, el manifiesto tiene `activeRunId` con al menos una entrada de evidencia, el miembro tiene `bootstrapConfirmed: true`.

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime" -maxdepth 3 -type f | sort
```

### Artefactos de fallo de lanzamiento

Cuando un lanzamiento se marca como fallo, inspecciona `latest.json`:

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
jq '.' "$LATEST_FAILURE"
jq '.' "$(jq -r '.manifestPath' "$LATEST_FAILURE")"
```

El manifiesto incluye:
- `classification` — por qué se consideró que el lanzamiento fue un fallo
- `bootstrapTransportBreadcrumb` — ruta de entrega utilizada
- Los estados de spawn de los miembros y los registros/trazas redactados

## Faltan respuestas de los agentes

Abre los registros de tareas y los mensajes de los compañeros de equipo. Las respuestas faltantes suelen deberse a:

- **Reintento de entrega del runtime** — puede que el agente haya respondido, pero el mensaje no se entregó a la aplicación. Comprueba el ledger de entrega.
- **Análisis o filtrado** — la salida del agente no incluía los marcadores esperados ni las referencias de tarea.
- **Atribución de tarea** — el trabajo ocurrió durante la sesión pero no se vinculó a la tarea porque faltaba el id de tarea correcto en la salida.

::: warning No supongas que el silencio significa que se ignoró
No supongas que el modelo ignoró el mensaje hasta que los registros lo confirmen.
:::

Usa el estado persistido de los mensajes para separar lo "no enviado" de lo "enviado pero no renderizado":

```bash
jq '.' "$TEAM_DIR/inboxes/user.json" 2>/dev/null
jq '.' "$TEAM_DIR/sentMessages.json" 2>/dev/null
```

Comprueba `from`, `to`, `messageId`, `relayOfMessageId` y `taskRefs`. Para los compañeros de equipo de OpenCode, inspecciona también la evidencia de entrega del runtime antes de suponer que el modelo ignoró el prompt.

## Las tareas no están vinculadas a los cambios

Usa los registros específicos de cada tarea y los enlaces de revisión de código. Si un diff parece desvinculado:

- Comprueba si el id de tarea o la referencia de tarea se incluyó en la salida del agente.
- Verifica que el agente llamó a `task_add_comment` antes de hacer ediciones.
- Asegúrate de que el agente llamó a `task_start` para que el tablero supiera que el trabajo había comenzado.

Para los compañeros de equipo de OpenCode, la prueba fehaciente de que una sesión pertenece a una tarea está en `opencode-sessions.json` y la entrada del manifiesto del lane, no solo en el flujo de mensajes de la interfaz.

### Triaje del registro de tareas

Cuando un registro de tarea parezca incompleto, busca por id de tarea en el JSON de tareas, las bandejas de entrada y los eventos de bootstrap:

```bash
TASK="<short-or-full-task-id>"
rg -n "$TASK" "$TASKS_DIR" "$TEAM_DIR/inboxes" "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

Interpreta el resultado con cuidado:

| Evidencia | Qué demuestra | Qué no demuestra |
| --- | --- | --- |
| Mensaje entregado | La aplicación escribió o retransmitió un prompt | Que el agente progresó |
| Comentario de tarea | El agente publicó texto visible en el tablero | Que el comentario sea progreso significativo |
| Filas de herramientas nativas | El runtime hizo trabajo en una sesión | Que el trabajo pertenezca a esta tarea, a menos que la atribución coincida |
| Entrada del ledger de cambios | La aplicación registró cambios de archivo | Que la implementación sea correcta |

En OpenCode, un registro de tarea saludable suele incluir filas nativas del runtime como `read`, `bash`, `edit` o `write`, además de filas de MCP de Agent Teams. Si solo ves filas `agent-teams_*`, confirma la atribución de la tarea y los límites de la sesión antes de ampliar la coincidencia de registros.

## Límites de uso

Si un proveedor informa de una hora de restablecimiento conocida, Agent Teams puede indicar al lead que continúe tras el enfriamiento. Si se desconoce la hora de restablecimiento, espera o cambia de proveedor/ruta de runtime.

| Comportamiento del proveedor | Acción sugerida |
| --- | --- |
| Se muestra una hora de restablecimiento conocida | Espera el enfriamiento y continúa |
| No se muestra ninguna hora de restablecimiento | Cambia de proveedor o de ruta de runtime |
| 429 repetidos | Reduce la concurrencia o usa un lane de modelo distinto |

## Problemas de autenticación de la CLI

### `claude login` no persiste

Si la CLI está autenticada en una terminal pero la aplicación dice que no lo está, verifica que la autenticación se guarda en la ruta de configuración esperada y que el proceso de la aplicación ve el mismo `$HOME`.

### Clave del proveedor de OpenCode rechazada

- Verifica que el nombre del proveedor en `config.json` coincide con el prefijo del proveedor en la cadena de modelo
- Asegúrate de que la clave no haya caducado ni haya sido revocada en el panel del proveedor

### Registro de diagnóstico de autenticación

Cada llamada a `CliInstallerService.getStatus()` añade una línea a `claude-cli-auth-diag.ndjson` en la carpeta de registros de Electron (normalmente `~/Library/Logs/<product-name>/` en macOS). Si el archivo supera los **512 KiB**, se trunca a vacío antes de la siguiente escritura.

Comprueba este archivo si ves "Not logged in" o errores de autenticación en la aplicación empaquetada.

## Bootstrap del lane atascado

Para los lanes secundarios de OpenCode:

- La ausencia de `inboxes/<member>.json` no es automáticamente un error. Los lanes de OpenCode no tienen que crearse mediante la bandeja de entrada primaria antes de arrancar.
- Si la interfaz muestra que el equipo aún se está lanzando mientras los miembros primarios ya son utilizables, "se han unido todos los compañeros de equipo" está esperando a los lanes secundarios.
- Si `Prepared communication channels for X/Y members` se queda colgado, verifica si `Y` incluye incorrectamente a miembros secundarios de OpenCode.

### Entradas vacías en el manifiesto del lane

Si el puente dice que el bootstrap tuvo éxito pero `manifest.json` muestra `entries: []`, el problema es la **confirmación de la evidencia**, no el comportamiento del modelo. El miembro no debe considerarse entregable hasta que existan `opencode-sessions.json` y su entrada en el manifiesto.

## Estados comunes de los miembros

| Estado | Significado |
| --- | --- |
| `confirmed_alive` + `bootstrapConfirmed` | Saludable y listo |
| `registered` / `runtime_pending_bootstrap` | El proceso o el lane existe, pero la prueba de bootstrap aún no se ha confirmado |
| `failed_to_start` + `runtime_process` | El proceso existe, pero la puerta de lanzamiento falló. Comprueba los diagnósticos |
| `failed_to_start` + `stale_metadata` | El pid/sesión guardado está obsoleto o muerto |

::: warning
`member_briefing` por sí solo NO es evidencia del runtime. Para OpenCode, la prueba fehaciente es la evidencia del runtime confirmada, como `opencode-sessions.json` y la entrada del manifiesto.
:::

## Modo de depuración del runtime

Para la depuración local, puedes forzar que los compañeros de equipo se ejecuten en paneles de tmux:

```bash
# Launch from a terminal
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev

# Or add to custom CLI args
--teammate-mode tmux
```

Úsalo para inspeccionar el comportamiento interactivo de la CLI. No lo consideres totalmente equivalente al backend de procesos.

## Comprobaciones rápidas

Usa la aplicación de escritorio Electron para la validación normal. El modo de desarrollo en navegador/web no incluye el runtime de escritorio completo, el IPC, la autenticación del proveedor, la terminal ni el comportamiento del ciclo de vida del equipo.

### Cambios solo en la documentación

Desde la raíz del repositorio:

```bash
pnpm --dir landing docs:build
git diff --check -- landing/product-docs
```

### Cambios en el ciclo de vida del equipo

Empieza de forma acotada y luego amplía:

```bash
pnpm test -- test/main/services/team/TeamProvisioningService.test.ts
pnpm test -- test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts
pnpm typecheck
git diff --check
```

### Prueba rápida de un equipo en vivo

Usa un equipo pequeño y un proyecto desechable bajo control de Git:

1. Inicia la aplicación de escritorio con `pnpm dev`.
2. Crea un lead más un builder.
3. Pide un cambio mínimo con un comando de verificación explícito.
4. Confirma que la tarea pasa de `pending` -> `in_progress` -> `completed`.
5. Abre los registros de tareas y verifica que las filas de herramientas, los comentarios de tarea y los cambios de archivo cuadran.
6. Detén únicamente el equipo/procesos propios de la prueba rápida al limpiar.

::: warning Limpieza acotada únicamente
No mates todos los hosts de OpenCode, paneles de tmux no relacionados ni equipos de usuario mientras limpias una prueba rápida.
:::

## Limpieza segura

Al limpiar procesos obsoletos:

1. Identifica el pid y confirma que pertenece al equipo / lane actual.
2. Detén únicamente los procesos que pertenezcan explícitamente a una prueba rápida o al lanzamiento que estás depurando.
3. **No mates** todos los procesos de OpenCode ni de hosts compartidos como atajo.

## Cuándo recopilar evidencias

Antes de pedir ayuda, recopila:

- El id de tarea (corto o completo)
- El nombre del equipo
- La ruta del runtime (`claude`, `codex` u `opencode`)
- Un extracto del registro de lanzamiento (de `latest.json` o `bootstrap-journal.jsonl`)
- La cadena de proveedor / modelo
- La ventana de tiempo exacta en la que ocurrió el problema

Estos datos suelen ser suficientes para depurar problemas del ciclo de vida del lanzamiento y de las tareas.

::: tip
Si el problema persiste, abre los archivos persistidos del equipo en `~/.claude/teams/<teamName>/` y correlaciona los diagnósticos de la interfaz con el estado de los procesos en vivo antes de cambiar código.
:::
