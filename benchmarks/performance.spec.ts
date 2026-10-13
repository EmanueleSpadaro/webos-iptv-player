import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import {
  assertGroupBenchmarkScale,
  assertColdLoadBenchmark,
  assertM3USearchBenchmark,
  assertParentalBenchmark,
  assertPointerBenchmark,
  assertStartupHoverBenchmark,
  assertRetainedMemory,
  assertXMLTVCatalogBenchmark,
  assertBenchmarkScale,
  buildM3UFixture,
  buildXMLTVPipelineFixture,
  cleanupBenchmarkFixture,
  installBenchmarkFixture,
  installColdLoadFixture,
  installM3USearchFixture,
  installUniqueGroupFixture,
  inspectPointerBenchmark,
  measureDerivedIndexBenchmark,
  measureStartupHoverBenchmark,
  measureLargePlaylistMemory,
  largePlaylistCategoryFilter,
  largePlaylistFilteredChannels,
  preparePointerBenchmark,
  rebuildBenchmarkDatabase,
  runGroupBenchmark,
  runM3USearchBenchmark,
  runParentalBenchmark,
  measureXMLTVPipelineComparison,
  measureXMLTVCatalogBenchmark,
  runRawParserBenchmarks,
  runBenchmarkSuites,
  runViewReopenCycle,
  summarizeRetainedMemory,
} from './benchmark-suite.mjs';
import type { LargePlaylistBenchmarkOptions } from './benchmark-suite.mjs';

const SCALE = Number(process.env.BENCHMARK_SCALE ?? '50000');
const KEY_SAMPLES = Number(process.env.BENCHMARK_KEY_SAMPLES ?? '30');
const QUERY_SAMPLES = Number(process.env.BENCHMARK_QUERY_SAMPLES ?? '5');
const CPU_RATE = Number(process.env.BENCHMARK_CPU_RATE ?? '4');
const FIXTURE = {
  scale: SCALE,
  accountId: 'benchmark-x1',
  epgUrl: 'http://host/benchmark-epg',
  backupKey: '__tv_benchmark_backup__',
  directStorage: true,
};
const COLD_PLAYLIST_URL = 'http://host/cold-list.m3u';
const XMLTV_PIPELINE_URL = 'http://host/benchmark-guide.xml.gz';
const LARGE_PLAYLIST_ENTRIES = positiveIntegerEnv(
  'BENCHMARK_LARGE_PLAYLIST_ENTRIES',
  400_000,
);
const LARGE_PLAYLIST_LIVE = positiveIntegerEnv(
  'BENCHMARK_LARGE_PLAYLIST_LIVE',
  50_000,
);
const LARGE_PLAYLIST = {
  totalEntries: LARGE_PLAYLIST_ENTRIES,
  liveEntries: LARGE_PLAYLIST_LIVE,
  playlistBytes: positiveIntegerEnv(
    'BENCHMARK_LARGE_PLAYLIST_BYTES',
    128 * 1024 * 1024,
  ),
  sampleIntervalMs: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_SAMPLE_MS', 25),
  chunkBytes: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_CHUNK_BYTES', 64 * 1024),
  chunkDelayMs: nonNegativeIntegerEnv('BENCHMARK_LARGE_PLAYLIST_CHUNK_DELAY_MS', 0),
  expectedChannels: positiveIntegerEnv(
    'BENCHMARK_LARGE_PLAYLIST_EXPECTED_CHANNELS',
    LARGE_PLAYLIST_LIVE,
  ),
  timeoutMs: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_TIMEOUT_MS', 600_000),
  accountId: 'benchmark-large-playlist',
};
const LARGE_PLAYLIST_FILTER = largePlaylistCategoryFilter();
const LARGE_PLAYLIST_FILTERED = {
  ...LARGE_PLAYLIST,
  liveCategories: LARGE_PLAYLIST_FILTER,
  expectedChannels: largePlaylistFilteredChannels(LARGE_PLAYLIST_LIVE, LARGE_PLAYLIST_FILTER),
};
const LARGE_PLAYLIST_ONLY = process.env.BENCHMARK_LARGE_PLAYLIST_ONLY === '1';

test('records 50,000-item application benchmarks', async ({
  browser,
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The benchmark uses Chromium heap metrics');
  if (LARGE_PLAYLIST_ONLY) {
    const result = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST);
    console.log(`Large playlist benchmark result: ${JSON.stringify(result)}`);
    const filtered = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST_FILTERED);
    console.log(`Filtered large playlist benchmark result: ${JSON.stringify(filtered)}`);
    return;
  }
  await page.route('**/benchmark-seed.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Benchmark seed</title>',
  }));
  await page.route('http://127.0.0.1:8890/**', (route) => route.abort());
  const coldPlaylist = buildM3UFixture(SCALE);
  const xmltvPipelineFixture = buildXMLTVPipelineFixture(SCALE);
  const compressedXMLTV = gzipSync(Buffer.from(xmltvPipelineFixture.text));
  await page.route('http://host/**', (route) => {
    const url = route.request().url();
    if (url === COLD_PLAYLIST_URL) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: coldPlaylist,
      });
    }
    if (url === XMLTV_PIPELINE_URL) {
      return route.fulfill({
        contentType: 'application/gzip',
        body: compressedXMLTV,
      });
    }
    if (/^\/\d+$/.test(new URL(url).pathname)) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n',
      });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => {
    const media = HTMLMediaElement.prototype;
    media.load = function () { /* no-op */ };
    media.play = function () { return Promise.resolve(); };
  });
  const cdp = await page.context().newCDPSession(page);
  if (CPU_RATE !== 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  }

  await page.goto('/benchmark-seed.html');
  await page.evaluate(rebuildBenchmarkDatabase);
  const fixtureStarted = Date.now();
  await page.evaluate(installBenchmarkFixture, FIXTURE);
  const fixtureSetupMs = Date.now() - fixtureStarted;

  try {
    const startupStarted = Date.now();
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-item').first()).toBeVisible();
    const startupReadyMs = Date.now() - startupStarted;
    const startupHover = await page.evaluate(measureStartupHoverBenchmark);
    assertStartupHoverBenchmark(startupHover);
    await page.addScriptTag({
      content: await readFile('test-output/benchmarks/parser-bundle.js', 'utf8'),
    });
    const parsers = await page.evaluate(runRawParserBenchmarks, { scale: SCALE });
    await cdp.send('HeapProfiler.collectGarbage');
    const xmltvPipelineOptions = {
      url: XMLTV_PIPELINE_URL,
      compressedBytes: compressedXMLTV.byteLength,
      uncompressedBytes: Buffer.byteLength(xmltvPipelineFixture.text),
      channelIds: xmltvPipelineFixture.channelIds,
      channelNames: xmltvPipelineFixture.channelNames,
    };
    const xmltvPipelineIo = {
      evaluate: (fn: unknown, arg?: unknown) => page.evaluate(fn as never, arg),
      collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      memoryUsed: () => cdp.send('Runtime.getHeapUsage'),
      delay: (milliseconds: number) =>
        new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    };
    const xmltvPipeline = await measureXMLTVPipelineComparison(
      xmltvPipelineOptions,
      xmltvPipelineIo,
    );
    parsers.xmltvPipelineBuffered = xmltvPipeline.buffered;
    parsers.xmltvPipeline = xmltvPipeline.streaming;
    await cdp.send('HeapProfiler.collectGarbage');
    const suites = await page.evaluate(runBenchmarkSuites, {
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
    });
    suites.parsers = parsers;
    const pointer = await page.evaluate(preparePointerBenchmark);
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    await page.mouse.up();
    const pointerReport = await page.evaluate(inspectPointerBenchmark);
    assertPointerBenchmark(pointerReport, SCALE);
    suites.interactions.magicRemote = pointerReport;

    await cdp.send('HeapProfiler.collectGarbage');
    const beforeReopen = await cdp.send('Runtime.getHeapUsage');
    const reopenHeap: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(runViewReopenCycle);
      await cdp.send('HeapProfiler.collectGarbage');
      reopenHeap.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
    }
    const retained = summarizeRetainedMemory(beforeReopen.usedSize, reopenHeap);
    assertRetainedMemory(retained);
    const heap = await cdp.send('Runtime.getHeapUsage');
    // Runs last of the in-page work: its multi-megabyte feed would otherwise
    // skew the reopen heap samples measured above.
    parsers.xmltvCatalog = await measureXMLTVCatalogBenchmark(SCALE, {
      evaluate: (fn, arg) => page.evaluate(fn as never, arg),
      collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      heapUsed: async () => (await cdp.send('Runtime.getHeapUsage')).usedSize,
    });
    assertXMLTVCatalogBenchmark(parsers.xmltvCatalog);
    const parental = await runDesktopParentalBenchmark(page);
    assertParentalBenchmark(parental, SCALE);
    suites.parental = parental;
    await page.evaluate(installM3USearchFixture);
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
    suites.search.m3u = await page.evaluate(
      runM3USearchBenchmark,
      { querySamples: QUERY_SAMPLES },
    );
    assertM3USearchBenchmark(suites.search.m3u);
    await page.evaluate(installUniqueGroupFixture, SCALE);
    const groupStartupStarted = Date.now();
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
    const groups = await page.evaluate(runGroupBenchmark, { keySamples: KEY_SAMPLES });
    groups.startupMs = Date.now() - groupStartupStarted;
    assertGroupBenchmarkScale(groups, SCALE);
    suites.groups = groups;
    await page.evaluate(installColdLoadFixture, {
      accountId: FIXTURE.accountId,
      url: COLD_PLAYLIST_URL,
    });
    const coldStarted = performance.now();
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-item').first()).toBeVisible();
    const coldResult = await page.evaluate(() => {
      const totalSize = parseFloat(
        document.querySelector<HTMLElement>('.channel-list-spacer')?.style.height || '0',
      );
      return {
        rendered: document.querySelectorAll('.channel-item').length,
        channels: Math.round(totalSize / 88),
      };
    });
    const coldLoad = {
      readyMs: Math.round((performance.now() - coldStarted) * 10) / 10,
      ...coldResult,
    };
    assertColdLoadBenchmark(coldLoad, SCALE);
    suites.coldLoad = coldLoad;
    const largePlaylist = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST);
    const largePlaylistFiltered = await runDesktopLargePlaylistBenchmark(
      browser,
      LARGE_PLAYLIST_FILTERED,
    );
    await page.addScriptTag({
      content: await readFile('test-output/benchmarks/parser-bundle.js', 'utf8'),
    });
    parsers.derivedIndexes = await measureDerivedIndexBenchmark(
      { scale: SCALE },
      {
        evaluate: (fn, arg) => page.evaluate(fn as never, arg),
        collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      },
    );
    assertBenchmarkScale(suites, SCALE);
    const report = {
      version: 1,
      target: 'desktop-chromium',
      generatedAt: new Date().toISOString(),
      scale: SCALE,
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
      cpuRate: CPU_RATE,
      browser: await page.evaluate(() => navigator.userAgent),
      fixtureSetupMs,
      suites: {
        startup: {
          readyMs: startupReadyMs,
          rendered: suites.channelList.rendered,
          ...startupHover,
        },
        ...suites,
        memory: {
          usedHeapMiB: Math.round(heap.usedSize / 1_048_576 * 10) / 10,
          totalHeapMiB: Math.round(heap.totalSize / 1_048_576 * 10) / 10,
          retained,
          largePlaylist,
          largePlaylistFiltered,
        },
      },
    };
    const outputDir = path.join(process.cwd(), 'test-output', 'benchmarks');
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'latest.json');
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Benchmark report: ${outputPath}`);
  } finally {
    await page.goto('/benchmark-seed.html');
    await page.evaluate(cleanupBenchmarkFixture, {
      accountId: FIXTURE.accountId,
      epgUrl: FIXTURE.epgUrl,
      backupKey: FIXTURE.backupKey,
    });
  }
});

// The PIN is set through the UI, and parental controls are turned off again
// afterwards so the later suites run without them. The TV uses runParental
// in tv-runner.mjs, which restores the device's own record.
async function runDesktopParentalBenchmark(page: Page) {
  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('#view-parental-controls')).toBeVisible();
  const report = await page.evaluate(runParentalBenchmark, { keySamples: KEY_SAMPLES });
  await page.locator('[data-parental-tab="options"]').click();
  const power = page.locator('#view-parental-controls .source-toggle');
  await power.click();
  await expect(power).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-parental-back]').click();
  return report;
}

async function runDesktopLargePlaylistBenchmark(
  browser: Browser,
  options: LargePlaylistBenchmarkOptions,
) {
  const context = await browser.newContext({
    baseURL: 'http://localhost:3000',
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const page = await context.newPage();
    const browserCdp = await browser.newBrowserCDPSession();
    const pageCdp = await context.newCDPSession(page);
    return await measureLargePlaylistMemory(options, {
      page,
      browserCdp,
      pageCdp,
      collectGarbage: () => pageCdp.send('HeapProfiler.collectGarbage'),
      delay: (milliseconds: number) =>
        new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    });
  } finally {
    await context.close();
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
