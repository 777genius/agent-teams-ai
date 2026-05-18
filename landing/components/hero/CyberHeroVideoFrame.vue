<template>
  <div
    id="hero-demo"
    class="cyber-video-frame"
    role="region"
    aria-label="Watch Agent Teams demo"
  >
    <div class="cyber-video-frame__bezel" aria-hidden="true" />
    <div class="cyber-video-frame__status" aria-hidden="true">
      <span>Team command feed</span>
      <span>Live demo</span>
    </div>
    <div class="cyber-video-frame__content">
      <ClientOnly>
        <Suspense>
          <LazyHeroDemoVideo />
          <template #fallback>
            <div class="cyber-video-frame__fallback" />
          </template>
        </Suspense>
        <template #fallback>
          <div class="cyber-video-frame__fallback" />
        </template>
      </ClientOnly>
    </div>
    <div class="cyber-video-frame__corner cyber-video-frame__corner--tl" aria-hidden="true" />
    <div class="cyber-video-frame__corner cyber-video-frame__corner--tr" aria-hidden="true" />
    <div class="cyber-video-frame__corner cyber-video-frame__corner--bl" aria-hidden="true" />
    <div class="cyber-video-frame__corner cyber-video-frame__corner--br" aria-hidden="true" />
  </div>
</template>
