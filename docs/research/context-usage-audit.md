# Context Usage Audit

**Дата**: 2026-04-18  
**Статус**: Research  
**Goal**: проверить, как в проекте сейчас считается usage контекста, сверить это с official docs и с реальными логами, и зафиксировать, что нужно менять для понятного и точного UI

## Executive Summary

Главный вывод:

- ✅ Для **Anthropic prompt-side input** текущая базовая формула `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` корректна.
- ❌ Для **"процент занятого контекста"** текущий UI смешивает несколько разных сущностей:
  - total prompt input
  - visible/debuggable context
  - full context used in the turn
  - guessed context window
- ❌ Кнопка открытия context panel на team screen сейчас показывает **не процент занятого контекста**, а смесь `visible context / total tokens`, при этом подписывает это как `of input`.
- ❌ Live lead context usage в team runtime **не учитывает `output_tokens`**, хотя Anthropic docs явно пишут, что input и output components count toward the context window.
- ⚠️ Для **Codex** текущие локальные session logs часто вообще не содержат usable input-side token telemetry: в `.jsonl` виден `output_tokens`, а `input_tokens/cache_*` остаются нулями. То есть "точный процент" для Codex из текущего источника правды пока получить нельзя.
- ⚠️ Для **Anthropic context window size** нельзя опираться только на `"[1m]"` suffix. По актуальным docs/релиз-ноутам окно зависит от конкретной модели: native `1M` уже есть у новых raw model ids вроде `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, тогда как часть legacy путей остаётся на `200k` или временном beta-path.

## 1. Что сейчас считается в коде

### 1.1 Live lead context в team runtime

Источник:

- `src/main/services/team/TeamProvisioningService.ts`

Текущая формула:

```ts
currentTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
percent = currentTokens / contextWindow
```

Это значение эмитится как `lead-context`.

Что важно:

- это **total prompt input**
- это **не full context used for the completed turn**
- `output_tokens` сейчас исключены

### 1.2 Context button на экране команды

Источник:

- `src/renderer/components/team/TeamDetailView.tsx`

Текущее поведение:

- собирается `visibleContextTokens = sumContextInjectionTokens(allContextInjections)`
- затем считается `visibleContextPercentLabel = formatPercentOfTotal(visibleContextTokens, lastAiGroupTotalTokens)`
- при этом `lastAiGroupTotalTokens` сейчас = `input + cache_read + cache_creation + output`
- но helper `formatPercentOfTotal()` возвращает строку вида `"X% of input"`

Итог:

- знаменатель уже **не input**
- числитель это вообще **visible subset**
- label говорит **of input**
- кнопка выглядит как будто это **общий context usage**

То есть тут сразу 3 semantic mismatch.

### 1.3 Session Context Panel / Token popover

Источники:

- `src/renderer/components/chat/SessionContextPanel/components/SessionContextHeader.tsx`
- `src/renderer/components/common/TokenUsageDisplay.tsx`

Сейчас в проекте одновременно существуют 3 разных процента:

1. `visible_estimated / total_input`
2. `visible_estimated / (input + output + cache)`
3. `prompt_input / context_window`

Но в UI они местами называются почти одинаково.

## 2. Что говорят official docs

### 2.1 Anthropic: что такое `input_tokens` при caching

Official docs:

- [Anthropic prompt caching](https://docs.anthropic.com/ru/docs/build-with-claude/prompt-caching)

Ключевые факты:

- `input_tokens` - это только токены **после последней cache breakpoint**
- total prompt input считается как:

```text
total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
```

Источник:

- docs lines 491-500, 493-500, 495:
  - `input_tokens` представляет только токены после последней точки разрыва кэша
  - `total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens`

Вывод:

- текущая базовая формула runtime для **Anthropic prompt input** правильная
- жалоба пользователя на "input percent" логична, потому что **`input_tokens` alone действительно не равен общему prompt input**

### 2.2 Anthropic: что вообще считается context window

Official docs:

- [Anthropic context windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)

Ключевые факты:

- context window refers to all text model can reference, **including the response itself**
- при tool use docs прямо говорят:
  - **all input and output components count toward the context window**

Источник:

- lines 194-197
- lines 215-220
- lines 255-262

Вывод:

- если UI обещает показать именно **"сколько контекста занято"**, то `output_tokens` игнорировать нельзя
- текущий live team formula under-reports occupied context for completed turn

### 2.3 Anthropic: thinking blocks

Official docs:

- [Anthropic context windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)

Ключевой факт:

- previous thinking blocks are automatically stripped from future context

Источник:

- lines 225-239, especially 228 and 237

Вывод:

- есть важная разница между:
  - **full context used during current turn**
  - **context that will carry into future prompt**
- usage fields alone не дают perfectly exact "future carried context" без доп. нормализации thinking

### 2.4 Anthropic: какие модели сейчас имеют 1M context window

Official docs:

- [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Anthropic release notes](https://platform.claude.com/docs/en/release-notes/overview)
- [Anthropic context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)

Ключевые факты на дату проверки:

- current models overview показывает:
  - `claude-opus-4-7` - `1M`
  - `claude-sonnet-4-6` - `1M`
  - `claude-haiku-4-5` - `200k`
- release notes отдельно фиксируют:
  - с `2026-03-13` `1M` GA для `Claude Opus 4.6` и `Claude Sonnet 4.6`
  - `2026-03-30` объявлен retirement beta-path для `Claude Sonnet 4.5` и `Claude Sonnet 4` на `2026-04-30`
- context windows page также указывает, что native long-context matrix уже не сводится к одному beta-header сценарию

Вывод:

- inference размера окна для Anthropic надо делать по **model matrix**, а не только по `"[1m]"` suffix
- internal app-alias `"[1m]"` всё ещё полезен как явный сигнал team UX, но для raw session model ids этого уже недостаточно

## 3. Что показывают реальные локальные логи

Проверены реальные `~/.claude/projects/*.jsonl`.

### 3.1 Claude / Anthropic

Типичный реальный кейс:

```json
"usage": {
  "input_tokens": 3,
  "cache_creation_input_tokens": 9284,
  "cache_read_input_tokens": 63347,
  "output_tokens": 8
}
```

Это значит:

- `input_tokens = 3` совсем не означает "в prompt было 3 токена"
- реальный total prompt input здесь:

```text
3 + 9284 + 63347 = 72634
```

То есть UI, который визуально намекает на "input %" без явного объяснения caching breakdown, будет выглядеть багованным даже если арифметика частично правильная.

### 3.2 Codex / OpenAI path в локальных session logs

Проверены реальные Codex entries в `~/.claude/projects/-Users-belief-dev-projects-claude-claude-team/**/*.jsonl`.

Типичный кейс:

```json
"usage": {
  "input_tokens": 0,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0,
  "output_tokens": 650
}
```

Повторяется много раз на `msg_codex_*`.

Вывод:

- текущий `.jsonl` source для Codex у нас часто не даёт usable prompt-side usage
- значит из **текущих session logs** нельзя честно строить accurate Codex context percent
- сначала нужен новый telemetry source или нормализация raw usage

## 4. Codex: что говорят official OpenAI docs

### 4.1 Context windows

Official docs:

- [GPT-5-Codex model](https://developers.openai.com/api/docs/models/gpt-5-codex)
- [codex-mini-latest model](https://developers.openai.com/api/docs/models/codex-mini-latest)

Ключевые факты на дату проверки:

- `GPT-5-Codex` - `400,000 context window`
- `codex-mini-latest` - `200,000 context window`

### 4.2 Cached prompt accounting

Official docs:

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

Ключевой факт:

- usage exposes `prompt_tokens_details.cached_tokens`

Это означает:

- на уровне OpenAI API нужная prompt-side telemetry в принципе существует
- но наш текущий local session source её, похоже, не сохраняет/не нормализует

## 5. Конкретные проблемы в текущем проекте

### 5.1 Semantic mismatch: "visible context" vs "context used"

Сейчас рядом живут две разные сущности:

- **Visible Context** - то, что мы можем debug/reduce
- **Context Used** - сколько окна реально занято

Это не одно и то же.

Visible Context:

- это subset prompt-side content
- может сравниваться с total prompt input

Context Used:

- это usage against context window
- для Anthropic completed turn это ближе к `total_input + output`

### 5.2 Неправильный label на context button

Текущая button label на team screen:

- выглядит как общий context usage
- но фактически это visible subset percent

Это и есть один из главных user-facing bugs.

### 5.3 Inconsistent denominators

Сейчас по коду используются разные denominators:

- `totalInputTokens`
- `input + output + cache`
- `contextWindow`

Без явного переименования метрик UI всегда будет путать.

### 5.4 Early-run guessed context window

В `TeamProvisioningService` размер окна сначала может быть guessed:

- `200K` для `limitContext=true`
- иначе по model-specific matrix:
  - internal Anthropic `"[1m]"` alias -> `1M`
  - native long-context Anthropic raw ids (`claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`) -> `1M`
  - `GPT-5.4` / `GPT-5.4 pro` -> `1.05M`
  - `codex-mini-latest` -> `200K`
  - остальные текущие GPT-5/Codex team models -> `400K`

Потом он обновляется из `modelUsage.contextWindow`, если это поле пришло.

Значит:

- ранний live percent может быть временно неточным

### 5.5 Shared default drift

В shared utils есть:

```ts
DEFAULT_CONTEXT_WINDOW = 200_000
```

Но team Anthropic UX по умолчанию исходит из `1M`.

Это не обязательно immediate arithmetic bug, но это source of drift для разных экранов и helper'ов.

## 6. Рекомендованная metric model

Если делать UI понятным и точным, нужно разделить **минимум 3 разные метрики**.

### 6.1 Prompt Input Used

Для Anthropic:

```text
prompt_input_used =
  input_tokens +
  cache_creation_input_tokens +
  cache_read_input_tokens
```

Назначение:

- честный size текущего prompt
- хорошая база для Visible Context %

### 6.2 Context Window Used

Для Anthropic completed turn:

```text
context_window_used_approx =
  prompt_input_used +
  output_tokens
```

Почему `approx`:

- previous thinking blocks auto-strip from future turns
- exact future carried context нельзя получить из raw usage perfectly

Но если UI обещает "занятое окно прямо сейчас/на этом ходе", эта формула ближе к docs, чем текущая.

### 6.3 Visible Context Share

```text
visible_context_share = visible_context_estimated / prompt_input_used
```

Назначение:

- debug metric
- объясняет, какая часть prompt-а понятна и управляемая пользователю

Это **не** percent occupied context window.

## 7. Рекомендованный UI language

Вместо одного размыто слова `Context` лучше использовать разные подписи:

- `Context Used` - percent of context window
- `Prompt Input` - current prompt-side tokens
- `Visible Context` - debuggable subset of prompt

Тогда пользователь сразу видит:

- сколько занято всего
- сколько из этого prompt
- сколько из prompt мы реально понимаем по breakdown

## 8. Top 3 implementation options

### 1. Развести 3 разные метрики и переименовать UI честно

`🎯 10   🛡️ 9   🧠 7`
Примерно `180-260` строк изменений

Что сделать:

- team button показывает только `Context Used`
- panel header отдельно показывает:
  - `Visible Context`
  - `Prompt Input`
  - `Context Window Used`
- `Visible Context` всегда считается только как доля prompt input

Плюсы:

- минимальный semantic debt
- почти все пользовательские жалобы закрываются сразу
- легче потом добавить Codex

Минусы:

- надо аккуратно переподписать UI в нескольких местах

### 2. Оставить один главный процент, но считать его по docs как `prompt + output`

`🎯 8   🛡️ 8   🧠 6`
Примерно `120-180` строк изменений

Что сделать:

- live team percent = `(input + cache_read + cache_creation + output) / contextWindow`
- `Visible Context` оставить только внутри sidebar/panel

Плюсы:

- очень понятная одна главная цифра
- максимально близко к official Anthropic context-window semantics

Минусы:

- future carried context всё равно не perfectly exact из-за thinking blocks
- нужен fallback wording, когда usage incomplete

### 3. Минимальный fix только label-ов и знаменателей

`🎯 6   🛡️ 6   🧠 3`
Примерно `40-90` строк изменений

Что сделать:

- перестать писать `of input`, если denominator не input
- button переименовать в `Visible`
- panel header явно разделить `Visible` и `Total`

Плюсы:

- быстро
- дешево

Минусы:

- не решает core semantic debt
- live lead percent всё ещё останется under-reported

## 9. Recommended next step

Рекомендую идти по **варианту 1**.

Почему:

- он закрывает и math, и naming, и UX confusion
- он не завязан только на Anthropic
- он даёт clean foundation для будущего Codex support

### Practical plan

1. Вынести явные type/terms для 3 метрик:
   - `promptInputTokens`
   - `contextWindowUsedTokens`
   - `visibleContextTokens`
2. Исправить live Anthropic runtime formula и wording.
3. Перестать использовать label `of input` там, где denominator не `prompt input`.
4. Для Codex временно показывать:
   - window size, если модель известна
   - `context usage unavailable` или `output only`
   - пока не появится raw prompt telemetry

## 10. Bottom line

Главная проблема сейчас не в одной строчке арифметики, а в том, что проект смешал:

- **prompt input**
- **visible debuggable context**
- **full context window usage**

В Anthropic path базовая input formula уже в целом нормальная, но UI поверх неё даёт неправильный смысл.

В Codex path проблема глубже:

- official API supports cached prompt accounting
- но наш текущий local session telemetry этого не доносит
- поэтому "точный % занятого контекста" для Codex пока нельзя обещать без нового data source
