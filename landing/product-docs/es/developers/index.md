---
title: Centro para desarrolladores – Documentación de Agent Teams
description: Punto de entrada para colaboradores y desarrolladores sobre la arquitectura, los guardrails, la depuración y las vías de extensión con MCP de Agent Teams.
lang: es-ES
---

# Centro para desarrolladores

Usa esta página cuando quieras modificar el propio Agent Teams, depurar el lanzamiento de un equipo o extender un runtime con herramientas de MCP. Los enlaces siguientes apuntan a los documentos canónicos del repositorio para que las reglas de implementación se mantengan en un único lugar.

## Empieza aquí

| Necesidad | Ir a |
| --- | --- |
| Visión general del repositorio, scripts y configuración del código fuente | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Navegación de agentes e índice de arquitectura | [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) |
| Convenciones de trabajo para agentes y colaboradores | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Guardrails de implementación estrictos | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Estructura de funciones medianas y grandes | [Estándar de arquitectura de funciones](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Depuración del lanzamiento, el bootstrap y la mensajería entre compañeros de equipo | [Runbook de depuración de equipos de agentes](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |
| Proceso de contribución | [Guía de contribución](https://github.com/777genius/agent-teams-ai/blob/main/.github/CONTRIBUTING.md) |
| Notas de la versión / Changelog | [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) — [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) |

## Vía de desarrollo local

Ejecuta la aplicación de escritorio Electron para el desarrollo habitual:

```bash
pnpm install
pnpm dev
```

La vía de navegador/web no sustituye al runtime de escritorio. El modo de escritorio es la vía local admitida porque incluye IPC, terminales, autenticación de proveedores, gestión del ciclo de vida de los equipos, diagnósticos de lanzamiento y los puentes de runtime que usan los equipos reales.

## Puntos de control de la arquitectura

Antes de modificar una función, identifica su límite:

| Área | Ubicación esperada |
| --- | --- |
| Función de producto mediana o grande | `src/features/<feature-name>/` |
| Orquestación del proceso principal de Electron | `src/main/` |
| Superficie de API segura para el preload | `src/preload/` |
| UI del renderer y estado de la aplicación | `src/renderer/` |
| Tipos compartidos y helpers puros | `src/shared/` |
| Servidor MCP del tablero de Agent Teams | `mcp-server/` |
| Controlador de datos del tablero | `agent-teams-controller/` |

Usa `src/features/recent-projects` como slice de referencia para la organización de funciones. Mantén explícitos los contratos entre procesos y evita las importaciones profundas que cruzan los límites de las funciones.

## Vía de depuración

Para bloqueos en el lanzamiento, estados `registered` / bootstrap sin confirmar de OpenCode, respuestas faltantes de compañeros de equipo o logs de tareas sospechosos:

1. Empieza por el [runbook de depuración](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md).
2. Inspecciona el paquete de artefactos más reciente en `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`.
3. Abre el `manifest.json` del artefacto y revisa `classification`, las migas de pan del bootstrap, los diagnósticos de lanzamiento, los estados de spawn de los miembros y las colas de logs censuradas.
4. Limpia únicamente el equipo, la ejecución, el panel o el proceso que puedas identificar como propiedad de la prueba de humo o del lanzamiento fallido.

## Vía de desarrollo con MCP

Agent Teams usa un servidor MCP integrado llamado `agent-teams` para las operaciones del tablero. Los servidores MCP de usuario y de proyecto pueden añadir capacidades externas para los runtimes. Consulta [Integración de MCP](/es/guide/mcp-integration) para ver ejemplos de configuración, la estructura de `.mcp.json` y orientación sobre el registro de herramientas.

## Documentos relacionados

- [Arquitectura para colaboradores](/es/reference/contributor-architecture)
- [Configuración del runtime](/es/guide/runtime-setup)
- [Integración de MCP](/es/guide/mcp-integration)
- [Solución de problemas](/es/guide/troubleshooting)
