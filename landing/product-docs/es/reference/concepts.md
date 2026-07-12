---
title: Conceptos – Documentación de Agent Teams
description: Vocabulario fundamental de Agent Teams — equipos, leads, compañeros de equipo, tareas, kanban, bandejas de entrada, runtimes y revisión.
lang: es-ES
---

# Conceptos

Esta página define los términos fundamentales que se utilizan en todo Agent Teams. Úsala como vocabulario compartido para la aplicación, el tablero de tareas, los mensajes y el flujo de revisión.

## Equipo

Un equipo es un grupo nombrado de agentes vinculado a una única ruta de proyecto. Tiene un lead, compañeros de equipo opcionales, ajustes de runtime/proveedor, prompts, bandejas de entrada, tareas y estado de lanzamiento local.

## Lead {#lead}

El lead es el coordinador del equipo. Convierte el objetivo de un usuario en tareas, asigna o reorienta a los compañeros de equipo, hace seguimiento de los bloqueos, solicita revisiones y mantiene el trabajo avanzando por el tablero.

[Compañero de equipo →](#teammate)

Los mensajes del lead siguen una ruta de entrega distinta a la de los mensajes de los compañeros de equipo: la aplicación retransmite las entradas de la bandeja de entrada del lead hacia el runtime del lead, mientras que los compañeros de equipo leen sus propios archivos de bandeja de entrada entre turnos.

## Compañero de equipo {#teammate}

Un compañero de equipo es un agente del equipo que no es el lead. Los compañeros de equipo suelen asumir roles específicos, como builder, revisor, investigador o tester. Un compañero de equipo puede recibir mensajes directos, asignaciones de tareas, comentarios de tareas y solicitudes de revisión.

[Lead ↑](#lead)

## Tarea

Una tarea es la unidad de trabajo duradera. Tiene un id, un estado, un propietario, una descripción, comentarios, registros, adjuntos, referencias a tareas y cambios revisables.

Los estados habituales de una tarea son `todo`, `in_progress`, `done`, `review` y `approved`. Internamente, el archivo de la tarea almacena el estado de trabajo, mientras que la ubicación de revisión y aprobación también puede usar el estado de superposición del kanban.

## Kanban

El kanban es la vista de tablero para el trabajo del equipo. Te permite escanear las tareas por estado, abrir los detalles de una tarea, inspeccionar registros, revisar diffs, aprobar el trabajo terminado o solicitar cambios.

## Bandeja de entrada

Una bandeja de entrada es un archivo de mensajes local para un participante del equipo. Agent Teams usa las bandejas de entrada para los mensajes de usuario, los mensajes del lead, los mensajes de los compañeros de equipo, los metadatos de entrega del runtime, los mensajes entre equipos y algunas notificaciones del sistema.

Los mensajes son registros locales duraderos. La entrega sigue dependiendo de que el runtime seleccionado esté activo y sea capaz de procesar su siguiente turno.

## Bloque de agente

Un bloque de agente es texto de instrucciones oculto y exclusivo para agentes, envuelto con `<info_for_agent>...</info_for_agent>`. La interfaz elimina estos bloques de la visualización normal orientada a las personas, pero los agentes y la entrega del runtime pueden usarlos para detalles de coordinación.

El marcador canónico actual es `info_for_agent`. Documentos más antiguos pueden usar bloques de código entre comillas con un marcador `info_for_agent`, o etiquetas al estilo XML `<agent_block>` — estos son patrones heredados y, cuando se encuentren, deberían migrarse a `info_for_agent`. (El nombre de etiqueta original era `agent-block`; la forma con guion bajo `<agent_block>` se usa en el código fuente de VitePress para evitar el análisis HTML.)

## Fase de contexto

Una fase de contexto es un segmento de la línea de tiempo del contexto de una sesión. La compactación inicia una nueva fase, de modo que el uso de tokens y de contexto puede analizarse antes y después del reinicio.

El seguimiento del contexto separa categorías como las instrucciones del proyecto, los archivos mencionados, la salida de las herramientas, el texto de razonamiento, la coordinación del equipo y los mensajes de usuario. Estas cifras son diagnósticos, no estados de cuenta de facturación del proveedor.

## Runtime

Un runtime es la ruta de ejecución local que ejecuta el turno de un agente. Las rutas de runtime admitidas incluyen Claude Code, Codex y OpenCode.

El runtime se encarga del comportamiento de ejecución del modelo, los detalles de autenticación, la semántica de ejecución de las herramientas, los límites de tasa, la disponibilidad de los modelos y algunos formatos de transcripción/registro.

## Proveedor

Un proveedor es la ruta de acceso a los modelos que hay detrás de un runtime. Los ids de proveedor actuales incluyen Anthropic, Codex y OpenCode. OpenCode puede enrutar hacia muchos proveedores de modelos mediante su propia configuración.

Agent Teams orquesta tareas y mensajes, pero no sustituye la autenticación del proveedor ni la política del proveedor.

## Modo solo

El modo solo ejecuta un equipo de un solo miembro. Resulta útil para trabajos rápidos, para reducir la sobrecarga de coordinación y para validar un prompt antes de expandirlo a un equipo completo.

## Comunicación entre equipos

Los agentes pueden enviarse mensajes dentro de un mismo equipo y entre equipos distintos. Úsalo cuando equipos separados se encargan de trabajos relacionados y necesitan coordinarse sin agruparlo todo en un único equipo de gran tamaño.

## Nivel de autonomía

La autonomía controla cuánto pueden hacer los agentes antes de preguntar. Una autonomía más alta es más rápida; una autonomía más baja es más segura para rutas de código sensibles, persistencia, autenticación de proveedores, operaciones de Git y publicaciones de versiones.

## Revisión

La revisión es el flujo de aceptación con alcance de tarea. Una tarea puede pasar a review, recibir comentarios o cambios solicitados y, después, pasar a approved cuando se acepta el resultado.

La revisión está ligada a los diffs locales y al historial de la tarea, por lo que funciona mejor cuando las tareas se mantienen acotadas y los agentes mencionan la tarea en la que están trabajando.
