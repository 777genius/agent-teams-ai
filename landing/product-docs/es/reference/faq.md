---
title: Preguntas frecuentes – Documentación de Agent Teams
description: Preguntas frecuentes sobre Agent Teams — precios, acceso a modelos, runtimes, privacidad, revisión y solución de problemas.
lang: es-ES
---

# Preguntas frecuentes

## ¿Agent Teams es gratis?

Sí. La aplicación es gratuita y de código abierto. El acceso al proveedor o al runtime puede tener un costo dependiendo de lo que uses.

## ¿Agent Teams incluye acceso a modelos?

No. Agent Teams es la capa local de orquestación e interfaz de usuario. El acceso a los modelos proviene de la ruta de runtime/proveedor seleccionada, como Claude Code, Codex u OpenCode.

## ¿Qué runtimes son compatibles?

Las rutas de runtime compatibles son Claude Code, Codex y OpenCode. La aplicación también rastrea ids de proveedor como Anthropic, Codex, Gemini y OpenCode cuando el runtime los expone.

## ¿Necesito instalar primero Claude Code o Codex?

No siempre. La aplicación guía la detección y la configuración del runtime desde la interfaz de usuario. Algunas rutas todavía requieren autenticación de runtime externa.

La configuración de OpenCode es independiente de la configuración de Claude Code y Codex. Si un lanzamiento falla, revisa el estado del runtime y la autenticación del proveedor antes de cambiar el prompt del equipo.

## ¿Cómo compruebo si un runtime está listo?

Primero ejecuta el comando del runtime en una terminal:

```bash
claude --version
codex --version
opencode --version
```

Luego confirma la autenticación del proveedor para la ruta que seleccionaste. Si el comando o la comprobación de autenticación falla fuera de Agent Teams, corrige la configuración antes de lanzar un equipo.

## ¿Sube mi código a los servidores de Agent Teams?

No. Agent Teams no es un servicio de sincronización de código en la nube. Las llamadas a modelos respaldadas por un proveedor pueden recibir contexto del prompt dependiendo del runtime que selecciones.

## ¿Dónde se almacenan los archivos del equipo?

Los datos de coordinación del equipo se almacenan localmente en `~/.claude/teams/<team>/` (macOS/Linux) o `%APPDATA%\Claude\teams\<team>\` (Windows), los archivos de tareas en `~/.claude/tasks/<team>/` o `%APPDATA%\Claude\tasks\<team>\`, y los datos de sesión del proyecto en `~/.claude/projects/<encoded-project>/` cuando están disponibles.

## ¿Qué puede salir de mi máquina?

El contexto del prompt, el contenido de los archivos seleccionados, los resultados de las herramientas, la salida de los comandos, el texto de las tareas, los comentarios y los archivos adjuntos pueden salir de tu máquina a través de la ruta de runtime/proveedor cuando un agente usa un modelo respaldado por un proveedor. El comportamiento exacto depende del runtime y del proveedor.

## ¿Los agentes pueden comunicarse entre sí?

Sí. Los agentes pueden enviar mensajes a sus compañeros de equipo, comentar en las tareas, coordinarse entre equipos y usar referencias de tareas para mantener las conversaciones vinculadas al trabajo.

## ¿Qué debo poner en el primer prompt del equipo?

Dale al lead un resultado concreto, los límites de archivos o funciones, los límites de riesgo y las expectativas de verificación. Por ejemplo:

```text
Improve the docs quickstart. Keep edits inside landing/product-docs, add practical examples, and run `pnpm --dir landing docs:build` before marking work done.
```

## ¿Puedo revisar el código antes de aceptarlo?

Sí. El flujo de revisión está construido en torno a diffs con alcance de tarea y decisiones a nivel de hunk.

## ¿Qué es un Agent Block?

Un Agent Block es texto oculto solo para agentes envuelto en marcadores como `<info_for_agent>...</info_for_agent>`. La aplicación lo elimina de la visualización normal orientada al usuario, pero lo mantiene disponible para la coordinación entre agentes.

## ¿Qué es el modo solo?

El modo solo es un equipo de un solo agente. Es útil para tareas más pequeñas y con menor sobrecarga de coordinación.

## ¿Debería usar el aislamiento por worktree?

Úsalo cuando varios compañeros de equipo de OpenCode puedan editar el mismo proyecto de Git en paralelo. Reduce los conflictos de archivos, pero requiere un proyecto rastreado por Git y actualmente se aplica a los miembros de OpenCode.

## ¿Pueden distintos compañeros de equipo usar distintos proveedores?

Sí, la configuración de proveedor/modelo se puede llevar por miembro del equipo cuando la ruta de runtime seleccionada lo admite. OpenCode es la ruta principal para el enrutamiento amplio entre múltiples proveedores.

## ¿Por qué una tarea muestra review o approved por separado de done?

El estado del trabajo y el estado de revisión están relacionados, pero no son idénticos. Una tarea puede estar done desde la perspectiva del agente y luego pasar por review y aprobación en la interfaz kanban.

## ¿Qué debo hacer cuando un lanzamiento se queda colgado?

Abre la solución de problemas, recopila los diagnósticos de lanzamiento, revisa `~/.claude/teams/<team>/` y verifica la autenticación del runtime/proveedor antes de cambiar los prompts.

Para OpenCode, revisa la evidencia de lane/sesión antes de suponer que un compañero de equipo está en línea pero ignora los mensajes.

## ¿Por qué los logs son diferentes entre runtimes?

Claude Code, Codex y OpenCode exponen distintos formatos de transcripción y evidencia de runtime. Agent Teams normaliza lo que puede, pero la completitud de los logs y la atribución pueden variar según el runtime.
