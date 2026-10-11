import type { PlaylistEntry, VodCategory, VodItem, VodInfo, SeriesCategory, SeriesItem, SeriesInfo } from '../types';
import {
  createXtreamClient,
  isXtreamRequestCancelled,
  XtreamRequestError,
} from './xtream-client';
import { catalogCacheGeneration, getCachedCatalog, setCachedCatalog } from './idb-cache';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { StorageService } from './storage-service';

const log = createLogger('Catalog');

// Per-account cached catalog access. Categories are cheap and fetched up front;
// streams are fetched per category on demand. Each result is cached in
// IndexedDB (keyed `${accountId}|action[|param]`). Expired lists are served
// at once and refreshed in the background; expired details are re-fetched
// first. A failed/empty re-fetch keeps the stale copy rather than a blank.

function clientFor(a: PlaylistEntry) {
  return createXtreamClient(
    { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password },
    a.id,
  );
}

function fresh(timestamp: number): boolean {
  return Date.now() - timestamp < StorageService.getXtreamCatalogRefreshIntervalMs();
}

export async function getSearchCatalogExpiresAt(
  accountId: string,
): Promise<number | null> {
  const [vod, series] = await Promise.all([
    getCachedCatalog(`${accountId}|vod_all`),
    getCachedCatalog(`${accountId}|series_all`),
  ]);
  if (!vod || !series) return null;
  return Math.min(vod.timestamp, series.timestamp)
    + StorageService.getXtreamCatalogRefreshIntervalMs();
}

function resourceFor(key: string): string {
  return key.split('|')[1] || 'unknown';
}

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new XtreamRequestError('cancelled', 'Xtream request was cancelled');
  }
}

const queuedRefreshKeys = new Set<string>();
const refreshQueue: Array<() => Promise<void>> = [];
let activeRefreshes = 0;

// Large lists can each be tens of megabytes, so stale ones are re-fetched a
// few at a time instead of all at once when Movies, Series, and Search open.
function pumpRefreshQueue(): void {
  while (
    activeRefreshes < CONFIG.XTREAM.BACKGROUND_REFRESH_CONCURRENCY
    && refreshQueue.length
  ) {
    const run = refreshQueue.shift()!;
    activeRefreshes++;
    const done = (): void => {
      activeRefreshes--;
      pumpRefreshQueue();
    };
    run().then(done, done);
  }
}

// Re-fetch an expired list without the caller's signal, so leaving the view
// does not cancel it. A non-empty result replaces the cache for the next open;
// an empty or failed one keeps the old copy. Concurrent callers share one task.
function refreshListInBackground<T>(
  key: string,
  cachedCount: number,
  refetch: (signal?: AbortSignal) => Promise<T[]>,
): void {
  if (queuedRefreshKeys.has(key)) return;
  queuedRefreshKeys.add(key);
  const generation = catalogCacheGeneration();
  refreshQueue.push(async () => {
    try {
      if (generation !== catalogCacheGeneration()) return;
      const data = await refetch();
      if (generation !== catalogCacheGeneration()) return;
      if (!data.length) {
        log.warn(
          'Catalog refresh was empty; keeping stale data',
          'event=xtream.catalog.stale',
          `resource=${resourceFor(key)}`,
          'reason=empty',
          `items=${cachedCount}`,
        );
        return;
      }
      await setCachedCatalog(key, data, StorageService.getXtreamCatalogRefreshIntervalMs());
      log.debug('refreshed', key, `(${data.length})`);
    } catch (err) {
      log.warn(
        'Catalog refresh failed; keeping stale data',
        'event=xtream.catalog.stale',
        `resource=${resourceFor(key)}`,
        'reason=request_failed',
        `items=${cachedCount}`,
        err,
      );
    } finally {
      queuedRefreshKeys.delete(key);
    }
  });
  pumpRefreshQueue();
}

// Serve any cached list at once, re-fetching an expired one in the background;
// only a cold cache waits on the network.
async function cachedList<T>(
  key: string,
  signal: AbortSignal | undefined,
  refetch: (signal?: AbortSignal) => Promise<T[]>,
): Promise<T[]> {
  ensureActive(signal);
  const cached = await getCachedCatalog<T[]>(key);
  ensureActive(signal);
  if (cached) {
    if (!fresh(cached.timestamp)) refreshListInBackground(key, cached.data.length, refetch);
    log.debug('hit', key, `(${cached.data.length})`);
    return cached.data;
  }
  const data = await refetch(signal);
  ensureActive(signal);
  if (data.length) {
    await setCachedCatalog(key, data, StorageService.getXtreamCatalogRefreshIntervalMs());
    log.debug('fetched', key, `(${data.length})`);
    return data;
  }
  log.warn(
    'Catalog returned no items and has no cache',
    'event=xtream.catalog.empty',
    `resource=${resourceFor(key)}`,
  );
  return data;
}

// Single-object variant of cachedList: caches a truthy result, otherwise serves
// the stale copy (or null) on an empty/failed re-fetch.
async function cachedItem<T>(
  key: string,
  signal: AbortSignal | undefined,
  refetch: () => Promise<T | null>,
): Promise<T | null> {
  ensureActive(signal);
  const cached = await getCachedCatalog<T>(key);
  ensureActive(signal);
  if (cached && fresh(cached.timestamp)) { log.debug('hit', key); return cached.data; }
  let data: T | null;
  try {
    data = await refetch();
  } catch (err) {
    if (isXtreamRequestCancelled(err)) throw err;
    if (cached) {
      log.warn(
        'Catalog detail refresh failed; serving stale data',
        'event=xtream.catalog.stale',
        `resource=${resourceFor(key)}`,
        'reason=request_failed',
        err,
      );
      return cached.data;
    }
    throw err;
  }
  ensureActive(signal);
  if (data) {
    await setCachedCatalog(key, data, StorageService.getXtreamCatalogRefreshIntervalMs());
    log.debug('fetched', key);
    return data;
  }
  if (cached) {
    log.warn(
      'Catalog detail refresh was empty; serving stale data',
      'event=xtream.catalog.stale',
      `resource=${resourceFor(key)}`,
      'reason=empty',
    );
    return cached.data;
  }
  log.warn(
    'Catalog detail returned no item and has no cache',
    'event=xtream.catalog.empty',
    `resource=${resourceFor(key)}`,
  );
  return null;
}

export function loadVodCategories(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<VodCategory[]> {
  return cachedList(
    `${account.id}|vod_categories`,
    signal,
    requestSignal => clientFor(account).getVodCategories(requestSignal),
  );
}

export function loadVodStreams(
  account: PlaylistEntry,
  categoryId: string,
  signal?: AbortSignal,
): Promise<VodItem[]> {
  return cachedList(
    `${account.id}|vod_streams|${categoryId}`,
    signal,
    requestSignal => clientFor(account).getVodStreams(categoryId, requestSignal),
  );
}

export function loadVodInfo(
  account: PlaylistEntry,
  vodId: string,
  signal?: AbortSignal,
): Promise<VodInfo | null> {
  return cachedItem(
    `${account.id}|vod_info|${vodId}`,
    signal,
    () => clientFor(account).getVodInfo(vodId, signal),
  );
}

export function loadSeriesCategories(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<SeriesCategory[]> {
  return cachedList(
    `${account.id}|series_categories`,
    signal,
    requestSignal => clientFor(account).getSeriesCategories(requestSignal),
  );
}

export function loadSeries(
  account: PlaylistEntry,
  categoryId: string,
  signal?: AbortSignal,
): Promise<SeriesItem[]> {
  return cachedList(
    `${account.id}|series|${categoryId}`,
    signal,
    requestSignal => clientFor(account).getSeries(categoryId, requestSignal),
  );
}

export function loadSeriesInfo(
  account: PlaylistEntry,
  seriesId: string,
  signal?: AbortSignal,
): Promise<SeriesInfo | null> {
  return cachedItem(
    `${account.id}|series_info|${seriesId}`,
    signal,
    () => clientFor(account).getSeriesInfo(seriesId, signal),
  );
}

export function loadAllVodStreams(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<VodItem[]> {
  return cachedList(
    `${account.id}|vod_all`,
    signal,
    requestSignal => clientFor(account).getVodStreams(undefined, requestSignal),
  );
}

export function loadAllSeries(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<SeriesItem[]> {
  return cachedList(
    `${account.id}|series_all`,
    signal,
    requestSignal => clientFor(account).getSeries(undefined, requestSignal),
  );
}
