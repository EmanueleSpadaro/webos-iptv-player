import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry } from '../types';

const { clientMock, cacheStore, cacheState } = vi.hoisted(() => ({
  clientMock: {
    getVodCategories: vi.fn(),
    getVodStreams: vi.fn(),
    getVodInfo: vi.fn(),
    getSeriesCategories: vi.fn(),
    getSeries: vi.fn(),
    getSeriesInfo: vi.fn(),
  },
  cacheStore: new Map<string, { key: string; timestamp: number; data: unknown }>(),
  cacheState: { generation: 0 },
}));

vi.mock('./storage-service', () => ({
  StorageService: {
    getXtreamCatalogRefreshIntervalMs: vi.fn(() => 6 * 60 * 60 * 1000),
  },
}));

vi.mock('./xtream-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./xtream-client')>(),
  createXtreamClient: () => clientMock,
}));
vi.mock('./idb-cache', () => ({
  catalogCacheGeneration: vi.fn(() => cacheState.generation),
  getCachedCatalog: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  setCachedCatalog: vi.fn(async (key: string, data: unknown) => {
    cacheStore.set(key, { key, timestamp: Date.now(), data });
  }),
}));

import {
  getSearchCatalogExpiresAt,
  loadAllSeries,
  loadAllVodStreams,
  loadSeries,
  loadSeriesCategories,
  loadSeriesInfo,
  loadVodCategories,
  loadVodInfo,
  loadVodStreams,
} from './xtream-catalog';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';
import { CONFIG } from '../config';
import { XtreamRequestError } from './xtream-client';
import { StorageService } from './storage-service';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};

// Background refreshes chain a few promises; a macrotask drains them all.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  cacheStore.clear();
  cacheState.generation = 0;
  vi.clearAllMocks();
  vi.mocked(StorageService.getXtreamCatalogRefreshIntervalMs)
    .mockReturnValue(CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
});

describe('xtream-catalog', () => {
  it('uses the oldest whole-catalog timestamp for Search memory expiry', async () => {
    const oldest = Date.now() - 2 * 60 * 60 * 1000;
    cacheStore.set('x1|vod_all', {
      key: 'x1|vod_all',
      timestamp: oldest,
      data: [],
    });
    cacheStore.set('x1|series_all', {
      key: 'x1|series_all',
      timestamp: Date.now() - 60 * 60 * 1000,
      data: [],
    });

    expect(await getSearchCatalogExpiresAt('x1'))
      .toBe(oldest + CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
  });

  it('fetches on a cold cache and writes the result under an account-scoped key', async () => {
    clientMock.getVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const out = await loadVodCategories(account);
    expect(out).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getVodCategories).toHaveBeenCalledTimes(1);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_categories',
      out,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
  });

  it('evaluates freshness against the configured catalog interval', async () => {
    vi.mocked(StorageService.getXtreamCatalogRefreshIntervalMs)
      .mockReturnValue(12 * 60 * 60 * 1000);
    const cached = [{ id: '1', name: 'Cached' }];
    cacheStore.set('x1|vod_categories', {
      key: 'x1|vod_categories',
      timestamp: Date.now() - 8 * 60 * 60 * 1000,
      data: cached,
    });

    expect(await loadVodCategories(account)).toEqual(cached);
    expect(clientMock.getVodCategories).not.toHaveBeenCalled();
  });

  it('returns fresh cache without calling the client', async () => {
    cacheStore.set('x1|vod_streams|1', { key: 'x1|vod_streams|1', timestamp: Date.now(), data: [{ accountId: 'x1', streamId: '10' }] });
    const out = await loadVodStreams(account, '1');
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(clientMock.getVodStreams).not.toHaveBeenCalled();
  });

  it('serves a stale list at once and refreshes it in the background', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', { key: 'x1|vod_categories', timestamp: stale, data: [{ id: 'old', name: 'Old' }] });
    let release!: () => void;
    clientMock.getVodCategories.mockImplementation(() => new Promise(resolve => {
      release = () => resolve([{ id: '1', name: 'Cat A' }]);
    }));

    expect(await loadVodCategories(account)).toEqual([{ id: 'old', name: 'Old' }]);
    expect(clientMock.getVodCategories).toHaveBeenCalledTimes(1);
    expect(setCachedCatalog).not.toHaveBeenCalled();

    release();
    await settle();
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_categories',
      [{ id: '1', name: 'Cat A' }],
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
    expect(await loadVodCategories(account)).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getVodCategories).toHaveBeenCalledTimes(1);
  });

  it('shares one background refresh per key and detaches it from the caller signal', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_streams|1', { key: 'x1|vod_streams|1', timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    clientMock.getVodStreams.mockResolvedValue([{ accountId: 'x1', streamId: '10' }]);
    const controller = new AbortController();

    await Promise.all([
      loadVodStreams(account, '1', controller.signal),
      loadVodStreams(account, '1'),
    ]);
    controller.abort();
    await settle();

    expect(clientMock.getVodStreams).toHaveBeenCalledTimes(1);
    expect(clientMock.getVodStreams).toHaveBeenCalledWith('1', undefined);
    expect(cacheStore.get('x1|vod_streams|1')?.data).toEqual([{ accountId: 'x1', streamId: '10' }]);
  });

  it('drops a background refresh that finishes after the catalog cache was cleared', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', { key: 'x1|vod_categories', timestamp: stale, data: [{ id: 'old', name: 'Old' }] });
    let release!: () => void;
    clientMock.getVodCategories.mockImplementation(() => new Promise(resolve => {
      release = () => resolve([{ id: '1', name: 'Cat A' }]);
    }));

    await loadVodCategories(account);
    cacheState.generation++;
    cacheStore.clear();
    release();
    await settle();

    expect(setCachedCatalog).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });

  it('runs at most two background refreshes at a time and queues the rest', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    for (const id of ['1', '2', '3']) {
      cacheStore.set(`x1|vod_streams|${id}`, { key: `x1|vod_streams|${id}`, timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    }
    const releases = new Map<string, () => void>();
    clientMock.getVodStreams.mockImplementation((id: string) => new Promise(resolve => {
      releases.set(id, () => resolve([{ accountId: 'x1', streamId: `new${id}` }]));
    }));

    await Promise.all(['1', '2', '3'].map(id => loadVodStreams(account, id)));
    expect(clientMock.getVodStreams.mock.calls.map(call => call[0])).toEqual(['1', '2']);

    releases.get('1')!();
    await settle();
    expect(clientMock.getVodStreams.mock.calls.map(call => call[0])).toEqual(['1', '2', '3']);

    releases.get('2')!();
    releases.get('3')!();
    await settle();
    expect(cacheStore.get('x1|vod_streams|3')?.data).toEqual([{ accountId: 'x1', streamId: 'new3' }]);
  });

  it('skips a queued background refresh once the catalog cache is cleared', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    for (const id of ['1', '2', '3']) {
      cacheStore.set(`x1|vod_streams|${id}`, { key: `x1|vod_streams|${id}`, timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    }
    const releases: Array<() => void> = [];
    clientMock.getVodStreams.mockImplementation(() => new Promise(resolve => {
      releases.push(() => resolve([]));
    }));

    await Promise.all(['1', '2', '3'].map(id => loadVodStreams(account, id)));
    cacheState.generation++;
    releases.forEach(release => release());
    await settle();

    expect(clientMock.getVodStreams).toHaveBeenCalledTimes(2);
  });

  it('keeps the stale list when a background refresh returns empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_streams|1', { key: 'x1|vod_streams|1', timestamp: stale, data: [{ accountId: 'x1', streamId: '10' }] });
    clientMock.getVodStreams.mockResolvedValue([]);
    const out = await loadVodStreams(account, '1');
    await settle();
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(setCachedCatalog).not.toHaveBeenCalled(); // an empty re-fetch must not overwrite the stale copy
    expect(warn).toHaveBeenCalledWith(
      '[Catalog]',
      'Catalog refresh was empty; keeping stale data',
      'event=xtream.catalog.stale',
      'resource=vod_streams',
      'reason=empty',
      'items=1',
    );
    warn.mockRestore();
  });

  it('falls back to stale VOD info when a stale re-fetch returns null', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    const info = { plot: 'old', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 };
    cacheStore.set('x1|vod_info|10', { key: 'x1|vod_info|10', timestamp: stale, data: info });
    clientMock.getVodInfo.mockResolvedValue(null);
    expect(await loadVodInfo(account, '10')).toEqual(info);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('caches VOD info and skips the write on a null response', async () => {
    clientMock.getVodInfo.mockResolvedValueOnce({ plot: 'p', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    const ok = await loadVodInfo(account, '10');
    expect(ok?.plot).toBe('p');
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_info|10',
      ok,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );

    clientMock.getVodInfo.mockResolvedValueOnce(null);
    (setCachedCatalog as unknown as { mockClear: () => void }).mockClear();
    expect(await loadVodInfo(account, '11')).toBeNull();
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('reads through getCachedCatalog before fetching', async () => {
    clientMock.getVodCategories.mockResolvedValue([]);
    await loadVodCategories(account);
    expect(getCachedCatalog).toHaveBeenCalledWith('x1|vod_categories');
  });

  it('keeps stale data after a failed background refresh but surfaces cold-cache failures', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', {
      key: 'x1|vod_categories',
      timestamp: stale,
      data: [{ id: 'old', name: 'Old' }],
    });
    clientMock.getVodCategories.mockRejectedValue(new XtreamRequestError(
      'too_large',
      'Xtream response exceeded its size limit',
    ));

    await expect(loadVodCategories(account)).resolves.toEqual([{ id: 'old', name: 'Old' }]);
    await settle();
    expect(cacheStore.get('x1|vod_categories')?.data).toEqual([{ id: 'old', name: 'Old' }]);
    cacheStore.clear();
    await expect(loadVodCategories(account)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('propagates cancellation and never writes the cancelled response', async () => {
    const controller = new AbortController();
    clientMock.getVodCategories.mockImplementation(async (signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return [{ id: '1', name: 'Cat A' }];
    });

    await expect(loadVodCategories(account, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('does not serve stale data to a cancelled caller', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', {
      key: 'x1|vod_categories',
      timestamp: stale,
      data: [{ id: 'old', name: 'Old' }],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(loadVodCategories(account, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(clientMock.getVodCategories).not.toHaveBeenCalled();
  });
});

describe('xtream-catalog series', () => {
  const info = { seasons: [1], episodesBySeason: { 1: [{ id: 'e1', title: 'Episode One', season: 1, episode: 1, containerExtension: 'mp4', durationSecs: 0, plot: '', poster: '' }] } };

  it('fetches series categories on a cold cache and writes an account-scoped key', async () => {
    clientMock.getSeriesCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const out = await loadSeriesCategories(account);
    expect(out).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getSeriesCategories).toHaveBeenCalledTimes(1);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|series_categories',
      out,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
  });

  it('returns a fresh series list without calling the client', async () => {
    cacheStore.set('x1|series|1', { key: 'x1|series|1', timestamp: Date.now(), data: [{ accountId: 'x1', seriesId: 's1' }] });
    const out = await loadSeries(account, '1');
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(clientMock.getSeries).not.toHaveBeenCalled();
  });

  it('serves a stale series list and refreshes it in the background', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series|1', { key: 'x1|series|1', timestamp: stale, data: [{ accountId: 'x1', seriesId: 'old' }] });
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1' }]);
    expect(await loadSeries(account, '1')).toEqual([{ accountId: 'x1', seriesId: 'old' }]);
    await settle();
    expect(clientMock.getSeries).toHaveBeenCalledWith('1', undefined);
    expect(await loadSeries(account, '1')).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
  });

  it('keeps a stale series list when a background refresh returns empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series|1', { key: 'x1|series|1', timestamp: stale, data: [{ accountId: 'x1', seriesId: 's1' }] });
    clientMock.getSeries.mockResolvedValue([]);
    const out = await loadSeries(account, '1');
    await settle();
    warn.mockRestore();
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('caches series info and skips the write on a null response', async () => {
    clientMock.getSeriesInfo.mockResolvedValueOnce(info);
    const ok = await loadSeriesInfo(account, 's1');
    expect(ok?.seasons).toEqual([1]);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|series_info|s1',
      ok,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );

    clientMock.getSeriesInfo.mockResolvedValueOnce(null);
    (setCachedCatalog as unknown as { mockClear: () => void }).mockClear();
    expect(await loadSeriesInfo(account, 's2')).toBeNull();
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('reads through getCachedCatalog before fetching series info', async () => {
    clientMock.getSeriesInfo.mockResolvedValue(info);
    await loadSeriesInfo(account, 's1');
    expect(getCachedCatalog).toHaveBeenCalledWith('x1|series_info|s1');
  });

  it('falls back to stale series info when a stale re-fetch returns null', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series_info|s1', { key: 'x1|series_info|s1', timestamp: stale, data: info });
    clientMock.getSeriesInfo.mockResolvedValue(null);
    expect(await loadSeriesInfo(account, 's1')).toEqual(info);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });
});

describe('xtream-catalog whole-catalog (search)', () => {
  it('fetches the full VOD catalog with no category and writes vod_all', async () => {
    clientMock.getVodStreams.mockResolvedValue([{ accountId: 'x1', streamId: '10', name: 'Movie One' }]);
    const out = await loadAllVodStreams(account);
    expect(out).toEqual([{ accountId: 'x1', streamId: '10', name: 'Movie One' }]);
    expect(clientMock.getVodStreams).toHaveBeenCalledWith(undefined, undefined);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_all',
      out,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
  });

  it('returns the fresh full VOD catalog without calling the client', async () => {
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: Date.now(), data: [{ accountId: 'x1', streamId: '10' }] });
    const out = await loadAllVodStreams(account);
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(clientMock.getVodStreams).not.toHaveBeenCalled();
  });

  it('serves a stale full VOD catalog and refreshes it in the background', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    clientMock.getVodStreams.mockResolvedValue([{ accountId: 'x1', streamId: '10' }]);
    expect(await loadAllVodStreams(account)).toEqual([{ accountId: 'x1', streamId: 'old' }]);
    await settle();
    expect(clientMock.getVodStreams).toHaveBeenCalledWith(undefined, undefined);
    expect(await loadAllVodStreams(account)).toEqual([{ accountId: 'x1', streamId: '10' }]);
  });

  it('keeps a stale full VOD catalog when a background refresh returns empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: stale, data: [{ accountId: 'x1', streamId: '10' }] });
    clientMock.getVodStreams.mockResolvedValue([]);
    const out = await loadAllVodStreams(account);
    await settle();
    warn.mockRestore();
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('fetches the full series catalog with no category and writes series_all', async () => {
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    const out = await loadAllSeries(account);
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    expect(clientMock.getSeries).toHaveBeenCalledWith(undefined, undefined);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|series_all',
      out,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
  });

  it('returns the fresh full series catalog without calling the client', async () => {
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: Date.now(), data: [{ accountId: 'x1', seriesId: 's1' }] });
    const out = await loadAllSeries(account);
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(clientMock.getSeries).not.toHaveBeenCalled();
  });

  it('serves a stale full series catalog and refreshes it in the background', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: stale, data: [{ accountId: 'x1', seriesId: 'old' }] });
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    expect(await loadAllSeries(account)).toEqual([{ accountId: 'x1', seriesId: 'old' }]);
    await settle();
    expect(await loadAllSeries(account))
      .toEqual([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
  });

  it('keeps a stale full series catalog when a background refresh returns empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: stale, data: [{ accountId: 'x1', seriesId: 's1' }] });
    clientMock.getSeries.mockResolvedValue([]);
    const out = await loadAllSeries(account);
    await settle();
    warn.mockRestore();
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });
});
