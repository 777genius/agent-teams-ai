---
title: Documentación de Agent Teams – Ejecuta equipos de agentes de IA desde una aplicación de escritorio local
description: Documentación de Agent Teams, una aplicación de escritorio gratuita para la orquestación de agentes de IA. Crea equipos, observa el trabajo en un tablero kanban, revisa los cambios de código y coordina flujos de trabajo con Claude, Codex, OpenCode y multimodelo.
lang: es-ES
layout: home
hero:
  name: Documentación de Agent Teams
  text: Ejecuta equipos de agentes de IA desde una aplicación de escritorio local
  tagline: Crea equipos, observa el trabajo moverse por un tablero kanban, revisa los cambios de código y coordina flujos de trabajo con Claude, Codex, OpenCode y multimodelo sin renunciar al control local.
  actions:
    - theme: brand
      text: Inicio rápido
      link: /es/guide/quickstart
    - theme: alt
      text: Instalar
      link: /es/guide/installation
    - theme: alt
      text: Conceptos
      link: /es/reference/concepts
features:
  - icon: "01"
    title: Flujo de trabajo centrado en el equipo
    details: Define roles, lanza un lead y deja que los agentes dividan, reclamen y coordinen las tareas.
    link: /es/guide/create-team
    linkText: Crear un equipo
  - icon: "02"
    title: Tablero kanban en vivo
    details: Observa cómo las tareas avanzan por todo, in progress, review, done y approved a medida que los agentes trabajan.
    link: /es/guide/agent-workflow
    linkText: Entender el flujo de trabajo
  - icon: "03"
    title: Revisión de código integrada
    details: Inspecciona los diffs por tarea, acepta o rechaza hunks y comenta donde los agentes necesiten orientación.
    link: /es/guide/code-review
    linkText: Revisar cambios
  - icon: "04"
    title: Configuración adaptada al runtime
    details: Usa Claude, Codex, OpenCode o proveedores multimodelo a través del acceso que ya tienes.
    link: /es/guide/runtime-setup
    linkText: Configurar los runtimes
  - icon: "05"
    title: Control local-first
    details: La aplicación de escritorio lee el estado local del proyecto y del runtime. Tu código permanece en tu máquina a menos que un proveedor seleccionado reciba el contexto del prompt.
    link: /es/reference/privacy-local-data
    linkText: Modelo de privacidad
  - icon: "06"
    title: Equipos depurables
    details: Rastrea los logs de las tareas, la salida del runtime, los mensajes de los compañeros de equipo y los procesos en vivo cuando un lanzamiento o una tarea se atasca.
    link: /es/guide/troubleshooting
    linkText: Solución de problemas
---

<InstallBlock label="Copiar" copied-label="Copiado" />

## Empieza aquí

Agent Teams es una aplicación de escritorio gratuita para orquestar equipos de agentes de IA. No te limitas a enviar prompts aislados a un solo agente: creas un equipo, asignas roles y observas cómo los agentes coordinan el trabajo a través de un tablero de tareas.

<DocsCardGrid />

## Próximos pasos después del lanzamiento

Después de crear tu primer equipo, explora estas guías para ir más allá:

- **Configuración del runtime** - configura Claude, Codex, OpenCode o proveedores multimodelo: [Configurar los runtimes](/es/guide/runtime-setup)
- **Flujo de trabajo de los agentes** - entiende cómo los agentes coordinan a través del tablero de tareas: [Entender el flujo de trabajo](/es/guide/agent-workflow)
- **Ejemplos de briefing de equipo** - aprende patrones de prompts a partir de briefings del mundo real: [Ver ejemplos](/es/guide/team-brief-examples)
- **Revisión de código** - inspecciona los diffs, acepta o rechaza los cambios: [Revisar cambios](/es/guide/code-review)
- **Solución de problemas** - diagnostica lanzamientos atascados, compañeros de equipo ausentes y fallos de tareas: [Solución de problemas](/es/guide/troubleshooting)
- **Estrategia de Git y worktree** - usa el aislamiento con worktree cuando varios compañeros de equipo editan el mismo repositorio en paralelo: [Conoce más sobre los worktrees](/es/guide/git-worktree-strategy)
- **Notas de la versión** - consulta las novedades de cada versión: [Ver versiones](/es/reference/release-notes)

## Referencia

Usa las páginas de referencia cuando necesites terminología exacta, el comportamiento de los proveedores, la arquitectura para colaboradores o los límites de privacidad.

<DocsCardGrid type="reference" />

## Vista previa del producto

<ZoomImage src="/screenshots/product-preview.png" alt="Tablero kanban de Agent Teams" caption="El estado de las tareas, la actividad de los compañeros de equipo y el flujo de revisión permanecen visibles en un único espacio de trabajo." />
