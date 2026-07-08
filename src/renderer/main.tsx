import './index.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { registerDynamicImportRecovery } from './utils/dynamicImportRecovery';
import { App } from './App';
import { initSentryRenderer } from './sentry';
import { initializeNotificationListeners } from './store';
import { bootstrapRendererTelemetryFromConfig } from './telemetry';

import type { SplashSceneHandle } from './components/splash/splashScene';
import type { AppStartupStatus, AppStartupStep } from '@shared/types/api';

declare global {
  interface Window {
    __claudeTeamsUiDidInit?: boolean;
    __claudeTeamsUiCleanup?: () => void;
    __claudeTeamsSplashStaticTimer?: number;
    __claudeTeamsSplashScene?: SplashSceneHandle;
    __claudeTeamsSplashEnhancedDisabled?: boolean;
  }
}

// Prepare Sentry before React renders. Actual init waits for telemetry config.
initSentryRenderer();
void bootstrapRendererTelemetryFromConfig();
registerDynamicImportRecovery();

let root: ReactDOM.Root | null = null;
let latestStartupStatus: AppStartupStatus | null = null;
let startupTicker: number | undefined;

const SLOW_STEP_MS = 7_000;
const VERY_SLOW_STEP_MS = 14_000;
const TIMELINE_STEP_LIMIT = 3;

function getStartupErrorText(status: AppStartupStatus): string {
  return status.error ? `Startup failed: ${status.error}` : 'Startup failed. Please restart.';
}

function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
}

function getCurrentStartupStep(status: AppStartupStatus): AppStartupStep | null {
  const steps = status.steps ?? [];
  const active = [...steps].reverse().find((step) => !step.finishedAt);
  return active ?? steps[steps.length - 1] ?? null;
}

function getStepElapsedMs(step: AppStartupStep | null, status: AppStartupStatus): number {
  if (!step) {
    return Date.now() - status.startedAt;
  }
  return step.finishedAt ? step.finishedAt - step.startedAt : Date.now() - step.startedAt;
}

function getSlowStepHint(step: AppStartupStep | null, elapsedMs: number): string {
  if (!step || step.finishedAt || elapsedMs < SLOW_STEP_MS) {
    return '';
  }

  const phase = step.phase;
  if (phase.includes('shell-env-login') || phase.includes('shell-env-interactive')) {
    return elapsedMs >= VERY_SLOW_STEP_MS
      ? 'Shell startup is still running. Slow shell profile scripts can delay first launch.'
      : 'Reading your shell PATH. This can take a few seconds on first launch.';
  }
  if (phase.includes('node-runtime')) {
    return 'Checking Node.js for the local MCP server. This can wait up to 5 seconds.';
  }
  if (phase.includes('packaged-server-copy')) {
    return 'Preparing the packaged MCP server copy. This should only happen after updates.';
  }
  if (phase.includes('path') || phase.includes('standard-locations') || phase.includes('nvm')) {
    return 'Searching local runtime paths. A large PATH or slow disk can make this step longer.';
  }
  if (phase.includes('doctor')) {
    return 'Using diagnostics fallback to locate the runtime.';
  }
  if (phase.includes('settings')) {
    return 'Loading encrypted local settings.';
  }

  return 'Still working on this startup step.';
}

function renderStartupTimeline(status: AppStartupStatus): void {
  const timeline = document.getElementById('splash-timeline');
  if (!timeline) return;

  if (!status.error) {
    timeline.replaceChildren();
    return;
  }

  const steps = (status.steps ?? []).slice(-TIMELINE_STEP_LIMIT);
  timeline.replaceChildren();

  for (const step of steps) {
    const row = document.createElement('div');
    const isCurrent = !step.finishedAt && !status.ready && !status.error;
    row.className = `splash-step${isCurrent ? ' is-current' : ''}`;

    const dot = document.createElement('div');
    dot.className = 'splash-step-dot';

    const label = document.createElement('div');
    label.className = 'splash-step-label';
    label.textContent = step.message;
    label.title = step.message;

    const time = document.createElement('div');
    time.className = 'splash-step-time';
    const elapsed = formatDuration(getStepElapsedMs(step, status));
    time.textContent = step.finishedAt ? `took ${elapsed}` : `running ${elapsed}`;

    row.append(dot, label, time);
    timeline.append(row);
  }
}

function updateStartupSplash(status: AppStartupStatus): void {
  const splash = document.getElementById('splash');
  const statusElement = document.getElementById('splash-status');
  const elapsedElement = document.getElementById('splash-elapsed');
  const hintElement = document.getElementById('splash-hint');
  if (!splash || !statusElement) return;

  latestStartupStatus = status;
  const currentStep = getCurrentStartupStep(status);
  const elapsedMs = getStepElapsedMs(currentStep, status);
  const hint = getSlowStepHint(currentStep, elapsedMs);

  splash.classList.toggle('splash-status-error', Boolean(status.error) && !status.ready);
  splash.classList.toggle('splash-status-slow', Boolean(hint) && !status.error && !status.ready);
  statusElement.textContent =
    status.error && !status.ready
      ? getStartupErrorText(status)
      : (currentStep?.message ?? status.message);
  if (elapsedElement) {
    elapsedElement.textContent = formatDuration(elapsedMs);
  }
  if (hintElement) {
    hintElement.textContent = status.error || status.ready ? '' : hint;
  }
  renderStartupTimeline(status);
}

function stopStaticSplashTimer(): void {
  if (window.__claudeTeamsSplashStaticTimer === undefined) return;
  window.clearInterval(window.__claudeTeamsSplashStaticTimer);
  window.__claudeTeamsSplashStaticTimer = undefined;
}

function startStartupTicker(): void {
  if (startupTicker !== undefined) return;
  startupTicker = window.setInterval(() => {
    if (latestStartupStatus) {
      updateStartupSplash(latestStartupStatus);
    }
  }, 1000);
}

function stopStartupTicker(): void {
  if (startupTicker === undefined) return;
  window.clearInterval(startupTicker);
  startupTicker = undefined;
}

function stopEnhancedSplashScene(): void {
  window.__claudeTeamsSplashEnhancedDisabled = true;
  window.__claudeTeamsSplashScene?.stop();
}

function mountApp(): void {
  if (root) return;

  // React 18 StrictMode intentionally mounts/unmounts effects twice in dev,
  // which can start duplicate IPC init chains. Make initialization a one-time
  // module-level side effect guarded by a global flag.
  if (!window.__claudeTeamsUiDidInit) {
    window.__claudeTeamsUiDidInit = true;
    // Keep the cleanup reachable for hot module reload / shutdown paths.
    window.__claudeTeamsUiCleanup = initializeNotificationListeners();
  }

  root = ReactDOM.createRoot(document.getElementById('root')!);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

async function bootstrapRenderer(): Promise<void> {
  const startupApi = window.electronAPI?.startup;
  if (!startupApi) {
    mountApp();
    return;
  }

  let cleanup = (): void => undefined;
  try {
    let finished = false;
    const handleStartupStatus = (nextStatus: AppStartupStatus): void => {
      if (finished) {
        return;
      }
      updateStartupSplash(nextStatus);
      const currentStep = getCurrentStartupStep(nextStatus);
      const stepElapsedMs = getStepElapsedMs(currentStep, nextStatus);
      if (!nextStatus.ready && (nextStatus.error || stepElapsedMs >= VERY_SLOW_STEP_MS)) {
        stopEnhancedSplashScene();
      }
      if (nextStatus.ready) {
        finished = true;
        cleanup();
        stopStaticSplashTimer();
        stopStartupTicker();
        mountApp();
      } else if (nextStatus.error) {
        finished = true;
        cleanup();
        stopStaticSplashTimer();
        stopStartupTicker();
      } else {
        stopStaticSplashTimer();
        startStartupTicker();
      }
    };

    cleanup = startupApi.onProgress(handleStartupStatus);
    handleStartupStatus(await startupApi.getStatus());
  } catch (error) {
    console.warn(`[startup] status bridge unavailable: ${String(error)}`);
    cleanup();
    stopStaticSplashTimer();
    stopStartupTicker();
    mountApp();
  }
}

void bootstrapRenderer();
