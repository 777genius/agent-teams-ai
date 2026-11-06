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
    bytes += entry.encodedDataLength || 0;
  });
  cdps.on('Network.loadingFailed', () => { failedRequests += 1; });
  await cdps.send('Network.enable');
  await cdps.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdps.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150,
    downloadThroughput: 1600 * 1024 / 8,
    uploadThroughput: 750 * 1024 / 8,
    connectionType: 'cellular4g',
  });
  await cdps.send('Emulation.setCPUThrottlingRate', { rate: 4 });

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
      if (last) vitals.lcp = last.startTime;
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
  const allUrls = [...requests.values()].map(entry => entry.url);
  const topHosts = Object.entries(allUrls.reduce((totals, url) => {
    try {
      const host = new URL(url).hostname;
      totals[host] = (totals[host] || 0) + 1;
    } catch { /* Non-HTTP URL. */ }
    return totals;
  }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const sample = {
    revision: variant.label, iteration, elapsedMs: Date.now() - start,
    ...data, heapMb: heap === null ? null : Math.round(heap / 1048576 * 10) / 10,
    bytesKb: Math.round(bytes / 1024), requests: requests.size,
    thirdPartyRequests: allUrls.filter(url => {
      try { return !['127.0.0.1', 'localhost'].includes(new URL(url).hostname); }
      catch { return false; }
    }).length,
    failedRequests, topHosts, pageExceptions,
  };
  if (iteration === 1) {
    await page.screenshot({
      path: path.join(outputDir, variant.label + '-mobile-firstscreen.png'),
      animations: 'disabled',
    });
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
    const card = page.locator('.screenshots-section__card').first();
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
