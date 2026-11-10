# CodeBoarding Integration Idea

Дата проверки: 2026-05-03.

## Короткий вывод

CodeBoarding полезен для Agent Teams как опциональная визуализация архитектурного влияния агентских изменений. Он не выглядит как готовый embeddable real-time daemon для нашего Electron UI, но у него есть достаточная база для near real-time режима:

- baseline анализ через `codeboarding full --local <project>`;
- incremental анализ через `codeboarding incremental --local <project>`;
- partial обновление компонента через `codeboarding partial --local <project> --component-id <id>`;
- выходные артефакты в `.codeboarding/`, включая `analysis.json`, Markdown и Mermaid;
- method/component change tracking в VS Code extension.

Практичный продуктовый вариант: делаем CodeBoarding optional dependency, даём пользователю install/detect/setup в UI, запускаем full один раз, а дальше показываем live-ish overlay по изменениям агентов. Быструю подсветку делаем сами по git diff/task change ledger, а CodeBoarding incremental используем как более точный фоновый refresh.

## Что проверено

- GitHub repo: [CodeBoarding/CodeBoarding](https://github.com/CodeBoarding/CodeBoarding)
- Website: [codeboarding.org](https://www.codeboarding.org/)
- PyPI JSON: [pypi.org/pypi/codeboarding/json](https://pypi.org/pypi/codeboarding/json)
- Release: [v0.11.0](https://github.com/CodeBoarding/CodeBoarding/releases/tag/v0.11.0)
- VS Code Marketplace: [CodeBoarding extension](https://marketplace.visualstudio.com/items?itemName=Codeboarding.codeboarding)
- MCP repo: [CodeBoarding/CodeBoarding-MCP](https://github.com/CodeBoarding/CodeBoarding-MCP)

На момент проверки:

- Latest GitHub release: `v0.11.0`, published 2026-04-29.
- Latest PyPI version: `0.11.0`, requires Python `>=3.12,<3.14`.
- License: MIT.
- Repo активный: последний push был 2026-05-03.
- Основной стек CodeBoarding: Python CLI, static analysis, LSP, tree-sitter, LLM providers.
- Поддерживаемые языки из README/PyPI: Python, TypeScript, JavaScript, Java, Go, PHP, Rust, C#.
- LLM providers из README/PyPI: OpenAI, Anthropic, Google, Vercel AI Gateway, AWS Bedrock, Ollama, OpenRouter и другие.

## Что CodeBoarding умеет

Из README и CLI:

- генерирует high-level architecture diagrams;
- генерирует deeper component diagrams;
- пишет Markdown документацию в `.codeboarding/`;
- пишет Mermaid output, который удобно показывать в нашем Markdown/Mermaid viewer;
- умеет incremental updates, когда есть предыдущий analysis;
- умеет partial update одного component id;
- для private repos использует `GITHUB_TOKEN`;
- конфиг LLM ключей хранит в `~/.codeboarding/config.toml`, но env vars имеют приоритет.

Публичные команды CLI:

```bash
codeboarding full --local /path/to/repo
codeboarding incremental --local /path/to/repo
codeboarding partial --local /path/to/repo --component-id "1.2"
```

Установка из README/PyPI:

```bash
pipx install codeboarding --python python3.12
codeboarding-setup
codeboarding full --local /path/to/repo
```

Важно: `codeboarding-setup` скачивает language server binaries в `~/.codeboarding/servers/`. Node.js/npm нужен для Python, TypeScript, JavaScript и PHP language servers; если Node/npm не найден, CodeBoarding может скачать pinned Node runtime в `~/.codeboarding/servers/nodeenv/`.

## Real-time оценка

В VS Code Marketplace заявлено:

- `Realtime Component Change tracking` - можно видеть, в каких компонентах есть file edits.
- `0.11.0` - Git Commit Diff View, timeline slider, подсветка components/files/methods по recent commits.
- `0.11.0` - Faster Incremental Analysis, refresh переиспользует прошлые результаты и анализирует только затронутое.
- `0.10.0` - Method-Level Change Tracking.
- `0.10.0` - Real-time Method Updates.
- `0.10.2` - Smoother Real-time Updates.

Но в open-source CLI я не нашёл отдельного публичного `watch`/daemon режима. В коде есть incremental pipeline, worktree diff, `incrementalDelta`, method-level statuses, comments про IDE/wrapper integration и snapshot target refs, но публичный CLI остаётся командным.

Вывод: CodeBoarding позволяет сделать near real-time визуализацию, но real-time orchestration надо делать нам:

1. watcher ловит изменения файлов от агента;
2. debounce, например 2-10 секунд;
3. быстрый overlay строится по git diff/task change ledger и текущему `.codeboarding/analysis.json`;
4. CodeBoarding incremental запускается фоном реже или на завершение task;
5. UI обновляет Mermaid/architecture map и affected components.

## Что можно показать пользователю

Хорошо подходит:

- 🟢 новый файл попал в конкретный компонент;
- 🟡 метод или файл изменён внутри компонента;
- 🔴 файл/метод удалён;
- какие компоненты трогает конкретный агент;
- какие компоненты трогает конкретная task;
- архитектурный контекст рядом с code review;
- diff timeline по commits или task snapshots;
- Markdown/Mermaid docs прямо в нашем Project Editor/Review UI.

Сложно или рискованно:

- мгновенная перестройка диаграммы на каждый символ;
- точная визуализация rename/copy, потому что incremental pipeline сейчас может требовать full analysis для rename/copy;
- стабильная работа на очень больших репах без очереди, debounce и cancellation;
- full/incremental анализ без настроенного LLM provider;
- автоматическая установка Python 3.12/3.13 на всех OS без отдельного installer UX.

## Варианты интеграции

### 1. Optional CLI Runner + просмотр `.codeboarding/`

🎯 9   🛡️ 8   🧠 4  
Примерно `250-450` строк.

Суть: в Settings/Integrations добавляем CodeBoarding detect/install/run. Первый MVP только запускает `full`/`incremental`, показывает статус, открывает `.codeboarding/analysis.json` и Markdown/Mermaid в существующем viewer.

Плюсы:

- быстро проверить реальную пользу;
- почти не вмешивается в team/review lifecycle;
- опирается на уже существующие Markdown/Mermaid возможности;
- безопаснее, потому что dependency optional.

Минусы:

- это не live UX;
- пользователь сам интерпретирует изменения;
- нет красивой связки с задачами агентов.

Когда выбирать: если хотим дешёвый probe перед большой фичей.

### 2. Live-ish Overlay поверх baseline анализа

🎯 9   🛡️ 8   🧠 5  
Примерно `900-1400` строк.

Суть: CodeBoarding делает baseline `.codeboarding/analysis.json`. Дальше наш watcher/git status/task change ledger быстро мапит изменённые файлы на компоненты из baseline и подсвечивает affected components почти в реальном времени. CodeBoarding `incremental` запускается фоном по debounce, на завершение task или по кнопке refresh.

Плюсы:

- даёт пользователю ощущение real-time;
- не заставляет LLM работать на каждое маленькое изменение;
- хорошо ложится на агентские изменения и task review;
- можно показывать impact до завершения задачи.

Минусы:

- нужна собственная модель overlay state;
- baseline mapping может быть устаревшим до следующего incremental;
- для новых файлов компонент может определяться эвристикой до refresh.

Когда выбирать: лучший первый продуктовый вариант.

### 3. Architecture Review per Task

🎯 8   🛡️ 7   🧠 8  
Примерно `1600-2500` строк.

Суть: связываем CodeBoarding с review flow. Для каждой task показываем impacted components, changed methods, old/new architecture map, summary риска и ссылки на файлы. Можно добавить отдельную вкладку в task detail или review dialog.

Плюсы:

- максимальная ценность для Agent Teams;
- помогает ревьюить AI-generated changes не только по diff, но и по архитектурному влиянию;
- можно использовать как сильный selling point.

Минусы:

- крупная фича;
- нужны тесты на task-change mapping, IPC, persistence и UI;
- есть риск перегрузить review screen.

Когда выбирать: после MVP и подтверждения, что карты реально помогают пользователям.

## Варианты установки optional dependency

### A. pipx install в user environment

🎯 8   🛡️ 7   🧠 4  
Примерно `350-600` строк.

UI проверяет `python3.12`/`python3.13`, `pipx`, `codeboarding`. Если нет, предлагает install через `pipx install codeboarding --python python3.12`, затем `codeboarding-setup`.

Плюсы: соответствует README, изолированная среда, меньше конфликтов с системным Python.

Минусы: надо отдельно вести UX для отсутствующего Python/pipx.

### B. Скачать packaged binary из GitHub Release

🎯 7   🛡️ 7   🧠 6  
Примерно `600-1000` строк.

У CodeBoarding release `v0.11.0` содержит assets для macOS/Linux/Windows. Можно скачивать бинарь под OS, проверять sha256 asset и хранить в app-managed tools dir.

Плюсы: меньше зависимости от Python/pipx у пользователя.

Минусы: нужно аккуратно делать download, checksum, permissions, updates, notarization/security prompts.

### C. Встроить Python package в наш app bundle

🎯 4   🛡️ 5   🧠 9  
Примерно `1200-2200` строк.

Пакуем CodeBoarding и Python runtime вместе с приложением.

Плюсы: самый гладкий UX после установки.

Минусы: тяжёлый bundle, OS-specific packaging, LSP binaries, security/update burden. Для optional feature это слишком дорого.

Рекомендация: начать с A, потом рассмотреть B для packaged app.

## Как это ложится на нашу архитектуру

Так как фича пересекает main/preload/renderer и запускает внешний инструмент, её лучше делать по `docs/FEATURE_ARCHITECTURE_STANDARD.md`:

```text
src/features/codeboarding/
  contracts/
  core/
  main/
    adapters/
    infrastructure/
  preload/
  renderer/
```

Основные части:

- contracts: DTO для status, install state, run request, run result, affected components;
- core: правила выбора режима `full`/`incremental`, debounce policy, overlay merge policy;
- main/infrastructure: binary detection, installer, command runner, output parser, `.codeboarding` reader;
- main/adapters/input: IPC handlers;
- preload: bridge;
- renderer: settings panel, project action, architecture map panel, task/review badges.

Надо использовать path validation и не давать CodeBoarding работать вне выбранного project root.

## MVP flow

1. Пользователь открывает project.
2. UI показывает “Enable CodeBoarding architecture map”.
3. App проверяет наличие `codeboarding`.
4. Если нет, предлагает install.
5. После install запускает `codeboarding-setup`.
6. Первый запуск: `codeboarding full --local <project>`.
7. App читает `.codeboarding/analysis.json`.
8. Показывает diagram/docs.
9. Когда агент меняет файлы, app быстро подсвечивает affected components по baseline mapping.
10. После debounce или завершения task запускает `codeboarding incremental --local <project>`.
11. Если incremental возвращает `requiresFullAnalysis`, UI предлагает full refresh.

## Риски

- 🟠 LLM keys: без provider key full/incremental может не пройти. Нужен понятный setup и read-only detect.
- 🟠 Performance: full analysis может быть долгим. Нужны cancellation, queue, progress, timeout.
- 🟠 Dirty worktree: incremental умеет работать с worktree, но target refs и snapshots надо использовать аккуратно.
- 🟠 Cost: LLM вызовы могут стоить денег. Нужен явный opt-in и возможно “run on task complete” вместо постоянного refresh.
- 🟡 Security: не отправлять код в неизвестный сервис. CodeBoarding заявляет local processing plus direct provider API calls, но UX должен прямо показывать выбранный provider.
- 🟡 Generated files: `.codeboarding/` не всегда надо коммитить. Нужно дать настройку ignore/commit.
- 🟡 MCP: CodeBoarding-MCP выглядит сырым, поэтому не стоит брать его как основную интеграцию.

## Рекомендация

Делать поэтапно:

1. MVP optional CLI runner и viewer.
2. Live-ish overlay на базе нашего task change ledger и CodeBoarding baseline.
3. Background incremental refresh.
4. Architecture Review per Task.
5. Только потом MCP/context tools для агентов.

Самое ценное для пользователя: видеть не “агент изменил 12 файлов”, а “агент сейчас меняет Auth Runtime Detection и это затрагивает Provider Connection + Team Provisioning”. CodeBoarding может дать основу для такой карты, но realtime UX должен быть нашим.
