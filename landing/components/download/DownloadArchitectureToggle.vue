<script setup lang="ts">
defineProps<{
  os: 'macos' | 'windows';
}>();

const downloadStore = useDownloadStore();
</script>

<template>
  <div class="download-architecture-toggle" :aria-label="`${os} architecture`">
    <template v-if="os === 'macos'">
      <button
        type="button"
        class="download-architecture-toggle__option"
        :class="{ 'download-architecture-toggle__option--active': downloadStore.macArch === 'arm64' }"
        :aria-pressed="downloadStore.macArch === 'arm64'"
        @click.stop="downloadStore.setMacArch('arm64')"
      >
        Apple Silicon
      </button>
      <button
        type="button"
        class="download-architecture-toggle__option"
        :class="{ 'download-architecture-toggle__option--active': downloadStore.macArch === 'x64' }"
        :aria-pressed="downloadStore.macArch === 'x64'"
        @click.stop="downloadStore.setMacArch('x64')"
      >
        Intel
      </button>
    </template>
    <template v-else>
      <button
        type="button"
        class="download-architecture-toggle__option"
        :class="{ 'download-architecture-toggle__option--active': downloadStore.windowsArch === 'x64' }"
        :aria-pressed="downloadStore.windowsArch === 'x64'"
        @click.stop="downloadStore.setWindowsArch('x64')"
      >
        64-bit
      </button>
      <button
        type="button"
        class="download-architecture-toggle__option"
        :class="{ 'download-architecture-toggle__option--active': downloadStore.windowsArch === 'arm64' }"
        :aria-pressed="downloadStore.windowsArch === 'arm64'"
        @click.stop="downloadStore.setWindowsArch('arm64')"
      >
        ARM64
      </button>
    </template>
  </div>
</template>

<style scoped>
.download-architecture-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 10px;
  padding: 3px;
  max-width: 100%;
  border: 1px solid rgba(0, 240, 255, 0.14);
  border-radius: 10px;
  background: rgba(0, 240, 255, 0.05);
}

.download-architecture-toggle__option {
  min-width: 0;
  padding: 5px 8px;
  border: 0;
  border-radius: 7px;
  color: #8892b0;
  background: transparent;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.62rem;
  font-weight: 700;
  line-height: 1.15;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease;
}

.download-architecture-toggle__option:hover,
.download-architecture-toggle__option--active {
  color: #0a0a0f;
  background: linear-gradient(135deg, #00f0ff, #39ff14);
  box-shadow: 0 4px 14px rgba(0, 240, 255, 0.22);
}

:global(.v-theme--light) .download-architecture-toggle {
  border-color: rgba(8, 145, 178, 0.16);
  background: rgba(8, 145, 178, 0.06);
}

:global(.v-theme--light) .download-architecture-toggle__option {
  color: #64748b;
}

:global(.v-theme--light) .download-architecture-toggle__option:hover,
:global(.v-theme--light) .download-architecture-toggle__option--active {
  color: #f8fbff;
  text-shadow: 0 1px 8px rgba(15, 23, 42, 0.22);
}

@media (max-width: 960px) {
  .download-architecture-toggle {
    width: fit-content;
  }
}

@media (max-width: 600px) {
  .download-architecture-toggle {
    width: 100%;
  }

  .download-architecture-toggle__option {
    flex: 1;
    padding-inline: 6px;
  }
}
</style>
