---
title: Crear un equipo – Documentación de Agent Teams
description: Define roles, asigna proveedores y modelos, redacta un briefing de equipo y configura el aislamiento por worktree y los niveles de autonomía.
lang: es-ES
---

# Crear un equipo

Un equipo es un grupo con nombre de agentes con roles, un lead, un proyecto objetivo y un prompt de coordinación.

## Primer equipo recomendado

Empieza con un equipo pequeño:

| Rol      | Propósito                                                  |
| -------- | --------------------------------------------------------- |
| Lead     | Divide el trabajo, crea tareas, coordina a los compañeros |
| Builder  | Implementa tareas acotadas                                |
| Reviewer | Revisa el resultado, detecta regresiones, pide correcciones |

Esta estructura te da suficiente coordinación para ver el valor del producto sin hacer ruidoso el primer lanzamiento.

::: tip
Puedes añadir más miembros más adelante. Empieza con poco, valida el flujo de trabajo y luego escala.
:::

## Asignar proveedores y modelos

Cada miembro del equipo se ejecuta sobre un backend de proveedor. En el editor de equipos, elige un proveedor (Claude, Codex u OpenCode) y un modelo para cada miembro. La aplicación solo muestra los proveedores con los que ya te has autenticado.

Se admite mezclar proveedores en un mismo equipo — por ejemplo, un lead de Claude con builders de OpenCode.


## Redactar un buen briefing de equipo

El briefing de equipo debería incluir:

- el resultado que quieres
- los archivos o áreas de funcionalidad que importan
- los límites de riesgo, como "no refactorizar módulos no relacionados"
- las expectativas de revisión
- los comandos de verificación cuando los conozcas

Ejemplo:

```text
Build a focused improvement to the download flow. Keep changes inside the landing app unless a shared helper is clearly needed. Create tasks before implementation, review each task diff, and run landing lint/build checks.
```

## Aislamiento por worktree

Los miembros de OpenCode pueden usar el **aislamiento por worktree** para trabajar en un worktree de Git independiente en lugar del directorio de trabajo principal. Esto evita conflictos de archivos cuando varios agentes editan el mismo proyecto.

::: warning
El aislamiento por worktree requiere un proyecto rastreado por Git y, actualmente, está limitado a los miembros de OpenCode.
:::

Para activarlo, activa la opción **Worktree isolation** al añadir o editar un miembro de equipo de OpenCode.

## Elegir la autonomía

Agent Teams admite distintos niveles de control. Usa más autonomía para cambios rutinarios y una revisión más estricta para áreas de riesgo como la autenticación de proveedores, el IPC, la persistencia, los flujos de trabajo de Git y las herramientas de publicación.

### Nivel de esfuerzo

Cada miembro del equipo tiene un ajuste de **esfuerzo** que controla cuánto razonamiento invierte el proveedor antes de responder. Un esfuerzo mayor produce un resultado más exhaustivo a costa de tiempo y tokens.

| Nivel  | Cuándo usarlo                                                  |
| ------ | ------------------------------------------------------------- |
| Low    | Consultas rápidas, pequeños cambios de formato, ediciones rutinarias |
| Medium | Predeterminado para la mayoría de tareas de implementación    |
| High   | Refactorizaciones complejas, cambios transversales, rutas de código de riesgo |

La aplicación ofrece niveles adicionales (minimal, xhigh, max) para los proveedores que los admiten. Si un modelo no admite un esfuerzo configurable, el selector se desactiva y se usa el valor predeterminado del proveedor.

### Modo rápido

Activa el **Modo rápido** por miembro para priorizar la velocidad sobre la profundidad. Esto se corresponde con el modo rápido/de velocidad nativo del proveedor cuando está disponible. Ponlo en **On** para tareas rutinarias, en **Off** para trabajo cuidadoso, o en **Inherit** para seguir el valor predeterminado a nivel de equipo.

### Limitar el contexto

Activa **Limit context** para reducir la ventana de contexto de un miembro. Esto es útil para los modelos de Claude que admiten contexto extendido (p. ej. 1M de tokens) — limitar el contexto evita un uso innecesario de tokens y puede mejorar la latencia en tareas que no necesitan un contexto amplio.

## Añadir contexto

Adjunta archivos, capturas de pantalla o notas concretas cuando cambien la tarea de forma sustancial. Los agentes pueden usar las descripciones de las tareas, los comentarios y los archivos adjuntos como contexto duradero.

## Vigilar la calidad de las tareas

Los buenos equipos crean tareas que son:

- lo bastante específicas para revisar
- lo bastante pequeñas para terminar
- vinculadas a un resultado visible
- respaldadas por una ruta de verificación

Si el lead crea tareas imprecisas, envía un mensaje directo pidiendo tareas más pequeñas y comprobables.

## Próximos pasos

- [Configuración del runtime](/es/guide/runtime-setup) — configura la autenticación de proveedores y los modelos
- [Revisión de código](/es/guide/code-review) — acepta, rechaza o comenta los cambios de los agentes
- [Solución de problemas](/es/guide/troubleshooting) — problemas habituales y soluciones
