---
title: Proveedores y runtimes – Documentación de Agent Teams
description: Rutas de runtime compatibles (Claude Code, Codex, OpenCode), IDs de proveedor, nomenclatura de modelos, estrategias multiproveedor y comprobaciones de capacidades.
lang: es-ES
---

# Proveedores y runtimes

Agent Teams separa la orquestación del acceso a los modelos. La aplicación gestiona los equipos, las tareas, los mensajes, el estado de lanzamiento y la interfaz de revisión; la ruta de runtime/proveedor seleccionada realiza el trabajo real del modelo.

## Qué proporciona la aplicación

Agent Teams proporciona:

- orquestación de equipos y tareas
- interfaz del tablero kanban
- mensajería entre compañeros de equipo
- registros de tareas
- interfaz de revisión
- integración con proyectos locales
- detección del runtime y comprobaciones de capacidades
- registros y diagnósticos locales

## Qué proporciona el runtime

El runtime proporciona:

- ejecución del modelo
- autenticación del proveedor
- comportamiento de la ejecución de herramientas
- límites de tasa y capacidades específicas del modelo
- transcripciones y pruebas de entrega específicas del runtime

## Rutas de runtime compatibles

| Ruta de runtime | Ruta de proveedor/modelo | Mejor para | Notas |
| --- | --- | --- | --- |
| Claude Code | Anthropic / modelos Claude | Usuarios de Claude Code y flujos de trabajo respaldados por Anthropic | Ruta predeterminada local-first para equipos de Claude. Requiere que el runtime y el acceso a la cuenta estén disponibles localmente. |
| Codex | Codex / modelos respaldados por OpenAI | Flujos de trabajo nativos de Codex | Utiliza la integración del runtime de Codex y el estado de auth/cuenta de Codex cuando está disponible. Algunos diagnósticos difieren de las transcripciones de Claude. |
| OpenCode | Enrutamiento de modelos gestionado por OpenCode | Equipos multiproveedor y amplia cobertura de modelos | OpenCode puede enrutar a través de muchos proveedores de modelos. Agent Teams trata las lanes de OpenCode como pruebas específicas del runtime y evita hacer suposiciones cuando la identidad de la lane es ambigua. |


## IDs de proveedor

Actualmente la aplicación reconoce estos IDs de proveedor en la configuración de equipo/runtime:

| ID de proveedor | Intención de visualización |
| --- | --- |
| `anthropic` | Ruta de Anthropic / Claude Code |
| `codex` | Ruta de Codex |
| `opencode` | Ruta de OpenCode, incluido el enrutamiento de proveedores gestionado por OpenCode |

No interpretes esta tabla como una garantía de que todos los proveedores estén autenticados, instalados o disponibles para todos los modelos en todas las máquinas. El estado del runtime y las comprobaciones de capacidades son la fuente de verdad para un lanzamiento determinado.

## IDs de modelo

Los IDs de modelo se pasan al runtime seleccionado. Agent Teams no reescribe el catálogo de modelos de un proveedor en un esquema de nomenclatura universal.

Ejemplos:

| Ruta de proveedor | Ejemplo de ID de modelo | Notas |
| --- | --- | --- |
| Claude Code | `opus`, `sonnet`, o un ID completo de modelo Claude | La disponibilidad depende de Claude Code y del acceso a la cuenta |
| Codex | `gpt-5.4`, `gpt-5.3-codex` | La disponibilidad proviene del estado de cuenta/runtime de Codex |
| OpenCode | `openrouter/moonshotai/kimi-k2.6` | El prefijo debe coincidir con una configuración de proveedor de OpenCode |

Si un nombre de modelo es rechazado, verifícalo primero directamente en el runtime/proveedor. Cambiar el briefing de un equipo no puede hacer que se lance un modelo no disponible.

## Estrategia multiproveedor

Agent Teams mantiene la orquestación consciente del proveedor, pero no propiedad del proveedor:

- los equipos, las tareas, las bandejas de entrada, los comentarios, el estado de revisión y los diagnósticos de lanzamiento permanecen en el almacenamiento local de Agent Teams
- cada miembro puede llevar configuraciones de proveedor/modelo a través de los metadatos de lanzamiento del equipo
- la disponibilidad de modelos, la autenticación, los límites de tasa y el comportamiento de las herramientas siguen siendo responsabilidades del runtime/proveedor
- OpenCode es la ruta de enrutamiento más amplia cuando quieres que un equipo utilice varias lanes de proveedor/modelo

Para conocer los límites orientados a colaboradores y la guía canónica de implementación, consulta [Arquitectura para colaboradores](/es/reference/contributor-architecture).

Patrones recomendados:

| Patrón | Cuándo ayuda | Riesgo |
| --- | --- | --- |
| Un proveedor para todos los miembros | Primer lanzamiento, repos sensibles, depuración más sencilla | Los límites de tasa compartidos pueden detener a todo el equipo |
| Lead potente + builders más económicos | Mantener la planificación/revisión fiable mientras se reduce el coste de implementación | La salida de los builders puede requerir una revisión más estricta |
| Modelos separados para builder y reviewer | Detectar puntos ciegos específicos de cada modelo | Más configuración y atribución que inspeccionar |

## Costes del proveedor

Agent Teams es gratis y de código abierto. Puedes empezar con el modelo gratuito incluido sin autenticación: sin registro, claves de API ni tarjeta de crédito. El uso de proveedores de pago o respaldados por una cuenta se rige por el runtime/proveedor que selecciones: los límites de suscripción, las claves de API, la autenticación de la cuenta, los límites de tasa y las políticas del proveedor permanecen todos externos a la aplicación.

## Comprobaciones de capacidades

Durante la configuración, la aplicación puede realizar comprobaciones de acceso y de capacidades. Esto ayuda a detectar la falta de autenticación del runtime antes de que un lanzamiento de equipo falle a mitad del aprovisionamiento.

Las comprobaciones de capacidades pueden informar de que un proveedor existe pero no está autenticado, de que una lista de modelos no está disponible, de que falta una ruta de runtime o de que una capacidad de extensión específica no es compatible. Trata esos resultados como diagnósticos de configuración, no como fallos de tareas.

Soluciones típicas de configuración:

| Resultado de la comprobación | Qué hacer |
| --- | --- |
| Runtime ausente | Instala la CLI o corrige el `PATH` |
| Proveedor no autenticado | Ejecuta el flujo de inicio de sesión del proveedor o añade la clave de API requerida |
| Modelo no disponible | Elige un modelo visible en la lista de modelos de ese runtime |
| Capacidad no compatible | Usa otra ruta de runtime para ese compañero de equipo |

## Límites que cabe esperar

- La compatibilidad con un runtime no significa una paridad de funciones igual entre Claude Code, Codex y OpenCode.
- La cobertura de registros y transcripciones difiere según el runtime.
- Las lanes de OpenCode necesitan pruebas estables de lane/sesión antes de que la aplicación pueda atribuir los registros del runtime de forma segura.
- Los nombres de modelo de los proveedores y su disponibilidad pueden cambiar al margen de la aplicación.
- Un prompt de equipo no puede solucionar la falta de autenticación, las entradas de PATH ausentes, las interrupciones del proveedor ni los límites de tasa agotados.
