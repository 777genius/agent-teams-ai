<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed } from "vue";

const props = withDefaults(defineProps<{ type?: "start" | "reference" }>(), {
  type: "start"
});

type CardText = { title: string; desc: string; icon?: string; link?: string };

// Locales that have their own translated card copy. Anything else falls back to English (root).
const KNOWN_LOCALES = ["ru", "zh", "es", "ja", "fr", "de"] as const;

// Links and icons are shared across locales; only the path prefix changes per locale.
const START_LINKS = ["/guide/quickstart", "/guide/installation", "/guide/create-team", "/guide/code-review"];
const START_ICONS = ["01", "02", "03", "04"];
const REFERENCE_LINKS = [
  "/reference/concepts",
  "/reference/providers-runtimes",
  "/reference/contributor-architecture",
  "/reference/privacy-local-data",
  "/reference/faq"
];
const REFERENCE_ICONS = ["◈", "⌁", "▦", "⌘", "?"];

const CARD_TEXT: Record<string, { start: CardText[]; reference: CardText[] }> = {
  "": {
    start: [
      { icon: "01", title: "Beginner workflow", desc: "Understand the first run from project to approval.", link: "/guide/beginner-workflow" },
      { icon: "02", title: "Quickstart", desc: "Install the app and validate the base launch.", link: "/guide/quickstart" },
      { icon: "03", title: "First team", desc: "Lead, builder, reviewer, roles, models, and Worktree.", link: "/guide/create-first-team" },
      { icon: "04", title: "Run work", desc: "Lead brief, task board, comments, and monitoring.", link: "/guide/run-and-monitor-work" },
      { icon: "05", title: "Review and approve", desc: "Task detail, logs, diff, and hunk-level decisions.", link: "/guide/review-and-approve" },
      { icon: "06", title: "Runtime setup", desc: "Claude, Codex, OpenCode, and multimodel setup.", link: "/guide/runtime-setup" }
    ],
    reference: [
      { title: "Concepts", desc: "Teams, tasks, roles, and autonomy levels." },
      { title: "Runtimes", desc: "Claude, Codex, OpenCode, and multimodel mode." },
      { title: "Architecture", desc: "Feature layout, guardrails, and runtime/provider boundaries." },
      { title: "Local data", desc: "What stays on disk and what providers receive." },
      { title: "FAQ", desc: "Short answers to common questions." }
    ]
  },
  ru: {
    start: [
      { icon: "01", title: "Путь новичка", desc: "Понять весь первый запуск от проекта до approval.", link: "/ru/guide/beginner-workflow" },
      { icon: "02", title: "Быстрый старт", desc: "Поставить приложение и проверить базовый запуск.", link: "/ru/guide/quickstart" },
      { icon: "03", title: "Первая команда", desc: "Lead, builder, reviewer, роли, модели и Worktree.", link: "/ru/guide/create-first-team" },
      { icon: "04", title: "Запуск работы", desc: "Brief для lead, task board, comments и monitoring.", link: "/ru/guide/run-and-monitor-work" },
      { icon: "05", title: "Review и approval", desc: "Task detail, logs, diff и hunk-level decisions.", link: "/ru/guide/review-and-approve" },
      { icon: "06", title: "Рантаймы", desc: "Claude, Codex, OpenCode и multimodel setup.", link: "/ru/guide/runtime-setup" }
    ],
    reference: [
      { title: "Концепции", desc: "Команды, задачи, роли и уровни автономности." },
      { title: "Рантаймы", desc: "Claude, Codex, OpenCode и multimodel-режим." },
      { title: "Архитектура", desc: "Feature layout, guardrails и границы runtime/provider." },
      { title: "Локальные данные", desc: "Что хранится на машине и что уходит провайдерам." },
      { title: "FAQ", desc: "Короткие ответы на частые вопросы." }
    ]
  },
  zh: {
    start: [
      { title: "快速开始", desc: "安装应用并创建你的第一个团队。" },
      { title: "安装", desc: "平台、发布版本以及从源码运行。" },
      { title: "创建团队", desc: "角色、lead prompt 与任务边界。" },
      { title: "代码审查", desc: "以代码块（hunk）级别的决策审查任务变更。" }
    ],
    reference: [
      { title: "概念", desc: "团队、任务、角色与自主级别。" },
      { title: "运行时", desc: "Claude、Codex、OpenCode 与多模型模式。" },
      { title: "架构", desc: "功能布局、护栏以及运行时/提供方边界。" },
      { title: "本地数据", desc: "哪些数据留在磁盘上，哪些会发送给提供方。" },
      { title: "常见问题", desc: "对常见问题的简短解答。" }
    ]
  },
  es: {
    start: [
      { title: "Inicio rápido", desc: "Instala la aplicación y crea tu primer equipo." },
      { title: "Instalación", desc: "Plataformas, versiones y ejecución desde el código fuente." },
      { title: "Crear un equipo", desc: "Roles, prompt del lead y límites de las tareas." },
      { title: "Revisión de código", desc: "Revisa los cambios de las tareas con decisiones a nivel de hunk." }
    ],
    reference: [
      { title: "Conceptos", desc: "Equipos, tareas, roles y niveles de autonomía." },
      { title: "Runtimes", desc: "Claude, Codex, OpenCode y modo multimodelo." },
      { title: "Arquitectura", desc: "Estructura de las funciones, guardrails y límites entre runtime y proveedor." },
      { title: "Datos locales", desc: "Qué permanece en el disco y qué reciben los proveedores." },
      { title: "Preguntas frecuentes", desc: "Respuestas breves a preguntas habituales." }
    ]
  },
  ja: {
    start: [
      { title: "クイックスタート", desc: "アプリをインストールして、最初のチームを作成します。" },
      { title: "インストール", desc: "対応プラットフォーム、リリース、ソースからの実行について。" },
      { title: "チームの作成", desc: "ロール、リードプロンプト、タスクの範囲について。" },
      { title: "コードレビュー", desc: "ハンク単位の判断でタスクの変更をレビューします。" }
    ],
    reference: [
      { title: "コンセプト", desc: "チーム、タスク、ロール、自律性のレベルについて。" },
      { title: "ランタイム", desc: "Claude、Codex、OpenCode、およびマルチモデルモードについて。" },
      { title: "アーキテクチャ", desc: "機能の構成、ガードレール、ランタイム/プロバイダーの境界について。" },
      { title: "ローカルデータ", desc: "ディスクに保持されるものと、プロバイダーに送信されるものについて。" },
      { title: "FAQ", desc: "よくある質問への簡潔な回答。" }
    ]
  },
  fr: {
    start: [
      { title: "Démarrage rapide", desc: "Installez l'application et créez votre première équipe." },
      { title: "Installation", desc: "Plateformes, versions et exécution depuis les sources." },
      { title: "Créer une équipe", desc: "Rôles, prompt du lead et périmètre des tâches." },
      { title: "Revue de code", desc: "Examinez les modifications de tâches avec des décisions au niveau du hunk." }
    ],
    reference: [
      { title: "Concepts", desc: "Équipes, tâches, rôles et niveaux d'autonomie." },
      { title: "Runtimes", desc: "Claude, Codex, OpenCode et mode multimodèle." },
      { title: "Architecture", desc: "Organisation des fonctionnalités, garde-fous et frontières runtime/fournisseur." },
      { title: "Données locales", desc: "Ce qui reste sur le disque et ce que reçoivent les fournisseurs." },
      { title: "FAQ", desc: "Réponses brèves aux questions fréquentes." }
    ]
  },
  de: {
    start: [
      { title: "Schnellstart", desc: "Installieren Sie die App und erstellen Sie Ihr erstes Team." },
      { title: "Installation", desc: "Plattformen, Releases und Ausführen aus dem Quellcode." },
      { title: "Team erstellen", desc: "Rollen, Lead-Prompt und Aufgabengrenzen." },
      { title: "Code-Review", desc: "Aufgabenänderungen mit Entscheidungen auf Hunk-Ebene überprüfen." }
    ],
    reference: [
      { title: "Konzepte", desc: "Teams, Aufgaben, Rollen und Autonomiestufen." },
      { title: "Runtimes", desc: "Claude, Codex, OpenCode und Multimodell-Modus." },
      { title: "Architektur", desc: "Feature-Aufbau, Guardrails und Grenzen zwischen Runtime und Anbieter." },
      { title: "Lokale Daten", desc: "Was auf dem Datenträger bleibt und was die Anbieter erhalten." },
      { title: "FAQ", desc: "Kurze Antworten auf häufige Fragen." }
    ]
  }
};

const { page } = useData();

const locale = computed(() => {
  const segment = page.value.relativePath.split("/")[0];
  return (KNOWN_LOCALES as readonly string[]).includes(segment) ? segment : "";
});

const cards = computed(() => {
  const text = CARD_TEXT[locale.value] ?? CARD_TEXT[""];
  const isReference = props.type === "reference";
  const entries = isReference ? text.reference : text.start;
  const links = isReference ? REFERENCE_LINKS : START_LINKS;
  const icons = isReference ? REFERENCE_ICONS : START_ICONS;
  const prefix = locale.value ? `/${locale.value}` : "";

  return entries.map((entry, index) => ({
    icon: entry.icon ?? icons[index] ?? String(index + 1).padStart(2, "0"),
    title: entry.title,
    desc: entry.desc,
    link: entry.link ?? `${prefix}${links[index]}`
  }));
});
</script>

<template>
  <div class="docs-card-grid">
    <a v-for="card in cards" :key="card.link" class="docs-card" :href="withBase(card.link)">
      <span class="docs-card__icon">{{ card.icon }}</span>
      <strong>{{ card.title }}</strong>
      <span>{{ card.desc }}</span>
      <span class="docs-card__arrow" aria-hidden="true">→</span>
    </a>
  </div>
</template>

<style scoped>
.docs-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin: 24px 0;
}

.docs-card {
  position: relative;
  overflow: hidden;
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 12px;
  row-gap: 4px;
  padding: 18px;
  border: var(--at-glass-border);
  border-radius: var(--at-radius-xl);
  background: var(--at-c-surface-soft);
  color: var(--at-c-text);
  text-decoration: none !important;
  box-shadow: var(--at-shadow-card);
  transition:
    border-color var(--at-transition-base),
    background-color var(--at-transition-base),
    transform var(--at-transition-base),
    box-shadow var(--at-transition-base);
}

.docs-card:hover {
  border-color: var(--at-c-border-strong);
  background: var(--at-glass-bg-hover);
  transform: translateY(-3px);
  box-shadow: var(--at-shadow-cyan-md);
}

.docs-card__icon {
  grid-row: 1 / -1;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--at-radius-md);
  background: var(--at-gradient-panel);
  color: var(--at-c-cyan);
  font-family: var(--at-font-mono);
  font-size: 13px;
  border: 1px solid rgba(0, 240, 255, 0.14);
}

.docs-card strong {
  color: var(--at-c-text);
  font-size: 15px;
  line-height: 1.3;
}

.docs-card > span:nth-of-type(2) {
  color: var(--at-c-text-muted);
  font-size: 13px;
  line-height: 1.45;
}

.docs-card__arrow {
  grid-column: 3;
  align-self: end;
  color: var(--at-c-cyan);
  font-family: var(--at-font-mono);
  font-size: 16px;
  opacity: 0.55;
  transform: translateX(-4px);
  transition:
    opacity var(--at-transition-base),
    transform var(--at-transition-base);
}

.docs-card:hover .docs-card__arrow {
  opacity: 1;
  transform: translateX(0);
}

@media (max-width: 640px) {
  .docs-card-grid {
    grid-template-columns: 1fr;
  }

  .docs-card {
    grid-template-columns: auto 1fr;
  }

  .docs-card__arrow {
    display: none;
  }
}
</style>
