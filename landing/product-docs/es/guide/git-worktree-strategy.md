---
title: Estrategia de Git y worktree – Documentación de Agent Teams
description: Decide cuándo usar el worktree principal, ramas de funcionalidades o el aislamiento por worktree de OpenCode para el trabajo de agentes en paralelo.
lang: es-ES
---

# Estrategia de Git y worktree

Git le da a Agent Teams la mejor ruta de revisión: diffs reducidos, visibilidad de las ramas, cambios acotados a las tareas y un trabajo en paralelo más seguro.

## Elige una estrategia

| Estrategia | Úsala cuando | Contrapartida |
| --- | --- | --- |
| Worktree principal | Trabajo en solitario, ediciones solo de documentación o un compañero de equipo a la vez | Simple, pero las ediciones en paralelo pueden chocar |
| Rama de funcionalidad | Un equipo está trabajando en un cambio coherente | Objetivo de revisión limpio, pero los compañeros de equipo siguen compartiendo archivos |
| Aislamiento por worktree | Varios compañeros de equipo de OpenCode pueden editar el mismo repositorio en paralelo | Mejor aislamiento, pero el merge y la revisión requieren más disciplina |

Empieza por lo simple. Añade el aislamiento por worktree cuando las ediciones en paralelo sean probables, no porque cada tarea necesite un checkout separado.

## Cuándo activar el aislamiento por worktree

Actívalo para los compañeros de equipo de OpenCode cuando:

- dos o más compañeros de equipo puedan editar el mismo repositorio a la vez
- una tarea pueda ejecutar formateadores, generadores de código o pruebas amplias
- quieras que la rama y el diff de cada compañero de equipo se mantengan separados
- el workspace del lead esté sucio y no deba recibir ediciones directas

Mantenlo desactivado cuando:

- la tarea sea de solo lectura
- un único compañero de equipo se encargue de todas las ediciones
- el repositorio no esté bajo control de versiones de Git
- necesites una ruta de runtime que no admita este modo de aislamiento

::: warning
El aislamiento por worktree se aplica actualmente a los miembros de OpenCode y requiere un proyecto bajo control de versiones de Git.
:::

## Higiene de las ramas

Antes de empezar el trabajo en paralelo:

```bash
git status --short
git branch --show-current
```

Usa una rama limpia cuando sea posible. Si el worktree principal ya tiene cambios del usuario, indica a los agentes que no reviertan archivos no relacionados y que mantengan el alcance de la tarea acotado.

Estilo de rama recomendado:

```text
agent/<team-or-task>/<short-purpose>
```

Ejemplos:

```text
agent/docs/mcp-guide
agent/review/task-log-filtering
agent/ui/code-review-polish
```

## Flujo de revisión

Para los worktrees aislados, revisa el diff del compañero de equipo antes de hacer merge o aplicar los cambios de vuelta al workspace principal.

1. Confirma que el comentario con el resultado de la tarea nombra el alcance modificado y la verificación.
2. Inspecciona el diff de la tarea en la interfaz de revisión.
3. Solicita cambios en la tarea si el diff toca archivos no relacionados.
4. Aprueba solo después de que las pruebas o las comprobaciones manuales coincidan con el riesgo de la tarea.
5. Haz merge o aplica los cambios de forma deliberada.

No hagas merge automático del resultado del worktree solo porque la tarea esté completa. Que esté completa significa que el agente cree que el trabajo está listo para revisión.

## Política de conflictos

Usa esta política para los equipos en paralelo:

| Situación | Acción |
| --- | --- |
| Dos compañeros de equipo editan el mismo archivo | Pausa una tarea o haz que un único responsable se encargue de la integración |
| Archivos generados modificados de forma amplia | Exige un comentario que explique el generador y el comando |
| El worktree principal tiene cambios no relacionados | Consérvalos y revisa solo los cambios propios de la tarea |
| La rama del worktree diverge | Haz rebase o merge manualmente tras la revisión, no dentro de una tarea de agente imprecisa |

## Ejemplo de prompt de tarea

```text
Implement the settings validation fix in your assigned worktree. Keep edits inside src/features/settings and focused tests. Do not touch provider auth or task storage. Post the test command and result before completing the task.
```

Este prompt funciona porque nombra el área permitida, los límites sensibles y la evidencia de finalización.

## Guías relacionadas

- [Crear un equipo](/es/guide/create-team)
- [Revisión de código](/es/guide/code-review)
- [Ejemplos de briefing de equipo](/es/guide/team-brief-examples)
- [Configuración del runtime](/es/guide/runtime-setup)
