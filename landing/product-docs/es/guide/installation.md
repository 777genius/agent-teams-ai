---
title: Instalación – Documentación de Agent Teams
description: Descarga e instala Agent Teams para macOS, Windows o Linux. Cubre las builds empaquetadas, la configuración desde el código fuente, las actualizaciones automáticas y los requisitos.
lang: es-ES
---

# Instalación

Agent Teams se distribuye como una aplicación de escritorio para macOS, Windows y Linux.

::: tip La vía más rápida
1. Descarga la build para tu plataforma a continuación
2. Inicia la aplicación: empieza con el modelo gratuito sin autenticación o conecta la autenticación de un proveedor desde la interfaz
3. Comienza el [inicio rápido](/es/guide/quickstart) para crear tu primer equipo

Arranque de la aplicación de escritorio: ejecuta `pnpm dev` para la aplicación de Electron. No inicies el modo de desarrollo de navegador/web para el uso normal.
:::

## Descargar builds

Usa la <a href="/es/download/" target="_self">página de descarga</a> o la última [versión de GitHub](https://github.com/777genius/agent-teams-ai/releases) cuando quieras la aplicación empaquetada:

- macOS Apple Silicon: `.dmg`
- macOS Intel: `.dmg`
- Windows: `.exe`
- Linux: `.AppImage`, `.deb`, `.rpm` o `.pacman`

::: warning Windows SmartScreen
Las aplicaciones de código abierto sin firmar o recién publicadas pueden activar SmartScreen. Si confías en la fuente de la versión, elige **More info** y luego **Run anyway**.
:::

## Requisitos

La aplicación empaquetada está diseñada para una incorporación sin configuración. Puedes empezar con el modelo gratuito sin autenticación: sin registro, claves de API ni tarjeta de crédito. Si quieres más modelos, la aplicación te guía en la detección del runtime y la autenticación del proveedor desde la interfaz.

Para modelos de pago o respaldados por una cuenta, conecta al menos un proveedor:

| Proveedor          | Método de acceso                                  |
| ------------------ | ------------------------------------------------- |
| Claude (Anthropic) | Inicio de sesión de Claude Code CLI o clave de API |
| Codex (OpenAI)     | Inicio de sesión de Codex CLI o clave de API       |
| OpenCode           | Modelo gratuito incluido sin autenticación, o clave de API para un backend compatible (p. ej. OpenRouter) |


Para el desarrollo desde el código fuente, también necesitas:

| Herramienta | Versión     |
| ----------- | ----------- |
| Node.js     | 24.16.0 LTS |
| pnpm        | 10+         |

En macOS, los binarios precompilados oficiales de Node.js 24 requieren macOS 13.5+.

## Ejecutar desde el código fuente

<InstallBlock command="git clone https://github.com/777genius/agent-teams-ai.git && cd agent-teams-ai && pnpm install && pnpm dev" label="Copiar" copied-label="Copiado" />

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` inicia la aplicación de escritorio de Electron con recarga en caliente. Este es el objetivo de desarrollo predeterminado — no inicies un servidor de desarrollo web de navegador para el desarrollo normal. La ruta del navegador carece del IPC de escritorio completo, la terminal, la autenticación del proveedor y el comportamiento del ciclo de vida del equipo.

La rama `main` lleva el último desarrollo estable. Cambia a ramas de funciones solo si necesitas un cambio específico aún no publicado.

## Verificar la configuración

Después de instalar, confirma que la build esté en buen estado:

```bash
# Check that the desktop app compiles and starts
pnpm typecheck

# Verify the VitePress documentation site builds
pnpm --dir landing docs:build
```

Si `pnpm typecheck` informa de errores de tipo, busca una versión más reciente de las dependencias o de la versión fijada de TypeScript. Si `pnpm --dir landing docs:build` falla, inspecciona `landing/product-docs/` en busca de errores de sintaxis en el markdown o la configuración.

Si estás editando esta documentación, ejecuta la build para verificar tus cambios:

```bash
pnpm --dir landing docs:build
```

## Actualizaciones automáticas

La aplicación empaquetada busca actualizaciones automáticamente al iniciar y periódicamente mientras se ejecuta. Cuando hay una actualización disponible, la aplicación te pide que la descargues e instales. También puedes comprobarlo manualmente desde el menú de la aplicación.

::: tip
Las actualizaciones automáticas no están disponibles al ejecutar desde el código fuente. Trae los últimos cambios y vuelve a ejecutar `pnpm install` cuando cambien las dependencias.
:::

## Actualizar desde el código fuente

Si ejecutas desde el código fuente, trae la rama `main` y vuelve a ejecutar la instalación cuando cambien las dependencias:

```bash
git pull
pnpm install
```

Después de actualizar, verifica la build y la documentación:

```bash
pnpm typecheck
pnpm --dir landing docs:build
```

Usa siempre `pnpm dev` (Electron) — no el servidor de desarrollo del navegador — para el desarrollo normal.

## Próximos pasos

- [Inicio rápido](/es/guide/quickstart) — desde la instalación hasta el primer equipo en ejecución
- [Configuración del runtime](/es/guide/runtime-setup) — autenticación del proveedor y selección de modelo por runtime
- [Crear un equipo](/es/guide/create-team) — formas de equipo recomendadas y redacción del briefing

### Para colaboradores

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — navegación del repositorio y punteros de arquitectura
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — convenciones de trabajo y reglas del proyecto
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — guardrails de implementación estrictos
