---
title: Privacidad y datos locales – Documentación de Agent Teams
description: Qué almacena Agent Teams de forma local, qué puede salir de tu equipo a través de las llamadas a modelos respaldadas por el proveedor y orientación práctica sobre privacidad.
lang: es-ES
---

# Privacidad y datos locales

Agent Teams es local-first, pero la ruta de runtime/proveedor seleccionada sigue siendo importante. Esta página describe qué almacena localmente la aplicación de escritorio y qué puede salir de tu equipo cuando los agentes llaman a modelos respaldados por el proveedor.

## Qué permanece local

La aplicación de escritorio se ejecuta en tu máquina y lee datos locales de proyecto/runtime para alimentar la interfaz. Los datos locales habituales incluyen:

- archivos de proyecto
- configuración del equipo y metadatos de los miembros
- metadatos de tareas, comentarios de tareas y referencias de tareas
- mensajes de la bandeja de entrada
- registros de runtime/sesión
- estado de lanzamiento y diagnósticos de bootstrap
- estado de la revisión
- ajustes locales de la aplicación

Las ubicaciones locales importantes incluyen:

| Plataforma | Ubicación | Propósito |
| --- | --- | --- |
| macOS/Linux | `~/.claude/teams/<team>/` | Configuración del equipo, metadatos de los miembros, bandejas de entrada, estado de lanzamiento, evidencia de bootstrap, diagnósticos de runtime, registros de mensajes enviados, estado del kanban y archivos de equipo relacionados con la revisión. |
| Windows | `%APPDATA%\Claude\teams\<team>\` | Igual: configuración del equipo, metadatos de los miembros, bandejas de entrada, estado de lanzamiento y diagnósticos. |
| macOS/Linux | `~/.claude/tasks/<team>/` | Archivos JSON de tareas duraderos para el tablero del equipo. |
| Windows | `%APPDATA%\Claude\tasks\<team>\` | Igual: archivos JSON de tareas duraderos. |
| macOS/Linux | `~/.claude/projects/<encoded-project>/` | Archivos de sesión de proyecto de tipo Claude/Codex que se usan para el historial de sesiones, el análisis de contexto y la interfaz respaldada por transcripciones. |
| Windows | `%APPDATA%\Claude\projects\<encoded-project>\` | Igual: archivos de sesión de proyecto. |

Los archivos exactos pueden variar según el runtime y la versión de la aplicación. Para depurar el lanzamiento, la evidencia más reciente suele estar en la carpeta `~/.claude/teams/<team>/` (o `%APPDATA%\Claude\teams\<team>\`) correspondiente.

## Qué puede salir de tu equipo

Agent Teams en sí no es un servicio de sincronización de código en la nube para tu repositorio. No necesita subir todo tu proyecto a un servidor de Agent Teams para mostrar el tablero, la bandeja de entrada, los registros o la interfaz de revisión.

Sin embargo, cuando un agente le pide a un modelo respaldado por el proveedor que trabaje, el contexto del prompt, el contenido de los archivos seleccionados, el texto de las tareas, los comentarios, los resultados de las herramientas, la salida de los comandos y otro contexto proporcionado por el runtime pueden enviarse a través de la ruta de runtime/proveedor seleccionada. Lo que se envía depende del runtime, el modelo, las llamadas a herramientas, el prompt y la configuración del proveedor.

La autenticación del proveedor, la retención por parte del proveedor, el entrenamiento, el registro, el procesamiento regional y la facturación se rigen por el proveedor/runtime que elijas. Revisa esas políticas para proyectos sensibles.

Ejemplos habituales:

| Acción | Datos que pueden enviarse a través del runtime/proveedor |
| --- | --- |
| Pedir a un agente que edite un archivo | El prompt de la tarea, el contenido de los archivos relevantes, los resultados de las herramientas y la salida de los comandos |
| Adjuntar una captura de pantalla | El contenido del adjunto y el texto de la tarea/comentario circundante |
| Pedir una revisión de código | El contexto del diff, los archivos seleccionados, los comentarios y los registros de verificación |
| Depurar un comando que falla | La salida de error, los stack traces y los fragmentos de código fuente referenciados |

## Qué no garantiza la aplicación

- No puede garantizar que las llamadas a modelos respaldadas por el proveedor nunca reciban código privado.
- No puede anular las políticas de retención o facturación del proveedor.
- No puede hacer que un proveedor remoto se comporte como un modelo totalmente local.
- No puede proteger secretos que se le indique a un agente pegar en prompts, comentarios de tareas, archivos o comandos.
- No puede hacer que todos los runtimes expongan la misma transcripción o el mismo nivel de detalle de auditoría.

## Orientación práctica

- No adjuntes secretos a tareas, comentarios ni mensajes directos.
- Revisa las políticas del proveedor para proyectos sensibles.
- Usa una autonomía más baja para repositorios de riesgo.
- Mantén el alcance de las tareas reducido cuando trabajes con código privado.
- Prioriza la evidencia y los registros locales al depurar.
- Comprueba los prompts generados, las descripciones de tareas y los archivos adjuntos antes de pedir a los agentes que trabajen con material confidencial.
- Usa rutas de proveedor/modelo que se ajusten a tus requisitos de privacidad.

Antes de usar Agent Teams en un repositorio sensible:

1. Elimina los secretos del árbol de trabajo y de los adjuntos de las tareas
2. Elige la ruta de runtime/proveedor que tengas permitido usar
3. Empieza con autonomía baja y tareas pequeñas
4. Revisa los prompts de las tareas y los comentarios generados antes de ampliar el alcance
5. Mantén los registros locales a menos que los compartas intencionadamente para soporte

## Modelo de código abierto

La aplicación en sí es de código abierto y gratuita. Puedes inspeccionar cómo funcionan la orquestación local, el seguimiento de tareas, las bandejas de entrada, los diagnósticos de runtime y los flujos de revisión en el repositorio.
