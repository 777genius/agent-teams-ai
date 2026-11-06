#!/usr/bin/env node
// Real Chromium/CDP measurements for the frozen PR baseline and current landing.
// This is a cold-load diagnostic, not a replacement for physical-device field INP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const toolRoot = process.env.CDP_TOOL_ROOT;
const outputDir = process.env.CDP_ARTIFACT_DIR;
assert(toolRoot && outputDir, 'CDP_TOOL_ROOT and CDP_ARTIFACT_DIR are required');
const requireTool = createRequire(path.join(toolRoot, 'entry.cjs'));
const { chromium } = requireTool('playwright-core');
fs.mkdirSync(outputDir, { recursive: true });

const urls = [
  { label: 'baseline', url: 'http://127.0.0.1:4301/' },
  { label: 'pr', url: 'http://127.0.0.1:4302/' },
];
const errors = [];
const records = [];
const chromePath = process.env.CDP_CHROME_PATH || '/usr/bin/google-chrome';

function median(numbers) {
  if (!numbers.length) return null;
  const values = numbers.slice().sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function summarize(samples) {
  const keys = ['fcpMs', 'lcpMs', 'cls', 'tbtMs', 'heapMb', 'bytesKb', 'requests', 'thirdPartyRequests'];
  return Object.fromEntries(keys.map(key => [
    key, median(samples.map(sample => sample[key]).filter(Number.isFinite)),
  ]));
}

async function coldMobileLoad(browser, variant, iteration) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'en-US',
    serviceWorkers: 'block',
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const cdps = await context.newCDPSession(page);
  const requests = new Map();
  let bytes = 0;
  let failedRequests = 0;
  cdps.on('Network.requestWillBeSent', entry => {
    requests.set(entry.requestId, { url: entry.request.url, type: entry.type });
  });
  cdps.on('Network.loadingFinished', entry => {
    const size = entry.encodedDataLength || 0;
    bytes += size;
    const request = requests.get(entry.requestId);
    if (request) request.bytes = size;
  });
  cdps.on('Network.loadingFailed', () => { failedRequests += 1; });
  await cdps.send('Network.enable');
  await cdps.send('Performance.enable');
  await cdps.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdps.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150,
    downloadThroughput: 1600 * 1024 / 8,
    uploadThroughput: 750 * 1024 / 8,
    connectionType: 'cellular4g',
  });
  await cdps.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const shouldTrace = iteration === 1;
  if (shouldTrace) {
    await cdps.send('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing,loading,v8',
      transferMode: 'ReturnAsStream',
    });
  }

  const pageExceptions = [];
  page.on('pageerror', exception => pageExceptions.push(String(exception)));
  await page.addInitScript(() => {
    const vitals = { lcp: null, cls: 0, longTasks: [], eventDurations: [] };
    window.__landingVitals = vitals;
    const create = (type, callback, threshold) => {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
      try {
        new PerformanceObserver(list => callback(list.getEntries())).observe({
          type, buffered: true, ...(threshold ? { durationThreshold: threshold } : {}),
        });
      } catch { /* Unsupported performance entry on this Chromium version. */ }
    };
    create('largest-contentful-paint', entries => {
      const last = entries.at(-1);
      if (last) {
        vitals.lcp = last.startTime;
        vitals.lcpElement = last.element?.tagName + (last.element?.id ? '#' + last.element.id : '');
        vitals.lcpUrl = last.url || '';
      }
    });
    create('layout-shift', entries => {
      for (const item of entries) if (!item.hadRecentInput) vitals.cls += item.value;
    });
    create('longtask', entries => {
      for (const item of entries) vitals.longTasks.push({
        start: item.startTime, duration: item.duration,
      });
    });
    create('event', entries => {
      for (const item of entries) vitals.eventDurations.push(item.duration);
    }, 16);
  });

  const start = Date.now();
  await page.goto(variant.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(11000);
  const data = await page.evaluate(() => {
    const vitals = window.__landingVitals;
    const paint = performance.getEntriesByType('paint');
    const fcp = paint.find(entry => entry.name === 'first-contentful-paint')?.startTime ?? null;
    const navigation = performance.getEntriesByType('navigation')[0];
    const tbt = vitals.longTasks
      .filter(entry => entry.start >= (fcp || 0) && entry.start <= (vitals.lcp || performance.now()))
      .reduce((total, entry) => total + Math.max(0, entry.duration - 50), 0);
    return {
      fcpMs: fcp,
      lcpMs: vitals.lcp,
      lcpElement: vitals.lcpElement || null,
      lcpUrl: vitals.lcpUrl || null,
      cls: vitals.cls,
      tbtMs: Math.round(tbt),
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      bodyWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      heroTitle: document.querySelector('#hero h1')?.textContent?.trim() ?? '',
      iframeCount: document.querySelectorAll('iframe.hero-video__player').length,
      hasDemoPoster: Boolean(document.querySelector('.hero-video__poster')),
      eventDurations: vitals.eventDurations,
    };
  });
  const memory = await cdps.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
  const heap = memory.metrics?.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null;
  const requestList = [...requests.values()];
  const allUrls = requestList.map(entry => entry.url);
  const hosts = {};
  for (const request of requestList) {
    try {
      const host = new URL(request.url).hostname;
      hosts[host] ||= { requests: 0, kb: 0 };
      hosts[host].requests += 1;
      hosts[host].kb += Math.round((request.bytes || 0) / 1024);
    } catch { /* Non-HTTP URL. */ }
  }
  const topHosts = Object.entries(hosts)
    .sort((a, b) => b[1].kb - a[1].kb)
    .slice(0, 12);
  const largestResources = requestList
    .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))
    .slice(0, 12)
    .map(entry => ({ url: entry.url, type: entry.type, kb: Math.round((entry.bytes || 0) / 1024) }));
  const sample = {
    revision: variant.label, iteration, elapsedMs: Date.now() - start,
    ...data, heapMb: heap === null ? null : Math.round(heap / 1048576 * 10) / 10,
    bytesKb: Math.round(bytes / 1024), requests: requests.size,
    thirdPartyRequests: allUrls.filter(url => {
      try { return !['127.0.0.1', 'localhost'].includes(new URL(url).hostname); }
      catch { return false; }
    }).length,
    failedRequests, topHosts, largestResources, pageExceptions,
  };
  if (iteration === 1) {
    await page.screenshot({
      path: path.join(outputDir, variant.label + '-mobile-firstscreen.png'),
      animations: 'disabled',
    });
  }
  if (shouldTrace) {
    const done = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP trace timeout')), 30000);
      cdps.once('Tracing.tracingComplete', event => { clearTimeout(timeout); resolve(event); });
    });
    await cdps.send('Tracing.end');
    const { stream } = await done;
    assert(stream, 'CDP trace was not returned as a stream');
    const chunks = [];
    for (;;) {
      const chunk = await cdps.send('IO.read', { handle: stream, size: 1024 * 1024 });
      chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data));
      if (chunk.eof) break;
    }
    await cdps.send('IO.close', { handle: stream });
    fs.writeFileSync(path.join(outputDir, variant.label + '-mobile-cdp-trace.json'), Buffer.concat(chunks));
  }
  records.push(sample);
  await context.close();
  return sample;
}

async function interactionE2E(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    locale: 'en-US', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  try {
    await page.goto(urls[1].url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const poster = page.locator('.hero-video__poster');
    await poster.waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await page.locator('iframe.hero-video__player').count(), 0,
      'mobile must not initialize Mux iframe before user clicks');
    await poster.click();
    await page.locator('iframe.hero-video__player').waitFor({ state: 'visible', timeout: 30000 });

    await page.locator('#comparison').scrollIntoViewIfNeeded();
    const firstRow = page.locator('#comparison .comparison-table__row').first();
    await firstRow.waitFor({ state: 'visible', timeout: 20000 });
    assert.match(await firstRow.textContent(), /Supported desktop platforms/);
    const scroll = page.locator('#comparison-scroll');
    const before = await scroll.evaluate(el => el.scrollLeft);
    await page.locator('.comparison-table__scroll-button').last().click();
    await page.waitForTimeout(800);
    const after = await scroll.evaluate(el => el.scrollLeft);
    assert(after > before, 'comparison horizontal navigation did not advance');
    await page.screenshot({ path: path.join(outputDir, 'pr-mobile-comparison.png'), animations: 'disabled' });

    await page.locator('#screenshots').scrollIntoViewIfNeeded();
    // Swiper keeps offscreen slides in the DOM: click the active visible slide,
    // not .first(), which may be several viewport widths offscreen.
    const card = page.locator('swiper-slide.swiper-slide-active .screenshots-section__card');
    await card.waitFor({ state: 'visible', timeout: 20000 });
    await card.click();
    await page.locator('.screenshots-lightbox').waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.locator('.screenshots-lightbox').waitFor({ state: 'hidden', timeout: 10000 });

    await page.goto('http://127.0.0.1:4302/ru/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.locator('#comparison').scrollIntoViewIfNeeded();
    await page.getByText('Поддерживаемые десктопные ОС', { exact: true })
      .first().waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(pageErrors.length, 0, 'mobile runtime errors: ' + pageErrors.join('; '));
    return { result: 'pass', mobilePoster: 'pass', videoClick: 'pass',
      comparison: 'pass', screenshotsLightbox: 'pass', ruLocale: 'pass', pageErrors };
  } catch (error) {
    errors.push('mobile interaction E2E: ' + String(error));
    await page.screenshot({ path: path.join(outputDir, 'pr-mobile-E2E-failure.png'), animations: 'disabled' }).catch(() => {});
    return { result: 'fail', error: String(error), pageErrors };
  } finally { await context.close(); }
}

async function desktopSmoke(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, serviceWorkers: 'block',
  });
  const page = await context.newPage();
  try {
    await page.goto(urls[1].url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.locator('#hero h1').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('#comparison').scrollIntoViewIfNeeded();
    await page.locator('.comparison-table__row').first().waitFor({ state: 'visible', timeout: 20000 });
    await page.screenshot({ path: path.join(outputDir, 'pr-desktop-comparison.png'), animations: 'disabled' });
    const overflow = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    assert(overflow.pageWidth <= overflow.viewportWidth + 2,
      'desktop has unintentional document-level horizontal overflow');
    return { result: 'pass', ...overflow };
  } catch (error) {
    errors.push('desktop smoke: ' + String(error));
    return { result: 'fail', error: String(error) };
  } finally { await context.close(); }
}

const browser = await chromium.launch({
  headless: true, executablePath: chromePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let interaction;
let desktop;
try {
  // Alternate revisions to keep network/CDP variance reasonably balanced.
  for (let iteration = 1; iteration <= 3; iteration++) {
    for (const variant of (iteration % 2 ? urls : [...urls].reverse())) {
      await coldMobileLoad(browser, variant, iteration);
    }
  }
  interaction = await interactionE2E(browser);
  desktop = await desktopSmoke(browser);
} finally {
  await browser.close();
}
const comparison = Object.fromEntries(urls.map(v => [
  v.label, summarize(records.filter(sample => sample.revision === v.label)),
]));
const report = { baselineSha: '7ba6e417c56f1d78300f85985ead1698d4902ae0',
  headSha: process.env.GITHUB_SHA || null,
  mobileNetwork: '150ms latency, 1.6Mbps down, 750Kbps up, 4x CPU',
  runsPerRevision: 3, comparison, samples: records,
  interaction, desktop, errors };
fs.writeFileSync(path.join(outputDir, 'cdp-report.json'), JSON.stringify(report, null, 2));
const rows = ['### Cold mobile CDP comparison (medians)', '',
  '| Metric | Base | PR |', '| --- | ---: | ---: |'];
for (const key of Object.keys(comparison.baseline)) {
  rows.push('| ' + key + ' | ' + comparison.baseline[key] + ' | ' + comparison.pr[key] + ' |');
}
rows.push('', 'Mobile interaction E2E: ' + interaction.result,
  'Desktop smoke: ' + desktop.result,
  'Reminder: this lab TBT estimate is not field INP; compare Lighthouse data too.');
const markdown = rows.join('\n') + '\n';
fs.writeFileSync(path.join(outputDir, 'cdp-summary.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
