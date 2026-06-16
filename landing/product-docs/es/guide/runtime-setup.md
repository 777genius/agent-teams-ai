---
title: Configuración del runtime – Documentación de Agent Teams
description: Configura los runtimes de Claude Code, Codex u OpenCode. Cubre la autenticación, el acceso a proveedores, el modo multimodelo y las comprobaciones previas al lanzamiento.
lang: es-ES
---

# Configuración del runtime

Agent Teams es una capa de coordinación. El trabajo real del modelo se ejecuta a través de runtimes y proveedores locales compatibles.

::: tip Inicio rápido: elige tu primer runtime
| Si tú ... | Empieza con |
| --- | --- |
| Ya usas Claude Code o tienes acceso a Anthropic | **Claude**: autenticación familiar, configuración mínima |
| Usas Codex o flujos de trabajo basados en OpenAI | **Codex**: integración nativa |
| Quieres probar Agent Teams sin registro ni claves de API | **OpenCode**: usa el modelo gratuito incluido sin autenticación |
| Quieres enrutamiento multimodelo o una amplia cobertura de proveedores | **OpenCode**: el más flexible, una sola configuración para muchos backends |
| No estás seguro de qué runtime encaja | **OpenCode**: cubre la mayor cantidad de opciones de proveedores y te permite cambiar más adelante |

Empieza con un runtime y un compañero de equipo. Confirma que un lanzamiento funciona antes de expandirte al modo multimodelo.
:::

## Requisitos previos

Antes de lanzar un equipo, asegúrate de que:

- El binario del runtime está instalado y en tu `PATH`.
- Tu cuenta de proveedor tiene acceso activo al modelo que pretendes usar, a menos que empieces con el modelo gratuito de OpenCode incluido sin autenticación.
- La ruta del proyecto existe y se puede leer.
- La aplicación y tu terminal usan el mismo entorno de home/configuración cuando pruebas la autenticación manualmente.

::: tip
Empieza con un solo compañero de equipo y un proveedor. Confirma que un lanzamiento funciona antes de añadir carriles multimodelo.
:::

Comprobaciones rápidas en la terminal:

```bash
command -v claude
command -v codex
command -v opencode
```

Ejecuta el comando del runtime que planeas usar. Si no imprime nada, instala el runtime o corrige el `PATH` antes de lanzar un equipo.

## Rutas compatibles

| Ruta | CLI predeterminada | Proveedores típicos | Úsala cuando |
| --- | --- | --- | --- |
| Claude | `claude` | Anthropic | Ya usas Claude Code o flujos de trabajo respaldados por Anthropic |
| Codex | `codex` | OpenAI | Quieres una integración de runtime nativa de Codex |
| OpenCode | `opencode` | OpenRouter y muchos backends | Quieres enrutamiento multimodelo y una amplia cobertura de proveedores |

La aplicación detecta los runtimes compatibles y guía la configuración desde la interfaz cuando es posible.

Gemini está disponible como una ruta de proveedor compatible con autenticación mediante Google ADC (`gcloud auth`), OAuth de Gemini CLI y clave de API. Configúralo desde la interfaz de configuración del runtime cuando se detecte el backend de Gemini.

## Acceso a proveedores

Agent Teams no tiene ningún nivel de pago propio. Puedes empezar con el modelo gratuito de OpenCode incluido sin autenticación: sin registro, sin claves de API ni tarjeta de crédito. Para modelos adicionales, aporta el acceso a proveedores que ya tengas: suscripciones, autenticación del runtime local o claves de API, según la ruta que elijas.

- Las rutas de **Claude** y **Codex** dependen de sus respectivas herramientas de autenticación de la CLI.
- **OpenCode** puede ejecutar primero el modelo gratuito incluido sin autenticación. Otros modelos de OpenCode pueden necesitar claves de API específicas del proveedor en un archivo de configuración (p. ej., `openrouter`, `openai`, `anthropic`).

## Configuración de la autenticación

### Claude Code

Ejecuta el flujo de autenticación estándar en una terminal:

```bash
claude login
```

Después, verifica que la CLI es accesible:

```bash
claude --version
```

Si la aplicación empaquetada informa de "not logged in" mientras que tu terminal funciona, compara el `$HOME` y el `PATH` que ve la aplicación con los de la terminal que usaste para iniciar sesión. El registro de diagnóstico de autenticación descrito en [Solución de problemas](/es/guide/troubleshooting#auth-diagnostic-log) es el mejor punto de partida.

### Codex

Instala y autentícate mediante el flujo de la CLI de OpenAI:

```bash
codex login
```

Después, verifica que el runtime es accesible:

```bash
codex --version
```

Los lanzamientos nativos de Codex usan el estado de la cuenta de Codex y los datos del catálogo de modelos cuando están disponibles. Si falta un modelo en la interfaz, actualiza el estado del proveedor antes de editar los prompts del equipo.

### OpenCode

Para usar el modelo gratuito incluido sin autenticación, selecciónalo en la aplicación y lánzalo sin registrarte en un proveedor. Para usar otros backends de OpenCode, crea o edita `~/.opencode/config.json` (o la ruta equivalente en tu plataforma) con la clave del proveedor que quieras:

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-..."
    }
  }
}
```

Usa el nombre de proveedor exacto que OpenCode espera. Si configuras un nombre de proveedor personalizado, compruébalo dos veces contra el ID de proveedor que usas en la cadena del modelo (por ejemplo, `openrouter/moonshotai/kimi-k2.6` usaría el bloque `openrouter`).

Ejemplos de cadenas de modelo:

| Cadena de modelo | Bloque de proveedor que debe existir |
| --- | --- |
| `openrouter/moonshotai/kimi-k2.6` | `openrouter` |
| `openai/gpt-5.4` | `openai` |
| `anthropic/claude-sonnet-4-6` | `anthropic` |

Si OpenCode se lanza pero un compañero de equipo nunca llega a ser entregable, inspecciona la evidencia del carril antes de asumir que el modelo ignoró el prompt. Consulta [Solución de problemas](/es/guide/troubleshooting#opencode-registered-but-bootstrap-unconfirmed).

### Gemini

Gemini admite tres métodos de autenticación:

- **Google ADC** — ejecuta `gcloud auth application-default login` para autenticarte mediante las credenciales predeterminadas de aplicación de Google (Application Default Credentials).
- **Gemini CLI** — ejecuta `gemini login` si la CLI de Gemini está instalada.
- **Clave de API** — define `GEMINI_API_KEY` en tu entorno o configúrala a través de la interfaz Manage Providers de la aplicación.

La aplicación detecta automáticamente qué método de autenticación está disponible y muestra el proveedor Gemini en la interfaz de configuración del runtime y de creación de equipos cuando el backend es accesible.

## Modo multimodelo

El modo multimodelo puede enrutar el trabajo a través de muchos backends de proveedores mediante una configuración compatible con OpenCode. Úsalo cuando necesites flexibilidad de proveedores o quieras que los compañeros de equipo usen carriles de modelo diferentes.

::: info Carriles de modelo
Cada compañero de equipo puede usar un par `providerId` + `model` diferente. En la interfaz de edición del equipo, expande las opciones del miembro para anular los valores predeterminados globales.
:::

Una configuración multimodelo conservadora:

| Rol | Proveedor | Por qué |
| --- | --- | --- |
| Lead | Claude o Codex | Mantén la coordinación en el proveedor en el que más confías |
| Builder | OpenCode | Usa un amplio enrutamiento de modelos para el trabajo de implementación |
| Reviewer | Claude, Codex o un segundo modelo de OpenCode | Separa el criterio de revisión del carril del builder |

Evita mezclar muchos proveedores desconocidos en el primer lanzamiento. Confirma una tarea pequeña por carril antes de asignar trabajo amplio.

## Lista de comprobación previa al lanzamiento

Antes de lanzar un equipo:

1. El runtime seleccionado está instalado
2. El binario del runtime está en el `PATH` del entorno
3. La autenticación del proveedor está configurada para el backend elegido
4. El proveedor tiene acceso a la cadena de modelo exacta que especifiques
5. La ruta del proyecto existe y se puede leer

## Cuándo cambiar de ruta de runtime

Cambia cuando la ruta actual esté bloqueada por la disponibilidad del modelo, los límites de tasa, las capacidades del proveedor o las necesidades de los roles del equipo. Mantén el mismo proyecto y flujo de trabajo del equipo, pero valida una tarea pequeña después de cambiar.

::: warning Trata los errores de configuración como problemas de configuración
Si la autenticación falla, se rechaza el nombre de un modelo o no se encuentra el binario del runtime, corrige primero la configuración. No cambies los prompts del equipo ni el código del proyecto para sortear un problema de configuración del runtime.
:::

Usa esta tabla de decisiones:

| Síntoma | Mejor primera acción |
| --- | --- |
| Binario no encontrado | Corrige la instalación o el `PATH` |
| El inicio de sesión funciona en la terminal pero no en la aplicación | Revisa el registro de diagnóstico de autenticación de Electron y el entorno |
| Modelo rechazado | Verifica el ID exacto del modelo en el runtime del proveedor |
| 429 repetidos | Reduce la concurrencia o cambia de modelo/proveedor |
| Carril de OpenCode atascado | Inspecciona el manifiesto del carril y `opencode-sessions.json` |
