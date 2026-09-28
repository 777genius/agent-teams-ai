---
title: Notas de la versión – Documentación de Agent Teams
description: Notas de la versión y registro de cambios de Agent Teams. Enlaces a los archivos canónicos RELEASE.md y CHANGELOG.md con todos los detalles.
lang: es-ES
---

# Notas de la versión

Última versión publicada: **[v2.15.0](https://github.com/777genius/agent-teams-ai/releases/tag/v2.15.0)** (2026-09-19). Consulta la versión y las descargas actuales en [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases).

## Cómo funcionan las versiones

Agent Teams sigue el [versionado semántico](https://semver.org/). El [flujo de trabajo de publicación](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) se inicia manualmente, compila paquetes para macOS, Windows y Linux y luego los publica en GitHub Releases.

## Versión más reciente

### v2.15.0 - Reanudar tareas, mensajes privados y modelos locales

Puedes reanudar el trabajo detenido desde la página del equipo, conversar individualmente con miembros en Messages, elegir más modelos locales y probar Ollama sin seleccionar un proyecto. También se corrigieron la visibilidad de modelos locales y la reanudación de tareas pendientes después de detener un equipo mixto. Consulta las [notas de v2.15.0](https://github.com/777genius/agent-teams-ai/releases/tag/v2.15.0).

## Versiones anteriores

### v1.2.0 — Agent Graph, aprobación de herramientas por equipo, AskUserQuestion interactivo

Agent Graph con visualización dirigida por fuerzas y disposición de tareas en kanban, controles de aprobación de herramientas por equipo con prompts de permisos legibles, notificaciones de comentarios en las tareas y botones interactivos de AskUserQuestion. Renovación del sistema de permisos con la inicialización de Write/Edit/NotebookEdit e integración del catálogo de herramientas de MCP. Consulta el [registro de cambios completo](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#120---2026-03-31).

### v1.1.0 — React 19 + Electron 40, inicios de tareas iniciados por el usuario

Migración a React 19 + Electron 40, inicios de tareas iniciados por el usuario desde el tablero kanban, guía de solución de problemas de autenticación, resaltado de sintaxis para R/Ruby/PHP/SQL, búsqueda de transcripciones 3 veces más rápida, correcciones de rutas en WSL/Windows y corrección de una vulnerabilidad XSS. Consulta el [registro de cambios completo](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#110---2026-03-25).

### v1.0.0 — Primera versión pública

Primera compilación estable: fiabilidad de CLI/autenticación en las aplicaciones empaquetadas, endurecimiento de IPC, empaquetado multiplataforma con compilaciones firmadas para macOS, documentos de gobernanza de código abierto (LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY). Consulta el [registro de cambios completo](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#100---2026-03-23).

## Fuentes canónicas

| Documento | Descripción |
| --- | --- |
| [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) | Proceso de publicación, guía de versionado, nomenclatura de los artefactos, configuración de la actualización automática y plantilla de notas de la versión. |
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | Historial de las primeras versiones; consulta GitHub Releases para las versiones recientes. |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | Instaladores descargables para todas las plataformas. |

## Páginas relacionadas

- [Instalación](/es/guide/installation)
- [Inicio rápido](/es/guide/quickstart)
- [Arquitectura para colaboradores](/es/reference/contributor-architecture)
- [Desarrolladores](/es/developers/)
