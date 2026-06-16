---
title: Inicio rápido – Documentación de Agent Teams
description: Pasa de una instalación nueva a un equipo de agentes de IA en funcionamiento en unos minutos. Cubre la instalación, la selección del runtime, la creación del equipo y la primera revisión de código.
lang: es-ES
---

# Inicio rápido

Esta guía te lleva de una instalación nueva a un equipo en funcionamiento en unos minutos.

## El camino más corto

```bash
# 1. Install prerequisites
node --version    # need 20+
pnpm --version    # need 10+

# 2. Clone and install
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install

# 3. Start the desktop app (default workflow)
pnpm dev

# 4. Verify a docs-only change
pnpm --dir landing docs:build
```

La aplicación de escritorio Electron (`pnpm dev`) es el objetivo principal: no uses el servidor de desarrollo web/navegador para el desarrollo normal. El camino del navegador carece del IPC de escritorio, la terminal, la autenticación de proveedores y el comportamiento del ciclo de vida del equipo.

## Antes de empezar

Necesitas:

- **Un ordenador** con macOS, Windows o Linux
- **(Recomendado) Un proyecto gestionado con Git** — el aislamiento con worktree y la revisión de diffs dependen de Git
- **(Opcional) Acceso a un proveedor** — la configuración del runtime detecta los proveedores disponibles desde la UI, pero algunos caminos requieren autenticación existente (Anthropic, OpenAI, etc.)

Si alguno de los pasos siguientes no funciona, consulta la [guía de solución de problemas](/es/guide/troubleshooting#team-does-not-launch) para ver soluciones habituales.

Para conocer las convenciones del proyecto y las pautas de arquitectura, consulta estos archivos canónicos antes de hacer cambios:

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — navegación del repositorio y punteros de arquitectura
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — convenciones de trabajo y reglas del proyecto
- [Estándar de arquitectura de funciones](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — estructura para nuevas funciones
- [Runbook de depuración](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — diagnósticos de lanzamiento y de compañeros de equipo

## 1. Ejecutar desde el código fuente o descargar

**Descarga la aplicación empaquetada** para macOS, Windows o Linux desde la <a href="/es/download/" target="_self">página de descarga</a> - no se necesitan requisitos previos. Empieza con el modelo gratuito sin autenticación, o conecta la autenticación de un proveedor desde la UI cuando quieras más modelos.

**O ejecuta desde el código fuente** para el desarrollo:

Requiere Node.js 24.16.0 LTS y pnpm 10+. En macOS, los binarios precompilados oficiales de Node.js 24 requieren macOS 13.5+.

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` inicia la aplicación de escritorio Electron con recarga en caliente. Este es el objetivo de desarrollo predeterminado. No inicies un servidor de desarrollo web en el navegador para el desarrollo normal: el camino del navegador carece del IPC de escritorio completo, la terminal, la autenticación de proveedores y el comportamiento del ciclo de vida del equipo.

## 2. Abrir o crear un proyecto

Inicia la aplicación y selecciona el directorio del proyecto en el que quieres que trabajen los agentes. Agent Teams lee los archivos locales del proyecto y el estado del runtime/sesión para que la UI pueda mostrar tareas, registros, diffs y la actividad de los compañeros de equipo.

::: tip
Elige un proyecto gestionado con Git para tener la mejor experiencia. Tanto el aislamiento con worktree como la revisión basada en diffs dependen de Git.
:::

Antes de lanzar un equipo, comprueba que el proyecto tiene una base lo bastante limpia:

```bash
git status --short
```

No necesitas un árbol perfectamente limpio, pero deberías saber qué cambios son tuyos antes de que los agentes empiecen a editar. Esto hace que los diffs de las tareas y la revisión a nivel de hunk sean mucho más fiables.

## 3. Elegir un camino de runtime

El flujo de configuración detecta automáticamente los runtimes instalados en tu máquina. Una primera configuración habitual es:

| Runtime  | Bueno para                                        |
| -------- | ----------------------------------------------- |
| Claude   | Usuarios de Claude Code y acceso existente a Anthropic |
| Codex    | Flujos de trabajo nativos de Codex y acceso a OpenAI        |
| OpenCode | Modelo gratuito sin autenticación, equipos multimodelo y muchos backends de proveedores |

::: info
Gemini está disponible como un camino de proveedor compatible. Consulta [Proveedores y runtimes](/es/reference/providers-runtimes) para ver las opciones de autenticación y el estado actual de los proveedores.
:::

Consulta [Configuración del runtime](/es/guide/runtime-setup) para una configuración detallada por proveedor.

Para verificar un runtime de pago o respaldado por una cuenta fuera de la aplicación, comprueba el binario y prueba la autenticación:

```bash
# Check that the runtime is installed and on PATH
command -v claude && claude --version
command -v codex && codex --version
command -v opencode && opencode --version
```

Si el comando falla, primero arregla la instalación del runtime o el `PATH`. Los prompts del equipo no pueden sortear un binario que falta o la falta de autenticación del proveedor para los modelos que la requieren.

::: tip
Si el binario se encuentra pero la aplicación informa de "not logged in", es posible que el entorno difiera entre tu terminal y la aplicación. Consulta el [registro de diagnóstico de autenticación](/es/guide/troubleshooting#auth-diagnostic-log) para compararlos.
:::

## 4. Crear tu primer equipo

Crea un equipo con un lead y uno o más especialistas. Mantén pequeño el primer equipo: un lead, un agente de implementación y un agente orientado a la revisión son suficientes para validar el flujo de trabajo.

Consulta [Crear un equipo](/es/guide/create-team) para ver la estructura recomendada y consejos.

Para el primer lanzamiento, prefiere una forma de equipo como esta:

| Miembro | Responsabilidad | Notas |
| --- | --- | --- |
| Lead | Dividir el objetivo en tareas y coordinar el estado | Mantenlo en el proveedor más fiable que tengas |
| Builder | Implementar tareas acotadas | Dale límites claros de archivo o función |
| Reviewer | Revisar el trabajo completado | Pídele que se centre en regresiones y pruebas faltantes |

Evita empezar con cinco o más compañeros de equipo. Más agentes aumentan la concurrencia, los registros, el uso del proveedor y el riesgo de conflictos antes de que sepas que la configuración está en buen estado.

## 5. Darle al lead un objetivo concreto

Escribe el objetivo como lo harías al instruir a un lead de ingeniería:

```text
Improve the onboarding flow. Split the work into tasks, keep changes small, and ask for review before broad refactors.
```

Los buenos primeros prompts incluyen un alcance concreto, límites de seguridad y verificación:

```text
Improve the docs quickstart. Keep edits inside landing/product-docs. Add practical examples, preserve existing VitePress syntax, and run `pnpm --dir landing docs:build` before marking tasks done.
```

Evita prompts vagos como "make the app better" para la primera ejecución. El lead puede descomponer objetivos grandes, pero una mejor entrada produce tareas más pequeñas y una revisión más limpia.

::: tip
Si el equipo se lanza pero no aparece ninguna tarea, comprueba si el lead recibió tu prompt. Consulta [faltan respuestas de los agentes](/es/guide/troubleshooting#agent-replies-are-missing) para ver diagnósticos.
:::

El lead crea tareas, asigna trabajo y coordina a los compañeros de equipo. Puedes seguir el progreso en el tablero kanban e intervenir con comentarios o mensajes directos en cualquier momento.

## 6. Revisar los resultados

Abre las tareas completadas o listas para revisión, inspecciona el diff y acepta, rechaza o comenta cambios individuales. Usa los registros de las tareas cuando necesites entender por qué un agente tomó una decisión.

Consulta [Revisión de código](/es/guide/code-review) para ver el flujo de trabajo de revisión completo.

Antes de aprobar la primera tarea, comprueba tres cosas:

1. El comentario de la tarea explica qué cambió
2. Los archivos modificados coinciden con el alcance de la tarea
3. El resultado de la verificación es visible en el comentario o los registros de la tarea

## Errores comunes

| Síntoma | Causa probable | Comprobación |
| --- | --- | --- |
| La aplicación no detecta un runtime | El binario no está en el `PATH`, o la aplicación y la terminal ven entornos diferentes | Ejecuta `command -v <runtime>` en una terminal y luego usa el mismo entorno de terminal para lanzar la aplicación |
| El lanzamiento del equipo se queda colgado | Falta la autenticación del proveedor para un modelo de pago/cuenta, cadena de modelo incorrecta o no se encuentra el binario del runtime | Consulta [Solución de problemas](/es/guide/troubleshooting#team-does-not-launch) |
| El carril de OpenCode atascado en `registered` | La evidencia del carril aún no se ha confirmado, o hay una discrepancia en la cadena de modelo | Inspecciona `~/.claude/teams/<team>/.opencode-runtime/lanes/` |
| Faltan respuestas de los agentes | Problema de reintento de entrega del runtime, de análisis o de atribución de tareas | Abre los registros de la tarea y revisa el ledger de entrega |
| El proveedor devuelve errores 429 | Se alcanzó el límite de velocidad | Espera a que se restablezca o cambia de modelo/proveedor |

## Próximos pasos

- [Crear un equipo](/es/guide/create-team) — formas de equipo recomendadas y redacción del briefing
- [Configuración del runtime](/es/guide/runtime-setup) — autenticación de proveedores y selección de modelo
- [Revisión de código](/es/guide/code-review) — revisar, aprobar o solicitar cambios

### Para colaboradores

Si vas a modificar Agent Teams o esta documentación, empieza por los archivos canónicos del proyecto en la raíz del repositorio:

- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — convenciones de trabajo y reglas del proyecto
- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — capa de navegación para las pautas de arquitectura e implementación
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — guardrails estrictos de implementación
- [Estándar de arquitectura de funciones](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — estructura para nuevas funciones
- [Runbook de depuración de equipos de agentes](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — diagnósticos de lanzamiento, bootstrap y de compañeros de equipo

Para verificar que este sitio de documentación se compila correctamente:

```bash
pnpm --dir landing docs:build
```
