<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { mdiRobotOutline, mdiCheckCircleOutline, mdiCodeBraces, mdiMessageTextOutline } from '@mdi/js';

const { t } = useI18n();

// ─── State machine for demo cycle ───
type DemoState = 'idle' | 'working' | 'reviewing' | 'done';
const state = ref<DemoState>('idle');

// ─── Animated task text ───
const currentTask = ref('');
const taskFading = ref(false);
const taskMessages = computed(() => [
  t('hero.demo.activity.authMiddleware'),
  t('hero.demo.activity.unitTests'),
  t('hero.demo.activity.reviewPr'),
  t('hero.demo.activity.ciPipeline'),
  t('hero.demo.activity.refactorDatabase'),
]);
let taskIndex = 0;
let charTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Agent activity indicators ───
const agents = ref([
  { name: 'Lead', color: '#00f0ff', status: 'idle' as string, icon: mdiRobotOutline },
  { name: 'Dev-1', color: '#ff00ff', status: 'idle' as string, icon: mdiCodeBraces },
  { name: 'Dev-2', color: '#39ff14', status: 'idle' as string, icon: mdiMessageTextOutline },
]);

// ─── Kanban mini-board ───
const kanbanTasks = ref([
  { id: 1, text: t('hero.demo.tasks.authApi'), col: 'todo' as string },
  { id: 2, text: t('hero.demo.tasks.unitTests'), col: 'todo' as string },
  { id: 3, text: t('hero.demo.tasks.ciSetup'), col: 'todo' as string },
]);

function typeNextChar(text: string, index: number) {
  if (index >= text.length) { charTimer = null; return; }
  currentTask.value = text.slice(0, index + 1);
  const ch = text[index];
  let delay = 30;
  if (ch === '.' || ch === ',') delay = 100;
  else if (ch === ' ') delay = 10;
  charTimer = setTimeout(() => typeNextChar(text, index + 1), delay);
}

function stopTextAnimation() {
  if (charTimer) { clearTimeout(charTimer); charTimer = null; }
}

// ─── Timer management ───
const timers: number[] = [];
function safeTimeout(fn: () => void, ms: number) {
  const id = window.setTimeout(fn, ms);
  timers.push(id);
  return id;
}
function clearAllTimers() {
  timers.forEach(clearTimeout);
  timers.length = 0;
  stopTextAnimation();
}

// ─── IntersectionObserver ───
const containerRef = ref<HTMLElement | null>(null);
const isVisible = ref(false);
let intObserver: IntersectionObserver | null = null;

// ─── Demo cycle ───
let cycleRunning = false;

function runCycle() {
  if (!cycleRunning) return;

  // Reset
  state.value = 'idle';
  currentTask.value = '';
  taskFading.value = false;
  kanbanTasks.value = [
    { id: 1, text: t('hero.demo.tasks.authApi'), col: 'todo' },
    { id: 2, text: t('hero.demo.tasks.unitTests'), col: 'todo' },
    { id: 3, text: t('hero.demo.tasks.ciSetup'), col: 'todo' },
  ];
  agents.value.forEach(a => a.status = 'idle');

  safeTimeout(() => {
    if (!cycleRunning) return;

    // Phase 1: Working
    state.value = 'working';
    agents.value[0].status = 'active';
    agents.value[1].status = 'active';
    kanbanTasks.value[0].col = 'progress';

    const messages = taskMessages.value;
    const task = messages[taskIndex % messages.length];
    taskIndex++;
    typeNextChar(task, 0);

    safeTimeout(() => {
      if (!cycleRunning) return;
      kanbanTasks.value[1].col = 'progress';
      agents.value[2].status = 'active';
    }, 1200);

    safeTimeout(() => {
      if (!cycleRunning) return;

      // Phase 2: Reviewing
      state.value = 'reviewing';
      kanbanTasks.value[0].col = 'review';
      agents.value[0].status = 'reviewing';

      safeTimeout(() => {
        if (!cycleRunning) return;

        // Phase 3: Done
        state.value = 'done';
        kanbanTasks.value[0].col = 'done';
        kanbanTasks.value[1].col = 'review';
        agents.value[0].status = 'done';
        agents.value[1].status = 'reviewing';

        safeTimeout(() => {
          if (!cycleRunning) return;
          kanbanTasks.value[1].col = 'done';
          kanbanTasks.value[2].col = 'progress';
          agents.value[1].status = 'done';

          safeTimeout(() => {
            taskFading.value = true;
            safeTimeout(() => {
              if (cycleRunning) runCycle();
            }, 800);
          }, 2000);
        }, 1500);
      }, 1500);
    }, 2500);
  }, 1500);
}

function startDemo() {
  if (cycleRunning) return;
  cycleRunning = true;
  runCycle();
}

function stopDemo() {
  cycleRunning = false;
  clearAllTimers();
  state.value = 'idle';
  currentTask.value = '';
  taskFading.value = false;
}

watch(isVisible, (visible) => {
  if (visible) startDemo();
  else stopDemo();
});

onMounted(() => {
  intObserver = new IntersectionObserver(
    ([entry]) => { isVisible.value = entry.isIntersecting; },
    { threshold: 0.1 },
  );
  if (containerRef.value) intObserver.observe(containerRef.value);
});

onUnmounted(() => {
  stopDemo();
  if (intObserver) { intObserver.disconnect(); intObserver = null; }
});

function colColor(col: string) {
  switch (col) {
    case 'todo': return '#64748b';
    case 'progress': return '#00f0ff';
    case 'review': return '#ffd700';
    case 'done': return '#39ff14';
    default: return '#64748b';
  }
}

function colLabel(col: string) {
  switch (col) {
    case 'todo': return t('hero.demo.columns.todo');
    case 'progress': return t('hero.demo.columns.progress');
    case 'review': return t('hero.demo.columns.review');
    case 'done': return t('hero.demo.columns.done');
    default: return col.toUpperCase();
  }
}

function statusDotColor(status: string) {
  switch (status) {
    case 'active': return '#00f0ff';
    case 'reviewing': return '#ffd700';
    case 'done': return '#39ff14';
    default: return '#64748b';
  }
}
</script>

<template>
  <div ref="containerRef" class="hero-demo" role="img" :aria-label="t('hero.demo.ariaLabel')">
    <div class="hero-demo__content">
      <!-- Header -->
      <div class="hero-demo__header">
        <div class="hero-demo__title-row">
          <span class="hero-demo__title">Agent Teams</span>
          <span class="hero-demo__badge-live">
            <span class="hero-demo__live-dot" />
            {{ t('hero.demo.live') }}
          </span>
        </div>
      </div>

      <!-- Agents row -->
      <div class="hero-demo__agents">
        <div
          v-for="agent in agents"
          :key="agent.name"
          class="hero-demo__agent"
        >
          <div class="hero-demo__agent-avatar" :style="{ borderColor: agent.color }">
            <v-icon :icon="agent.icon" size="16" :style="{ color: agent.color }" />
          </div>
          <span class="hero-demo__agent-name">{{ agent.name }}</span>
          <span
            class="hero-demo__agent-dot"
            :style="{ background: statusDotColor(agent.status) }"
          />
        </div>
      </div>

      <!-- Mini kanban -->
      <div class="hero-demo__kanban">
        <div v-for="col in ['todo', 'progress', 'review', 'done']" :key="col" class="hero-demo__kanban-col">
          <div class="hero-demo__kanban-label" :style="{ color: colColor(col) }">
            {{ colLabel(col) }}
          </div>
          <div class="hero-demo__kanban-cards">
            <TransitionGroup name="kanban-card">
              <div
                v-for="task in kanbanTasks.filter(t => t.col === col)"
                :key="task.id"
                class="hero-demo__kanban-card"
                :style="{ borderLeftColor: colColor(col) }"
              >
                {{ task.text }}
              </div>
            </TransitionGroup>
          </div>
        </div>
      </div>

      <!-- Activity log -->
      <div class="hero-demo__log">
        <div class="hero-demo__log-line">
          <v-icon :icon="mdiCheckCircleOutline" size="14" style="color: #39ff14; flex-shrink: 0" />
          <span
            class="hero-demo__log-text"
            :class="{ 'hero-demo__log-text--fading': taskFading }"
          >{{ currentTask || t('hero.demo.waiting') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero-demo {
  position: relative;
  z-index: 1;
  border-radius: 16px;
  background: rgba(10, 10, 15, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 240, 255, 0.15);
  overflow: hidden;
  min-height: 330px;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 0 30px rgba(0, 240, 255, 0.05),
    inset 0 1px 0 rgba(0, 240, 255, 0.1);
}

.hero-demo__content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  padding: 16px;
  min-height: 330px;
  gap: 12px;
}

/* ─── Header ─── */
.hero-demo__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.hero-demo__title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  justify-content: space-between;
}

.hero-demo__title {
  font-size: 15px;
  font-weight: 700;
  color: #e0e6ff;
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.05em;
}

.hero-demo__badge-live {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 100px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #39ff14;
  background: rgba(57, 255, 20, 0.1);
  border: 1px solid rgba(57, 255, 20, 0.2);
}

.hero-demo__live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #39ff14;
  animation: livePulse 2s ease-in-out infinite;
}

@keyframes livePulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 4px rgba(57, 255, 20, 0.6); }
  50% { opacity: 0.4; box-shadow: none; }
}

/* ─── Agents ─── */
.hero-demo__agents {
  display: flex;
  gap: 12px;
}

.hero-demo__agent {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  flex: 1;
}

.hero-demo__agent-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1.5px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  flex-shrink: 0;
}

.hero-demo__agent-name {
  font-size: 11px;
  color: #a0a8c0;
  font-weight: 600;
  font-family: "JetBrains Mono", monospace;
}

.hero-demo__agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-left: auto;
  transition: background 0.3s ease;
  flex-shrink: 0;
}

/* ─── Kanban ─── */
.hero-demo__kanban {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  flex: 1;
}

.hero-demo__kanban-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hero-demo__kanban-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 4px 0;
  font-family: "JetBrains Mono", monospace;
  opacity: 0.7;
}

.hero-demo__kanban-cards {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 60px;
}

.hero-demo__kanban-card {
  font-size: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  border-left: 2px solid;
  color: #c8d6e5;
  transition: all 0.4s ease;
  font-family: "JetBrains Mono", monospace;
}

/* Card transition */
.kanban-card-enter-active,
.kanban-card-leave-active {
  transition: all 0.4s ease;
}

.kanban-card-enter-from {
  opacity: 0;
  transform: translateX(-8px);
}

.kanban-card-leave-to {
  opacity: 0;
  transform: translateX(8px);
}

/* ─── Log ─── */
.hero-demo__log {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(0, 240, 255, 0.08);
}

.hero-demo__log-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hero-demo__log-text {
  font-size: 12px;
  color: #a0a8c0;
  font-family: "JetBrains Mono", monospace;
  transition: opacity 0.5s ease;
}

.hero-demo__log-text--fading {
  opacity: 0;
}

/* ─── Responsive ─── */
@media (max-width: 960px) {
  .hero-demo {
    max-width: 460px;
    margin: 0 auto;
  }
}

@media (max-width: 600px) {
  .hero-demo {
    border-radius: 12px;
    min-height: 280px;
  }

  .hero-demo__content {
    padding: 12px;
    min-height: 280px;
    gap: 8px;
  }

  .hero-demo__title {
    font-size: 13px;
  }

  .hero-demo__agents {
    gap: 6px;
  }

  .hero-demo__agent {
    padding: 4px 6px;
  }

  .hero-demo__agent-name {
    font-size: 9px;
  }

  .hero-demo__kanban-label {
    font-size: 8px;
  }

  .hero-demo__kanban-card {
    font-size: 9px;
    padding: 4px 6px;
  }

  .hero-demo__log-text {
    font-size: 10px;
  }
}
</style>
