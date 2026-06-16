---
title: Revisión de código – Documentación de Agent Teams
description: Inspecciona los diffs delimitados por tarea, acepta o rechaza hunks, deja comentarios en línea y gestiona los estados de revisión desde none hasta approved.
lang: es-ES
---

# Revisión de código

La revisión de código en Agent Teams está centrada en las tareas. Inspeccionas lo que cambió para una tarea específica en lugar de rastrear a través de un diff grande y sin estructura.

## Superficie de revisión

Para cada tarea completada que tocó archivos, la interfaz de revisión te permite:

- Inspeccionar los archivos modificados con contexto de antes/después
- Aceptar o rechazar hunks individuales
- Dejar comentarios en línea
- Conectar el diff con la descripción de la tarea y los registros del agente

## Decisiones a nivel de hunk

Acepta los cambios pequeños y correctos y rechaza los errores aislados sin descartar toda la tarea. Esto es útil cuando un agente resolvió la mayor parte de la tarea pero se extralimitó en un archivo.

::: tip Acepta de forma incremental
Si un diff es mayormente correcto, acepta primero los hunks buenos y solicita cambios únicamente para las partes que necesitan corrección. Esto mantiene el tablero en movimiento.
:::

Usa las decisiones a nivel de hunk para:

| Situación | Acción |
| --- | --- |
| Cambio correcto y delimitado | Acepta el hunk |
| Idea correcta, archivo equivocado o refactor demasiado amplio | Rechaza el hunk y solicita una corrección más acotada |
| Cambio de comportamiento poco claro | Comenta y pide verificación |
| Ruido de formato generado | Rechaza, a menos que el formato formara parte de la tarea |

## Iniciar la revisión

1. Abre una tarea completada
2. Mira la pestaña **Changes**
3. Si el diff parece razonable, haz clic en **Request Review** para mover la tarea a la columna review

Durante la revisión la tarea aún no se considera done, por lo que otros compañeros de equipo o el lead todavía pueden comentar sobre ella.

## Ciclo de revisión

Un ciclo de revisión saludable se ve así:

1. El propietario publica un comentario de resultado con el alcance modificado y la verificación
2. El revisor abre el diff de la tarea y comprueba los hunks frente a la descripción de la tarea
3. El revisor acepta los hunks buenos, rechaza los hunks malos o solicita cambios
4. El propietario corrige únicamente el alcance solicitado y publica un comentario de seguimiento
5. El revisor aprueba cuando el resultado de la tarea y el diff coinciden

Ejemplo de comentario de solicitud de cambios:

```text
Please keep the copy improvements, but revert the unrelated runtime wording in the provider table. Add the `pnpm --dir landing docs:build` result before resubmitting.
```

## Estados de revisión

| Estado | Significado |
| --- | --- |
| `none` | La tarea es nueva, está in progress o completada pero aún no está en revisión |
| `review` | La tarea está activamente bajo revisión |
| `needsFix` | Se solicitaron cambios; el propietario debe actualizar antes de la nueva aprobación |
| `approved` | La revisión fue aceptada y la tarea está finalizada |

## Flujo de trabajo de revisión por agentes

Los equipos pueden revisar el trabajo de los demás antes de que tomes la decisión final. Esto detecta regresiones evidentes y mantiene el tablero honesto, pero aun así deberías revisar tú mismo las áreas de riesgo.

La revisión por agentes es más útil cuando el revisor tiene una rúbrica clara. Por ejemplo, indícale a un revisor que compruebe solo la claridad de la documentación, solo la seguridad de IPC o solo la cobertura de pruebas. Las solicitudes amplias de "revisar todo" tienden a producir comentarios más débiles.

### Estado de revisión gestionado por MCP

Los cambios de estado de revisión (solicitar revisión, solicitar cambios, aprobar) están gestionados por herramientas. Dejar un comentario de "solicitar cambios" en una tarea **no** mueve la columna del kanban a `needsFix`: un lead o un agente debe llamar a la herramienta MCP apropiada:

- `review_request_changes` — mueve la tarea a `needsFix` y notifica al propietario
- `review_approve` — mueve la tarea a `approved` y finaliza la revisión

Los comentarios por sí solos son insuficientes para las transiciones de estado. Para ver la lista completa de herramientas MCP de revisión y sus parámetros, consulta [Integración de MCP](/es/guide/mcp-integration).

## Participantes de la revisión

El lead del equipo es el revisor predeterminado. Puedes configurar revisores adicionales en la configuración del Kanban si quieres que los compañeros revisen el trabajo de los demás.

## Qué comprobar manualmente

Prioriza estas áreas al revisar:

- **Autenticación de proveedores y detección del runtime** — ¿el agente cambió la configuración del runtime de una forma que rompería otras rutas?
- **Límites de IPC, preload y sistema de archivos** — mantén separadas las responsabilidades de Electron
- **Comportamiento de Git y worktree** - verifica el nombrado de ramas, los commits y los pushes; consulta [Estrategia de Git y worktree](/es/guide/git-worktree-strategy) para conocer los patrones de aislamiento.
- **Lógica de parseo y ciclo de vida de las tareas** — los cambios en las referencias de tareas, el chunking o el filtrado pueden romper la entrega de mensajes
- **Flujos de persistencia y revisión de código** — los cambios en el almacenamiento de tareas o en el estado de revisión deben mantenerse consistentes entre las capas de IPC

Para conocer el diseño canónico de las funciones y los enlaces a los guardrails estrictos, usa [Arquitectura para colaboradores](/es/reference/contributor-architecture).

## Verificación

Prefiere comandos de verificación enfocados. No deberían usarse comandos amplios de formato o lint-fix a menos que la tarea pretenda explícitamente un cambio amplio de formato.

Los buenos comentarios de verificación incluyen el comando y el resultado:

```text
Verified with `pnpm --dir landing docs:build`. Build passed.
```

Cuando se omite la verificación, el comentario de la tarea debería indicar por qué:

```text
Docs-only wording change. Build not run because the existing dev server was busy; checked Markdown links manually.
```

::: warning No apliques formato automático en todo el proyecto
A menos que la tarea trate específicamente sobre formato, evita ejecutar `pnpm lint:fix` en archivos no relacionados. Crea ruido en la superficie de revisión.
:::
