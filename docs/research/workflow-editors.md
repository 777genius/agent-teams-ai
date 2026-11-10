# Workflow Editor: визуальные библиотеки и паттерны

> Дата: 2026-03-04
> Статус: Исследование завершено

## Цель

Выбрать библиотеку для визуального node-based workflow editor в React-приложении для оркестрации AI-агентов.

---

## Часть 1: Библиотеки

### ✅ @xyflow/react (React Flow) — ОДНОЗНАЧНЫЙ ЛИДЕР

| Параметр | Значение |
|---|---|
| **GitHub** | [xyflow/xyflow](https://github.com/xyflow/xyflow) |
| **npm** | [@xyflow/react](https://www.npmjs.com/package/@xyflow/react) |
| **Stars** | ~35,500 |
| **npm загрузки/неделю** | ~4,900,000 (старый `reactflow` + новый `@xyflow/react`) |
| **Версия** | v12.10.1 (2025) |
| **Лицензия** | MIT |
| **Bundle size** | ~40-50 kB min+gzip |
| **TypeScript** | Полная поддержка, написан на TypeScript |
| **React** | Нативная React-библиотека |

**Ключевые фичи:**
- Drag & drop нод, zoom/pan, minimap, controls — из коробки
- Кастомные ноды и edges = обычные React-компоненты
- Hooks API (`useNodes`, `useEdges`, `useReactFlow`)
- Новые React Flow Components на базе **shadcn/ui** (2025)
- Performance: перерисовываются только изменённые ноды

**Кто использует:** Stripe, n8n (Vue Flow), Langflow, Flowise, **Dify** — 4 из 8 крупнейших AI-платформ

**Надёжность: 10/10 | Уверенность: 10/10**

---

### Rete.js

| Параметр | Значение |
|---|---|
| **GitHub** | [retejs/rete](https://github.com/retejs/rete) |
| **Stars** | ~11,900 |
| **npm загрузки/неделю** | ~42,700 |
| **Лицензия** | MIT |
| **React** | Через плагин `rete-react-plugin` |

Фреймворк-агностик (React, Vue, Angular, Svelte). Более "инженерный" подход с типизированными портами. Rete Studio — уникальная фича code ↔ visual. Но значительно меньше комьюнити и слабее документация.

**Надёжность: 7/10 | Уверенность: 8/10**

---

### AntV X6

| Параметр | Значение |
|---|---|
| **GitHub** | [antvis/X6](https://github.com/antvis/X6) |
| **Stars** | ~6,400 |
| **npm загрузки/неделю** | ~68,200 |
| **Лицензия** | MIT |

Enterprise-grade, часть экосистемы Ant Design. SVG/HTML рендеринг. Но документация преимущественно на китайском, React-интеграция через обёртки.

**Надёжность: 7/10 | Уверенность: 8/10**

---

### JointJS / JointJS+

| Параметр | Значение |
|---|---|
| **GitHub** | [clientIO/joint](https://github.com/clientIO/joint) |
| **Stars** | ~5,170 |
| **Лицензия** | MPL 2.0 (open source) / Commercial (JointJS+ от $2,990) |

Самая зрелая библиотека (с 2010). BPMN 2.0, UML, ERD, Visio import/export. Но коммерческая лицензия дорогая, open source часть ограничена.

**Надёжность: 8/10 | Уверенность: 8/10**

---

### Drawflow, Flume, BaklavaJS, LiteGraph.js, jsPlumb

| Библиотека | Stars | React | TypeScript | Статус |
|---|---|---|---|---|
| Drawflow | 6,000 | Нет | Нет | Заброшен |
| LiteGraph.js | 7,800 | Нет (Canvas2D) | Нет | ComfyUI мигрирует на Vue |
| jsPlumb | 7,800 | Через Toolkit ($990) | Частично | Community заброшен |
| Flume | 1,500 | Да | Частично | Полу-заброшен |
| BaklavaJS | 1,500 | Нет (только Vue) | Да | Нишевый |

Все перечисленные **не подходят** для нашего проекта из-за отсутствия React-поддержки, TypeScript, или заброшенности.

---

## Сводная таблица

| Библиотека | Stars | npm/нед. | React | TS | Лицензия | Цена | Рекомендация |
|---|---|---|---|---|---|---|---|
| **@xyflow/react** | 35,500 | 4,900,000 | Нативный | Да | MIT | Free | ✅ **Выбор** |
| Rete.js | 11,900 | 42,700 | Плагин | Да | MIT | Free | Альтернатива |
| AntV X6 | 6,400 | 68,200 | Обёртка | Да | MIT | Free | Для Ant Design |
| JointJS | 5,200 | 51,900 | @joint/react | Да | MPL/Comm. | от $2,990 | Enterprise |
| Остальные | <8K | <15K | Нет/Частично | Нет | MIT | Free | Не подходят |

---

## Часть 2: Как AI-платформы реализуют workflow editors

### Кто какую библиотеку использует

| Платформа | Stars | Библиотека | Фреймворк |
|---|---|---|---|
| **n8n** | ~177K | Vue Flow (Vue-порт React Flow) | Vue 3 + Pinia |
| **Langflow** | ~130K | React Flow | React + FastAPI |
| **Dify** | ~119K | React Flow | Next.js + React 19 + Flask |
| **Flowise** | ~43K | React Flow | React + Express |
| **ComfyUI** | ~103K | LiteGraph.js → Vue (мигрирует) | Vue 3 + Pinia |
| **Rivet** | ~4.5K | Кастомный canvas | React + Tauri |
| **Promptflow** | ~11K | Кастомный DAG в VS Code | VS Code webview |
| **Haystack** | ~24K | Закрытый фронтенд | Python + hosted UI |

**React Flow используют 4 из 8 платформ** — де-факто стандарт.

---

### Лучшие UX-паттерны для заимствования

| Паттерн | Из платформы | Описание |
|---|---|---|
| **Relationships Panel** | Dify | Shift+click подсвечивает связи узла, затемняя остальное |
| **Real-time data flow** | Rivet | При execution видны данные, текущие через каждый wire |
| **Inline prompt editor** | Dify, Langflow | Редактирование промпта прямо в узле на канвасе |
| **AI Graph Creator** | Rivet | CMD+I — AI создает/редактирует граф по промпту |
| **Prompt optimization** | Dify | AI-ассистент автоматически оптимизирует промпт |
| **Auto-fix code** | Dify | Если Code-узел падает, AI генерирует исправление |
| **HITL checkpoint** | Flowise | Агент останавливается и запрашивает confirmation у человека |
| **Flow-as-subflow** | Flowise, Rivet | Flow вызывает другой flow как функцию |
| **YAML/JSON export** | Rivet, Promptflow | Графы как код = version control и diff |
| **Typed & colored ports** | ComfyUI, Dify | Цветовое кодирование портов по типу данных |
| **Playground/Chat** | Langflow, Dify | Встроенный чат для тестирования без деплоя |
| **Variable live tracking** | Dify | При debug-запуске видны значения переменных в каждом узле |

---

### Главный тренд 2025: Agent Node

Dify, Flowise, Langflow — все добавили **"Agent Node"** — узел, где LLM сам решает какие tools вызывать. Workflow перестаёт быть чисто детерминированным DAG-ом и включает LLM-driven branching.

---

### React Flow vs Custom Canvas — когда что

| Подход | Когда использовать | Пример |
|---|---|---|
| **React Flow** | <500 нод, нужна быстрая разработка, Rich UI | Dify, Langflow, Flowise |
| **Custom Canvas2D** | Тысячи нод, max performance | ComfyUI (но мигрирует на Vue!) |
| **Кастомный canvas** | Desktop app, полный контроль | Rivet (Tauri) |

ComfyUI мигрирует с Canvas2D на Vue-компоненты — показатель того, что **гибкость UI важнее raw performance**.

---

## Решение

**@xyflow/react (React Flow)** — единственный обоснованный выбор:

1. 4 из 8 крупнейших AI-платформ используют React Flow
2. ~5M загрузок/неделю, 35.5K stars, MIT лицензия
3. Нативный React, TypeScript, shadcn-совместимые компоненты
4. Кастомные ноды = обычные React-компоненты (идеально для нашего стека)
5. Отличная документация и активная команда

### Конкретный план интеграции

```bash
pnpm add @xyflow/react
```

Типы нод для нашего workflow editor:
- **AgentNode** — Claude Code агент (настройка модели, промпта, tools)
- **TeamNode** — группа агентов с ролями
- **TaskNode** — задача для агента
- **ConditionNode** — IF/ELSE ветвление
- **MCP ServerNode** — подключение MCP-сервера
- **SkillNode** — подключение skill/plugin
- **TriggerNode** — запуск workflow (cron, webhook, manual)
- **OutputNode** — результат (файл, PR, сообщение)

Sources:
- [xyflow/xyflow GitHub](https://github.com/xyflow/xyflow)
- [React Flow Components (shadcn)](https://xyflow.com/blog/react-flow-components)
- [React Flow Showcase](https://reactflow.dev/showcase)
- [Dify Workflow Source](https://github.com/langgenius/dify/blob/main/web/app/components/workflow/index.tsx)
- [n8n Canvas Architecture](https://deepwiki.com/n8n-io/n8n-docs/2.2-editor-ui)
- [Flowise Agentflow V2](https://docs.flowiseai.com/using-flowise/agentflowv2)
- [Rivet GitHub](https://github.com/Ironclad/rivet)
- [ComfyUI Nodes 2.0](https://docs.comfy.org/interface/nodes-2)
