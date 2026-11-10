---
title: Arquitectura para colaboradores – Documentación de Agent Teams
description: Guía para colaboradores sobre la estructura de las funciones, los límites entre runtime y proveedor, los guardrails estrictos y los documentos canónicos de arquitectura.
lang: es-ES
---

# Arquitectura para colaboradores

Esta página es un mapa para colaboradores. Apunta a la guía canónica del repositorio en lugar de reformular cada regla de implementación.

## Fuentes canónicas

Usa estos archivos como fuente de verdad al cambiar la aplicación:

| Necesidad | Fuente canónica |
| --- | --- |
| Resumen del repositorio y comandos | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Convenciones de trabajo local | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Guardrails estrictos | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Estructura de funciones medianas y grandes | [docs/FEATURE_ARCHITECTURE_STANDARD.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Depuración del lanzamiento de equipos de agentes | [docs/team-management/debugging-agent-teams.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |

## Estructura de las funciones

Las funciones medianas y grandes deben residir bajo `src/features/<feature-name>/` y seguir el estándar de arquitectura de funciones. Mantén los detalles internos de cada función detrás de puntos de entrada públicos y evita las importaciones profundas que crucen los límites entre funciones.

Para el trabajo nuevo, parte del slice existente `src/features/recent-projects` como implementación de referencia local. Las correcciones pequeñas pueden permanecer cerca de la ruta de código existente cuando crear un slice de función añadiría más estructura que valor.

## Límites entre runtime y proveedor

Agent Teams es responsable de la orquestación: equipos, tareas, mensajes, estado de lanzamiento, interfaz de revisión, diagnósticos y persistencia local.

La ruta de runtime/proveedor seleccionada es responsable de la ejecución del modelo, la autenticación, la disponibilidad de modelos, los límites de tasa, la semántica de las herramientas y las evidencias de transcripción específicas del runtime. No hagas que los prompts o el estado de la interfaz compensen una autenticación faltante, binarios faltantes, ids de modelo rechazados o interrupciones del proveedor. Para los detalles de configuración orientados al usuario, consulta [Proveedores y runtimes](/es/reference/providers-runtimes).

## Depuración de equipos de agentes

Para los bloqueos en el lanzamiento, los estados `registered` / bootstrap no confirmado de OpenCode, las respuestas faltantes de los compañeros de equipo o los registros de tareas sospechosos, comienza por el runbook de depuración dedicado. Inspecciona el artefacto de fallo de lanzamiento más reciente en `~/.claude/teams/<team>/launch-failure-artifacts/latest.json` y, a continuación, correlaciona el estado de la interfaz con los archivos persistidos y la evidencia específica del runtime.

Evita las limpiezas amplias mientras depuras. Detén únicamente el proceso, la lane, el equipo o la ejecución de smoke que puedas identificar como pertenecientes al problema.

## Convenciones para colaboradores

- Usa `pnpm dev` para la aplicación de escritorio Electron durante el desarrollo normal.
- No uses el modo de desarrollo del navegador como sustituto del runtime de escritorio, IPC, terminal, autenticación del proveedor o comportamiento del ciclo de vida del equipo.
- Mantén separadas las responsabilidades de main, preload, renderer, shared y feature de Electron.
- Usa `wrapAgentBlock(text)` para los bloques exclusivos de agentes en lugar de concatenar marcadores manualmente.
- Prefiere la verificación enfocada. Evita el ruido de `lint:fix` o de formateo amplio a menos que la tarea trate explícitamente sobre el formateo.
- Trata el parsing, el ciclo de vida de las tareas, la detección de proveedor/runtime, la persistencia, IPC, Git y los flujos de revisión como áreas de alto riesgo que necesitan pruebas específicas o una ruta de verificación clara.

## Páginas relacionadas

- [Configuración del runtime](/es/guide/runtime-setup)
- [Solución de problemas](/es/guide/troubleshooting)
- [Revisión de código](/es/guide/code-review)
- [Privacidad y datos locales](/es/reference/privacy-local-data)
