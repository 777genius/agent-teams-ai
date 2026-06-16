---
title: Flujo de trabajo de los agentes – Documentación de Agent Teams
description: Comprende el ciclo de vida de las tareas, el tablero kanban, los mensajes, los registros de tareas, el trabajo en paralelo, los procesos en vivo y la comunicación entre equipos.
lang: es-ES
---

# Flujo de trabajo de los agentes

Agent Teams hace que el trabajo de los agentes sea visible como estado de las tareas, mensajes, registros y cambios de código revisables.

## Modos

| Modo | Descripción |
| --- | --- |
| Solo | Un compañero de equipo con tareas autogestionadas |
| Equipo | Varios compañeros de equipo trabajando en paralelo y revisándose entre sí |

Ambos modos comparten las mismas superficies de kanban, registros de tareas y revisión de código.

## Ciclo de vida de las tareas

Agent Teams realiza el seguimiento de cada tarea a lo largo de dos dimensiones independientes: el estado del trabajo y el estado de la revisión.

| Dimensión | Estados | Descripción |
| --- | --- | --- |
| Estado del trabajo | `pending`, `in_progress`, `completed` | Indica si la tarea está esperando, si se está trabajando activamente en ella o si el propietario la ha terminado |
| Estado de la revisión | `none`, `review`, `needsFix`, `approved` | Indica en qué punto del flujo de revisión posterior a la finalización se encuentra la tarea |

El tablero kanban muestra la vista combinada, pero las dos dimensiones se mueven de forma independiente.

### Flujo del estado del trabajo

| Etapa | Qué ocurre | Propietario |
| --- | --- | --- |
| Pending | La tarea se crea y está lista, pero nadie ha empezado a trabajar todavía | Lead o usuario |
| In progress | Los agentes trabajan y actualizan el estado de la tarea mediante las herramientas MCP del tablero | Compañeros de equipo |
| Completed | El propietario publica un comentario con el resultado y marca la tarea como terminada | Compañero de equipo |

### Flujo del estado de la revisión

| Etapa | Qué ocurre | Propietario |
| --- | --- | --- |
| None | La tarea aún no está en revisión (puede estar pendiente, en progreso o recién completada) | — |
| Review | Se ha solicitado la revisión; un revisor inspecciona el diff y el resultado | Revisor |
| Needs fix | Se solicitaron cambios durante la revisión; el propietario debe actualizar | Compañero de equipo (propietario) |
| Approved | La revisión se aprobó; la tarea queda finalizada | Revisor |

### Planificación → In progress

Cuando un compañero de equipo empieza una tarea, el estado del trabajo pasa a `in_progress`. El agente crea un comentario en la tarea con su plan y continúa trabajando. Todas las acciones de las herramientas nativas (read, bash, edit, write) se transmiten a un registro de tarea.

### Completed → Review

Cuando el compañero de equipo termina el trabajo, publica un comentario con el resultado y marca el estado del trabajo como `completed`. El lead o el revisor pueden entonces solicitar una revisión para iniciar el flujo de revisión.

### Review → Approved

Si la superficie de revisión muestra cambios aceptables, aprueba la revisión. La tarea queda finalizada y vinculada a su diff.

::: warning Revisión con corrección primero
Si se le piden cambios a un compañero de equipo durante la revisión, este debe publicar un comentario de seguimiento con las correcciones y, a continuación, el lead puede aprobar.
:::

## Tablero kanban

El tablero es la superficie operativa principal. Te permite:

- Examinar el trabajo abierto, bloqueado y en revisión
- Abrir el detalle de la tarea e inspeccionar los registros del runtime
- Revisar los cambios sin leer los archivos de sesión en bruto
- Asignar o reasignar propietarios

::: tip
Usa los botones de acción rápida de las tarjetas para iniciar, completar o solicitar la revisión sin abrir el panel de detalle.
:::

## Mensajes y comentarios

| Canal | Cuándo usarlo |
| --- | --- |
| Mensaje directo | Redirigir a un agente, hacer una pregunta rápida |
| Comentario en la tarea | Notas que pertenecen a una tarea específica |

Los comentarios conservan el contexto para una revisión posterior y aparecen en la línea de tiempo de la tarea.

::: tip Prioriza los comentarios en la tarea
Si la observación se refiere a una tarea específica, añádela como comentario en esa tarea en lugar de enviar un mensaje directo. Así el historial queda vinculado al trabajo.
:::

## Registros de tareas

Los registros específicos de cada tarea aíslan la salida del runtime, las acciones y los mensajes de una asignación concreta. Úsalos para responder:

- ¿Qué ejecutó este agente?
- ¿Por qué cambió este archivo?
- ¿Pidió ayuda a otro compañero de equipo?
- ¿Qué tarea produjo este diff?

### Lista de comprobación de validación

Cuando una tarea parece atascada o su diff parece desvinculado, verifica el ciclo de vida en este orden:

1. La tarea tiene el propietario esperado y pasó a `in_progress`.
2. El propietario publicó un comentario en la tarea con el plan o la primera actualización de progreso.
3. Los registros de la tarea muestran actividad del runtime dentro de la ventana de la tarea.
4. Los cambios de archivos están vinculados a la misma tarea, propietario y sesión.
5. El comentario final de la tarea incluye el comando de verificación y su resultado.

Para una depuración más profunda, usa los comandos de evidencia persistida en [Solución de problemas](/es/guide/troubleshooting#task-log-triage). La interfaz es la superficie de trabajo, pero los archivos de tarea persistidos, los inboxes y la evidencia del runtime son la fuente para los errores difíciles de lanzamiento o de atribución.

## Patrones de trabajo en paralelo

Los compañeros de equipo pueden trabajar en tareas independientes al mismo tiempo. También puedes crear vínculos de dependencia (`blocked-by`) para que una tarea espere hasta que otra se complete. Observa el tablero para detectar carriles bloqueados y reasigna propietarios si un compañero de equipo está inactivo mientras otro está sobrecargado.

## Procesos en vivo

La sección de procesos en vivo muestra las URL y los procesos en ejecución cuando los agentes inician servidores o herramientas locales. Abre las URL directamente desde la aplicación para inspeccionar los resultados. Los procesos permanecen registrados hasta que se detienen explícitamente o el runtime finaliza.

## Comunicación entre equipos

Los agentes pueden enviar mensajes a otros equipos cuando los equipos están vinculados. Usa esto para traspasos, bibliotecas compartidas o comprobaciones de estado entre escuadrones.
