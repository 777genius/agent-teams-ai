---
title: Ejemplos de briefing de equipo – Documentación de Agent Teams
description: Plantillas prácticas de briefing de equipo para correcciones pequeñas, trabajo de documentación, tareas de implementación, revisiones y áreas de alto riesgo.
lang: es-ES
---

# Ejemplos de briefing de equipo

Un buen briefing de equipo da al lead suficiente estructura para crear tareas pequeñas sin imponer cada detalle de implementación de antemano.

Usa esta estructura:

```text
Outcome:
Scope:
Boundaries:
Coordination:
Verification:
Review:
```

## Briefing mínimo

Úsalo para trabajo pequeño y de bajo riesgo.

```text
Outcome: Improve the quickstart so a new user can launch one team successfully.
Scope: Keep edits inside landing/product-docs.
Boundaries: Do not rewrite the whole docs structure.
Coordination: Create one or two tasks, keep comments on the task.
Verification: Run `pnpm --dir landing docs:build`.
Review: Summarize changed pages and any remaining gaps.
```

## Briefing de implementación

Úsalo cuando los cambios de código afectan a un área de funcionalidad.

```text
Outcome: Add a focused improvement to task comment filtering.
Scope: Work inside the task/comment feature files unless a shared helper is clearly needed.
Boundaries: Do not change task storage format or review state semantics.
Coordination: Split parser, UI, and tests into separate tasks if they can be reviewed independently.
Verification: Run the focused unit tests first, then the feature typecheck if touched.
Review: Call out parsing edge cases and any behavior that affects existing task comments.
```

## Briefing de documentación

Úsalo para trabajo de documentación y guías.

```text
Outcome: Draft practical workflow guides from the docs audit.
Scope: Add concise VitePress pages under landing/product-docs/guide.
Boundaries: Avoid moving existing navigation hubs owned by other tasks.
Coordination: Check related docs tasks before editing nav.
Verification: Run `pnpm --dir landing docs:build`.
Review: Include links added to sidebar and any pages intentionally left as drafts.
```

## Briefing centrado en la revisión

Úsalo para áreas de riesgo como IPC, autenticación de proveedores, persistencia, Git o lógica del ciclo de vida de las tareas.

```text
Outcome: Fix the launch failure without changing successful launch behavior.
Scope: Start from the newest launch-failure artifact and the affected runtime adapter.
Boundaries: Do not change provider prompts until setup and runtime evidence are inspected.
Coordination: Make one diagnostic task and one fix task if the cause is confirmed.
Verification: Run focused tests and one desktop smoke check when practical.
Review: Lead must inspect the diff before approval.
```

## Briefing de proveedores mixtos

Úsalo cuando los compañeros de equipo ejecutan distintos carriles de proveedor/modelo.

```text
Outcome: Implement and review a small feature using separate builder and reviewer lanes.
Scope: Builder edits the feature. Reviewer inspects only the task diff and tests.
Boundaries: Do not switch model ids mid-task unless launch fails before work begins.
Coordination: Builder posts result comment first. Reviewer posts findings as task comments.
Verification: Builder runs focused tests. Reviewer checks failure output and changed scope.
Review: Lead approves only after reviewer comments are resolved.
```

## Bloques de agente en los briefings

Los bloques de agente son texto oculto exclusivo para agentes, envuelto en marcadores como `<info_for_agent>...</info_for_agent>`. La aplicación los elimina de la visualización normal, pero los mantiene disponibles para la coordinación entre agentes. Úsalos cuando el briefing necesite decir algo a los agentes que sería ruido para un lector humano.

Ejemplo: un briefing que indica al lead cómo dividir el trabajo sin exponer las instrucciones de coordinación al usuario:

```text
Outcome: Add a dark mode toggle to the application settings.
Scope: Settings UI, theme context, and CSS variables.
Boundaries: Do not change existing light theme values or provider auth screens.

<info_for_agent>
Split this into three tasks: (1) theme context and CSS vars, (2) toggle component and settings wiring, (3) dark mode preview in existing docs screenshots if practical.
</info_for_agent>
```

El bloque mantiene limpio el briefing orientado al humano mientras da al lead una orientación estructurada para dividir las tareas.

## Qué evitar

| Briefing débil | Mejor reemplazo |
| --- | --- |
| "Improve the app" | Nombra el flujo de trabajo, los archivos y la comprobación de éxito |
| "Fix all docs" | Elige un grupo de guías y un comando de build |
| "Use the best model" | Nombra las opciones de proveedor/modelo o deja que se mantengan los valores predeterminados de la aplicación |
| "Refactor as needed" | Indica qué módulos pueden cambiar |
| "Make it production ready" | Define la revisión, las pruebas y las comprobaciones de despliegue |

## Antes del lanzamiento

Comprueba estos puntos antes de iniciar el equipo:

1. El briefing nombra un resultado concreto.
2. Los límites de riesgo son explícitos.
3. El lead puede dividir el trabajo en tareas revisables.
4. Se incluyen comandos de verificación cuando se conocen.
5. Las áreas sensibles requieren revisión antes de la aprobación.

Si el briefing sigue siendo amplio, lanza primero un agente en solitario o un equipo pequeño y pídele que produzca un plan de tareas en lugar de la implementación.

## Guías relacionadas

- [Crear un equipo](/es/guide/create-team)
- [Integración de MCP](/es/guide/mcp-integration)
- [Estrategia de Git y worktree](/es/guide/git-worktree-strategy)
