<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed } from "vue";

const props = withDefaults(defineProps<{ type?: "start" | "reference" }>(), {
  type: "start"
});

const { page } = useData();
const isRu = computed(() => page.value.relativePath.startsWith("ru/"));

const cards = computed(() => {
  if (isRu.value) {
    return props.type === "reference"
      ? [
          { icon: "◈", title: "Концепции", desc: "Команды, задачи, роли и уровни автономности.", link: "/ru/reference/concepts" },
          { icon: "⌁", title: "Рантаймы", desc: "Claude, Codex, OpenCode и multimodel-режим.", link: "/ru/reference/providers-runtimes" },
          { icon: "▦", title: "Архитектура", desc: "Feature layout, guardrails и границы runtime/provider.", link: "/ru/reference/contributor-architecture" },
          { icon: "⌘", title: "Локальные данные", desc: "Что хранится на машине и что уходит провайдерам.", link: "/ru/reference/privacy-local-data" },
          { icon: "?", title: "FAQ", desc: "Короткие ответы на частые вопросы.", link: "/ru/reference/faq" }
        ]
      : [
          { icon: "01", title: "Быстрый старт", desc: "Поставить приложение и создать первую команду.", link: "/ru/guide/quickstart" },
          { icon: "02", title: "Установка", desc: "Платформы, релизы и запуск из исходников.", link: "/ru/guide/installation" },
          { icon: "03", title: "Создание команды", desc: "Роли, lead prompt и границы работы.", link: "/ru/guide/create-team" },
          { icon: "04", title: "Код-ревью", desc: "Проверка изменений по задачам и hunk-level decisions.", link: "/ru/guide/code-review" }
        ];
  }

  return props.type === "reference"
    ? [
        { icon: "◈", title: "Concepts", desc: "Teams, tasks, roles, and autonomy levels.", link: "/reference/concepts" },
        { icon: "⌁", title: "Runtimes", desc: "Claude, Codex, OpenCode, and multimodel mode.", link: "/reference/providers-runtimes" },
        { icon: "▦", title: "Architecture", desc: "Feature layout, guardrails, and runtime/provider boundaries.", link: "/reference/contributor-architecture" },
        { icon: "⌘", title: "Local data", desc: "What stays on disk and what providers receive.", link: "/reference/privacy-local-data" },
        { icon: "?", title: "FAQ", desc: "Short answers to common questions.", link: "/reference/faq" }
      ]
    : [
        { icon: "01", title: "Quickstart", desc: "Install the app and create your first team.", link: "/guide/quickstart" },
        { icon: "02", title: "Installation", desc: "Platforms, releases, and running from source.", link: "/guide/installation" },
        { icon: "03", title: "Create a team", desc: "Roles, lead prompt, and task boundaries.", link: "/guide/create-team" },
        { icon: "04", title: "Code review", desc: "Review task changes with hunk-level decisions.", link: "/guide/code-review" }
      ];
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
