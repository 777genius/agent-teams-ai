# Model-Agnostic Proxy для Claude Code Agent Teams

Дата исследования: 2026-03-06

## Цель

Сделать Claude Code Agent Teams model-agnostic: lead остаётся на Claude, а teammates могут работать на GPT-4o, Gemini, DeepSeek, Kimi K2.5 и других моделях через прокси, который транслирует Anthropic Messages API в формат целевого провайдера.

## Ключевой механизм

Claude Code обращается к Anthropic Messages API (`/v1/messages`). Переменная `ANTHROPIC_BASE_URL` позволяет перенаправить запросы на локальный прокси. Прокси:

1. Принимает запрос в формате Anthropic Messages API
2. Транслирует в формат целевого провайдера (OpenAI Chat Completions и др.)
3. Пересылает провайдеру
4. Получает SSE-стрим ответа
5. Транслирует обратно в формат Anthropic SSE-событий
6. Отдаёт Claude Code CLI как будто это ответ от Claude

Team tools (TeamCreate, TaskCreate, SendMessage, TaskGet, TaskList, TaskUpdate, TeamDelete) исполняются **локально Claude Code CLI**. LLM только генерирует `tool_use` блоки. Значит прокси не нужно знать о team-семантике — достаточно корректно транслировать tool_use формат.

---

## Исследованные проекты

### 1. HydraTeams

- **URL**: https://github.com/Pickle-Pixel/HydraTeams
- **Назначение**: Прокси-переводчик API специально для Agent Teams
- **Язык**: TypeScript (~580 строк, 8 файлов)
- **Зависимости**: Zero runtime dependencies (только Node.js builtins)
- **Лицензия**: Не указана явно
- **Stars**: 33 | **Forks**: 9 | **Commits**: 4 | **Создан**: 2026-02-08

#### Архитектура

```
src/
  index.ts              (35)   — точка входа, banner, graceful shutdown
  proxy.ts              (280)  — HTTP-сервер, маршрутизация, retry
  config.ts             (95)   — CLI-аргументы, env vars, Codex JWT
  logger.ts             (190)  — логирование, идентификация сессий
  translators/
    types.ts            (120)  — интерфейсы Anthropic + OpenAI
    messages.ts         (85)   — конвертация истории сообщений
    request.ts          (65)   — Anthropic req -> OpenAI Chat Completions req
    request-responses.ts (145) — Anthropic req -> ChatGPT Responses API req
    response.ts         (185)  — OpenAI SSE -> Anthropic SSE
    response-responses.ts (235) — Responses API SSE -> Anthropic SSE
```

#### Два конвейера трансляции

1. **OpenAI Chat Completions API** (`--provider openai`) — для GPT-4o, GPT-4o-mini, o3-mini
2. **ChatGPT Responses API** (`--provider chatgpt`) — для ChatGPT Subscription ($0 дополнительных затрат)

#### Lead vs Teammate детекция

- Lead: маркер `<!-- hydra:lead -->` в CLAUDE.md (попадает в system prompt)
- Teammate: фраза `"the user interacts primarily with the team lead"` в system prompt
- Lead-запросы passthrough на настоящий Anthropic API
- Teammate-запросы транслируются на целевую модель

#### Что работает правильно

- Tool definitions: `input_schema` -> `parameters`, `tool_choice` маппинг корректен
- tool_use блоки ассистанта -> `tool_calls` формат OpenAI
- tool_result -> `role: "tool"` сообщения
- Streaming: StreamState отслеживает blockIndex, activeToolCalls, textBlockStarted
- Правильная SSE-последовательность: message_start -> content_block_start -> content_block_delta -> content_block_stop -> message_delta -> message_stop
- Retry с exponential backoff на 429 (до 5 попыток)

#### Найденные баги (code review)

| # | Баг | Серьёзность |
|---|-----|-------------|
| 1 | **response-responses.ts**: `content_index` используется вместо Anthropic `blockIndex` в `response.output_text.done` — content_block_stop уйдёт с неправильным index | Высокая |
| 2 | **proxy.ts**: `shouldPassthrough()` получает `parsed.system` (может быть массив `AnthropicSystemBlock[]`) как string — `count_tokens` passthrough для lead не сработает | Средняя |
| 3 | **proxy.ts**: Non-streaming `JSON.parse(tc.function.arguments)` — если OpenAI вернёт невалидный JSON, exception убьёт весь запрос | Средняя |
| 4 | **proxy.ts**: `shouldPassthrough("*")` означает "все Claude модели", а не "всё" — контринтуитивно | Низкая |
| 5 | **logger.ts**: Warmup-запросы определяются по `toolCount === 0` — может ложно классифицировать обычные запросы | Низкая |

#### Критические проблемы

| Проблема | Серьёзность |
|----------|-------------|
| 0 тестов | Критично |
| Нет таймаутов на upstream — fetch() без AbortController, зависнет навсегда | Критично |
| Слушает на 0.0.0.0 — доступен в сети, релеит auth headers | Критично |
| Teammate детекция по строке "the user interacts primarily with the team lead" — сломается при обновлении Claude Code | Высокая |
| Spoofed model hardcoded `claude-sonnet-4-5-20250929` — устареет | Средняя |
| Token counting = `JSON.length / 4` — грубая заглушка | Средняя |
| Нет extended thinking — thinking блоки игнорируются | Средняя |
| Нет image/multimodal — молча теряются | Низкая |

#### Безопасность

- Сервер слушает на 0.0.0.0 (все интерфейсы) — в сети это дыра
- Passthrough релеит auth headers (x-api-key, authorization, cookie) к api.anthropic.com
- JWT парсинг без валидации подписи
- Нет rate limiting на входящие запросы
- Логи могут содержать API-ключи в ответах об ошибках

#### Итоговые оценки

| Аспект | Оценка |
|--------|:------:|
| Архитектура | 7/10 |
| API трансляция | 6/10 |
| Lead/Teammate детекция | 5/10 |
| Обработка ошибок | 4/10 |
| Streaming | 7/10 |
| Безопасность | 3/10 |
| Production readiness | 3/10 |
| **Общая** | **5/10** |

---

### 2. free-claude-code

- **URL**: https://github.com/Alishahryar1/free-claude-code
- **Назначение**: Прокси для использования Claude Code с бесплатными моделями
- **Язык**: Python (FastAPI + uvicorn)
- **Stars**: 814 | **Forks**: 95 | **Issues**: 4 | **Создан**: 2026-01-28
- **Лицензия**: MIT
- **Тесты**: 85+ файлов, pytest, GitHub Actions CI

#### Архитектура

```
server.py                    — точка входа (uvicorn)
api/
  app.py                     — FastAPI factory + lifespan
  routes.py                  — POST /v1/messages, GET /health
  detection.py               — эвристики определения типа запроса
  optimization_handlers.py   — 5 fast-path перехватчиков
  request_utils.py           — подсчёт токенов (tiktoken cl100k_base)
  models/anthropic.py        — Pydantic модели Anthropic request
providers/
  base.py                    — BaseProvider (ABC)
  openai_compat.py           — OpenAICompatibleProvider (основная логика)
  common/
    message_converter.py     — Anthropic <-> OpenAI конвертер (~200 строк)
    sse_builder.py           — SSE event builder Anthropic формат (~300 строк)
    think_parser.py          — парсер <think> тегов (~80 строк)
    heuristic_tool_parser.py — парсер tool calls из текста
  nvidia_nim/, open_router/, lmstudio/ — конкретные провайдеры
```

#### Провайдеры и модели

##### NVIDIA NIM (бесплатно, 40 req/min)

**Tier S (флагманы):**

| Model ID | Thinking | Tool Calling |
|----------|:--------:|:------------:|
| `moonshotai/kimi-k2.5` | Да | Native |
| `qwen/qwen3-coder-480b-a35b-instruct` | Да | Native |
| `z-ai/glm5` | Да | Native |
| `deepseek-ai/deepseek-v3.2` | Да | Native |
| `mistralai/mistral-large-3-675b-instruct` | Да | Native |
| `minimaxai/minimax-m2.5` | Да | Native |

**Tier A:**

| Model ID | Thinking | Tool Calling |
|----------|:--------:|:------------:|
| `z-ai/glm4.7` | Да | Native |
| `mistralai/devstral-2-123b-instruct` | Да | Native |
| `openai/gpt-oss-120b` | Да | Native |
| `meta/llama-3.1-405b-instruct` | Нет | Native |

**Tier B (быстрые):**

| Model ID | Thinking | Tool Calling |
|----------|:--------:|:------------:|
| `qwen/qwen2.5-coder-32b-instruct` | Нет | Native |
| `stepfun-ai/step-3.5-flash` | Да | Native |
| `meta/llama-3.3-70b-instruct` | Нет | Native |

Всего в каталоге NIM **185 моделей**, все бесплатные. max_tokens: 81920.

##### OpenRouter (free модели с суффиксом `:free`)

**С Tool Calling + Thinking:**

| Model ID | Context | Max Output |
|----------|:-------:|:----------:|
| `openai/gpt-oss-120b:free` | 131K | 131K |
| `stepfun/step-3.5-flash:free` | 256K | 256K |
| `qwen/qwen3-coder:free` | 262K | 262K |
| `qwen/qwen3-235b-a22b-thinking-2507:free` | 131K | — |
| `z-ai/glm-4.5-air:free` | 131K | 96K |

**С Tool Calling, без Thinking:**

| Model ID | Context |
|----------|:-------:|
| `meta-llama/llama-3.3-70b-instruct:free` | 128K |
| `mistralai/mistral-small-3.1-24b-instruct:free` | 128K |
| `google/gemma-3-27b-it:free` | 131K |

Всего **28 бесплатных моделей** + мета-роутер `openrouter/free`.

##### LM Studio (полностью локально, без лимитов)

| Модель | VRAM | Качество кода |
|--------|:----:|:---:|
| `unsloth/MiniMax-M2.5-GGUF` | 48GB+ | 7/10 |
| `unsloth/Qwen3-Coder-480B-A35B-Instruct-GGUF` | 48GB+ | 8/10 |
| `unsloth/Qwen3.5-35B-A3B-GGUF` | 24GB | 6/10 |
| `unsloth/GLM-4.7-Flash-GGUF` | 24GB | 6/10 |
| `unsloth/Qwen2.5-Coder-32B-Instruct-GGUF` | 24GB | 6/10 |

#### Что лучше чем HydraTeams

| Аспект | free-claude-code | HydraTeams |
|--------|:---:|:---:|
| Тесты | **85+ файлов**, CI | 0 |
| Thinking blocks | **Два пути** (native + `<think>` парсер) | Нет |
| Token counting | **tiktoken** (реальный подсчёт) | `JSON.length / 4` |
| Provider abstraction | **ABC + наследование** | Hardcoded if/else |
| Error handling | **Graceful shutdown**, rate limiter | Базовый try/catch |
| Heuristic tool parser | **Есть** (для моделей без native tool use) | Нет |

#### Проблемы для Agent Teams

1. **Task tool patching** — принудительно ставит `run_in_background=False` в трёх местах. Опасная мина для team coordination
2. **Optimization interceptors** — 5 эвристик могут ложно сработать на teammate messages
3. **Общий rate limiter** — singleton `GlobalRateLimiter` (40 req/min, max_concurrency=5). 5 teammates = мгновенный bottleneck. Один 429 блокирует ВСЕХ
4. **Python 3.14 requirement** — ещё в beta, проблема для bundling
5. **tiktoken** требует Rust-скомпилированный .so — кросс-платформенная сборка сложная
6. **Нет lead/teammate разделения** — все запросы на один провайдер

#### Bundling с Electron

| Критерий | free-claude-code (Python) | HydraTeams (TypeScript) |
|----------|:---:|:---:|
| Bundling в Electron | PyInstaller ~100-150MB, Python 3.14, Rust deps | Прямо в main process, 0 deps |
| Размер | ~50MB минимум | ~580 строк, КБ |
| Кросс-платформа | tiktoken .so для каждой платформы | Нативный Node.js |
| Запуск | Child process + Python runtime | Просто import |

#### Переиспользуемое ядро (~900 строк Python)

- `message_converter.py` (~200 строк) — полностью независим
- `sse_builder.py` (~300 строк) — почти независим (убрать Task patching)
- `think_parser.py` (~80 строк) — полностью независим
- `openai_compat.py` (~250 строк) — stream_response логика

#### Итоговые оценки

| Критерий | Оценка |
|----------|:------:|
| Качество кода | 7/10 |
| Тесты | 8/10 |
| Bundling с Electron | 2/10 |
| Agent Teams совместимость | 3/10 |
| Адаптация под наш стек | 3/10 |

---

### 3. LiteLLM Proxy

- **URL**: https://github.com/BerriAI/litellm
- **Лицензия**: MIT (enterprise-фичи проприетарные)
- **Stars**: ~38,000 | **Forks**: ~6,200
- **Язык**: Python
- **Провайдеры**: 100+ (OpenAI, Gemini, Bedrock, Azure, Groq, DeepSeek...)

#### Как работает с Claude Code

```bash
export ANTHROPIC_BASE_URL="http://0.0.0.0:4000"
export ANTHROPIC_AUTH_TOKEN="$LITELLM_MASTER_KEY"
claude --model gpt-4o
```

Нативный Anthropic SDK-совместимый endpoint `/messages`. Полная трансляция tool_use, streaming SSE.

#### Почему НЕ подходит для Electron

| Проблема | Детали |
|----------|--------|
| Python | 70+ зависимостей, Prisma с Node binaries, grpcio |
| Размер | ~2 ГБ (Docker-образ) |
| RAM | Рекомендация 8 ГБ для production |
| Bundling | Никто никогда не бандлил с desktop app |

#### Известные баги с Claude Code

- [#21446](https://github.com/BerriAI/litellm/issues/21446) — Gemini не работает через LiteLLM
- [#14194](https://github.com/BerriAI/litellm/issues/14194) — Bedrock thinking + tools конфликтуют
- [#12222](https://github.com/BerriAI/litellm/issues/12222) — Gemini падает на tools с optional args
- [#18730](https://github.com/BerriAI/litellm/issues/18730) — Concurrent requests обходят rate limits

**Вердикт: enterprise-серверный gateway, не для десктопа. 1/10 для нашего кейса.**

---

### 4. Bifrost (Maxim AI)

- **URL**: https://github.com/maximhq/bifrost
- **Лицензия**: Apache 2.0
- **Stars**: ~2,700 | **Commits**: 3,341
- **Язык**: Go (11 мкс overhead при 5000 RPS)
- **Провайдеры**: 20+ (OpenAI, Gemini, Bedrock, Azure, Mistral, Ollama...)

#### Bundling с Electron

Bifrost компилируется в единый статический Go-бинарник. npm-пакет `@maximhq/bifrost` скачивает prebuilt binary с CDN под нужную платформу.

```
https://downloads.getmaxim.ai/bifrost/{version}/{platform}/{arch}/bifrost-http
```

Поддерживаемые платформы:
- darwin/arm64 (macOS Apple Silicon)
- darwin/amd64 (macOS Intel)
- linux/amd64, linux/386
- windows/amd64, windows/arm64

Размер: ~30-60 MB. Запуск: `child_process.spawn(bifrostBinaryPath)`.

**Bundling: 9/10** — скачать бинарник, положить рядом, запустить как child process.

#### Проблемы для Agent Teams

| Issue | Описание | Статус |
|-------|----------|--------|
| [#1164](https://github.com/maximhq/bifrost/issues/1164) | Parallel tool calls через Bedrock не работают | Открыт |
| [#1829](https://github.com/maximhq/bifrost/issues/1829) | Streaming tool call deltas мёрджатся | Закрыт |
| [#1804](https://github.com/maximhq/bifrost/issues/1804) | Streaming tool calls с агентскими клиентами не работают | Открыт |
| [#828](https://github.com/maximhq/bifrost/issues/828) | Goroutine leak при context cancellation | Открыт |
| [#1613](https://github.com/maximhq/bifrost/issues/1613) | SSE streaming от Gemini ломается | Открыт |

Не использует anthropic-go-sdk, дублирует типы вручную (Discussion #1259).

**Никто не тестировал Bifrost с Agent Teams.**

#### Итоговые оценки

| Критерий | Оценка |
|----------|:------:|
| Bundling с Electron | 9/10 |
| Agent Teams (passthrough) | 8/10 |
| Agent Teams (трансляция) | 4/10 |
| Зрелость | 7/10 |

---

## Сравнение качества моделей vs Claude

| Модель | Кодинг | vs Sonnet | vs Opus |
|--------|:------:|:---------:|:-------:|
| Kimi K2.5 (NIM) | 8/10 | ~80% | ~60% |
| Qwen3 Coder 480B (NIM) | 8/10 | ~80% | ~60% |
| GLM-5 (NIM) | 7/10 | ~70% | ~50% |
| GPT-OSS 120B (NIM/OR) | 7/10 | ~70% | ~50% |
| GLM-4.7 (NIM) | 7/10 | ~65% | ~45% |
| Step 3.5 Flash (OR) | 6/10 | ~55% | ~35% |
| Llama 3.3 70B (OR) | 5/10 | ~45% | ~30% |

Ни одна бесплатная модель не дотягивает до Claude по качеству агентного кодинга.

---

## Юридические аспекты

### Что разрешено Anthropic

- `ANTHROPIC_BASE_URL` — **официально поддерживается** для LLM Gateway
- Использование прокси с собственными API-ключами других провайдеров — легально
- Документация описывает LLM Gateway конфигурацию: endpoint должен реализовывать Anthropic Messages API

### Что запрещено

- Использование OAuth-токенов от Claude Free/Pro/Max подписок в сторонних продуктах
- Anthropic активно блокирует несанкционированное использование подписочных токенов
- Использование Claude для обучения конкурирующих моделей (Section D.4 Commercial Terms)

### ChatGPT backend API (HydraTeams)

- `chatgpt.com/backend-api/codex/responses` — недокументированный API
- Нарушение ToS ChatGPT при автоматизации через backend API
- Может быть заблокирован в любой момент

---

## Влияние на наш проект (Claude DevTools)

JSONL формат сессий **не меняется** — Claude Code CLI генерирует одинаковую структуру независимо от backend-модели. TeamCreate, TaskCreate, SendMessage и прочие team tools остаются теми же. Парсинг и chunk building будет работать без изменений.

Единственное потенциальное отличие — metadata о модели в сообщениях (model field).

---

## Рекомендация по реализации

### Лучший путь: форк HydraTeams + hardening

HydraTeams — единственный проект заточенный под Agent Teams, на TypeScript (наш стек), zero deps, встраивается в Electron main process.

**Что нужно починить обязательно:**
1. Localhost-only binding (`127.0.0.1`)
2. AbortController + таймауты на upstream fetch
3. Баги с indices в response-responses.ts
4. Тесты на трансляцию (unit-тесты на каждый translator)
5. Убрать hardcoded spoofModel -> сделать конфигурируемым

**Что заимствовать из free-claude-code:**
1. ThinkTagParser — переписать на TS (~50 строк)
2. Provider abstraction — интерфейс `TranslationProvider`
3. Структуру тестов
4. Heuristic tool parser для моделей без native tool calling

**Что переосмыслить:**
- Lead/teammate детекция — маркер по строке хрупкий. Мы знаем роли из TeamDataService, можно передавать через env var `HYDRA_ROLE=lead|teammate`

### Оценка трудозатрат

~2-3 дня на hardening + тесты. Итого: TypeScript-пакет ~800-1000 строк с тестами, встраиваемый в Electron main process.

### Альтернативы

| Вариант | Надёжность | Уверенность |
|---------|:----------:|:-----------:|
| Форк HydraTeams + hardening | 7/10 | 8/10 |
| Свой proxy с нуля на TS (вдохновлённый обоими) | 8/10 | 7/10 |
| Bifrost binary + thin TS translator | 5/10 | 6/10 |
| LiteLLM как Docker sidecar | 6/10 | 7/10 |
| free-claude-code (Python child process) | 3/10 | 8/10 |

---

## Другие найденные проекты

| Проект | Описание | Применимость |
|--------|----------|:---:|
| [1rgs/claude-code-proxy](https://github.com/1rgs/claude-code-proxy) | На базе LiteLLM, BIG/SMALL model маппинг | 5/10 |
| [fuergaosi233/claude-code-proxy](https://github.com/fuergaosi233/claude-code-proxy) | Anthropic -> OpenAI конвертер | 4/10 |
| [nielspeter/claude-code-proxy](https://github.com/nielspeter/claude-code-proxy) | Легковесный бинарник, OpenRouter | 4/10 |
| [9router](https://github.com/decolua/9router) | Smart router с fallback-каскадом | 5/10 |
| [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) | MCP-сервер, реимплементация Agent Teams | 3/10 |

---

## Архитектурная схема целевого решения

```
[Lead Agent Process]
  ANTHROPIC_BASE_URL=http://127.0.0.1:{port}
  HYDRA_ROLE=lead
       |
       v
[Proxy (TypeScript, в Electron main process)]
  if role=lead  --> passthrough к api.anthropic.com
  if role=teammate --> трансляция к целевому провайдеру
       |
       v
[Teammate 1] --> OpenAI API (GPT-4o)
[Teammate 2] --> NVIDIA NIM (Kimi K2.5)
[Teammate 3] --> Local (LM Studio)
```

Stream-json протокол (stdin/stdout между lead и teammates) **не затрагивается** — прокси работает на уровне HTTP API запросов к LLM.
