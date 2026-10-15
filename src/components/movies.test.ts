// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry, WatchlistEntry, WatchlistKind } from '../types';

const { catalogMock, storageMock, watchlistState, toastMock } = vi.hoisted(() => {
  const watchlistState = { entries: [] as WatchlistEntry[] };
  return {
    catalogMock: { loadVodCategories: vi.fn(), loadVodStreams: vi.fn(), loadVodInfo: vi.fn() },
    watchlistState,
    storageMock: {
      getResumeList: vi.fn(() => [] as unknown[]),
      getResume: vi.fn(() => null),
      getWatchlist: vi.fn(() => watchlistState.entries),
      isWatchlisted: vi.fn((_accountId: string, _kind: WatchlistKind, itemId: string) =>
        watchlistState.entries.some((entry) => entry.itemId === itemId)),
      toggleWatchlist: vi.fn((entry: WatchlistEntry) => {
        const index = watchlistState.entries.findIndex((item) => item.itemId === entry.itemId);
        if (index >= 0) {
          watchlistState.entries.splice(index, 1);
          return false;
        }
        watchlistState.entries.unshift(entry);
        return true;
      }),
    },
    toastMock: { showToast: vi.fn() },
  };
});
vi.mock('../services/xtream-catalog', () => catalogMock);
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));

import { Movies } from './movies';
import { VirtualGrid } from '../utils/virtual-grid';
import { ParentalControlService } from '../services/parental-control';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const vod = (id: string, name: string, categoryId = '1') => ({
  accountId: 'x1', streamId: id, name, poster: '', rating: '', categoryId, containerExtension: 'mp4',
});

let container: HTMLElement;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // clearAllMocks clears calls but not implementations; re-establish the default
  // return so a prior test's mockReturnValue override doesn't leak (order-safety).
  storageMock.getResumeList.mockReturnValue([]);
  storageMock.getResume.mockReturnValue(null);
  watchlistState.entries = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function openWith(cats = [{ id: '1', name: 'Cat A' }], streams = [vod('10', 'Movie One')]) {
  catalogMock.loadVodCategories.mockResolvedValue(cats);
  catalogMock.loadVodStreams.mockResolvedValue(streams);
  const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
  const view = new Movies(container, handlers);
  await view.open(account);
  return { view, handlers };
}

describe('Movies browse + grid', () => {
  it('renders a rail per preloaded category with poster tiles', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    expect(container.querySelector('.catalog-rail-title')?.textContent).toContain('Cat A');
    expect(container.querySelector('.catalog-tile[data-item-id="10"]')?.textContent).toContain('Movie One');
  });

  it('updates the hero title and backdrop to the focused movie', async () => {
    const m1 = { accountId: 'x1', streamId: '10', name: 'Movie One', poster: 'http://host/p1.jpg', rating: '', categoryId: '1', containerExtension: 'mp4' };
    const m2 = { accountId: 'x1', streamId: '11', name: 'Movie Two', poster: 'http://host/p2.jpg', rating: '', categoryId: '1', containerExtension: 'mp4' };
    await openWith([{ id: '1', name: 'Cat A' }], [m1, m2]);
    const hero = container.querySelector<HTMLElement>('.catalog-hero')!;
    const title = () => container.querySelector('.catalog-hero-title')?.textContent;

    container.querySelector('.catalog-tile[data-item-id="11"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(title()).toBe('Movie Two');
    expect(hero.style.backgroundImage).toContain('p2.jpg');

    container.querySelector('.catalog-tile[data-item-id="10"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(title()).toBe('Movie One');
    expect(hero.style.backgroundImage).toContain('p1.jpg');
  });

  it('shows a Continue rail from the resume list', async () => {
    const { StorageService } = await import('../services/storage-service');
    (StorageService.getResumeList as ReturnType<typeof vi.fn>).mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4', position: 100, duration: 6000, updatedAt: 1 },
    ]);
    await openWith();
    expect(container.textContent).toContain('Continue Watching');
  });

  it('shows a Watchlist rail from stored movie snapshots', async () => {
    watchlistState.entries = [{
      accountId: 'x1', kind: 'vod', itemId: '42', name: 'Saved Movie', poster: '',
      rating: '', categoryId: '9', containerExtension: 'mkv', addedAt: 2,
    }];
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    expect(container.textContent).toContain('Watchlist');
    const tile = container.querySelector('.catalog-tile[data-item-id="42"]') as HTMLElement;
    expect(tile.textContent).toContain('Saved Movie');
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.movies-detail')?.textContent).toContain('Saved Movie');
  });

  it('queues only the movies after one launched from the Watchlist rail', async () => {
    watchlistState.entries = [
      {
        accountId: 'x1', kind: 'vod', itemId: '42', name: 'Saved Movie One', poster: '',
        rating: '', categoryId: '9', containerExtension: 'mp4', addedAt: 2,
      },
      {
        accountId: 'x1', kind: 'vod', itemId: '43', name: 'Saved Movie Two', poster: '',
        rating: '', categoryId: '9', containerExtension: 'mkv', addedAt: 1,
      },
    ];
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith();
    const tile = container.querySelector('[data-watchlist-item="42"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: '42',
      watchlistQueue: [
        expect.objectContaining({
          itemId: '43',
          title: 'Saved Movie Two',
          url: 'http://host:8080/movie/u/p/43.mkv',
        }),
      ],
    }));
  });

  it('reveals the tab bar when Up cannot move within the view', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('up');
    expect(handlers.onRevealTabBar).toHaveBeenCalled();
  });

  it('drills into a non-rail category grid and back to browse', async () => {
    // 7 categories: the first RAIL_CATEGORIES (6) become poster rails; the 7th
    // is a non-rail tile in the "All Categories" rail — the drill-in target.
    const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    const { view, handlers } = await openWith(cats, [vod('10', 'Movie One')]);
    const cat = container.querySelector('.catalog-cat[data-category-id="7"]') as HTMLElement;
    expect(cat).not.toBeNull();
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    catalogMock.loadVodStreams.mockResolvedValue([vod('20', 'Movie Two', '7')]);
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.catalog-grid')).not.toBeNull();
    expect(container.querySelector('.catalog-tile[data-item-id="20"]')).not.toBeNull();
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('keeps browse resident under a grid and returns to the same tile', async () => {
    const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    const { view } = await openWith(cats, [vod('10', 'Movie One')]);
    const browse = container.querySelector('.catalog-browse');
    const cat = container.querySelector('.catalog-cat[data-category-id="7"]') as HTMLElement;
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    catalogMock.loadVodStreams.mockResolvedValue([vod('20', 'Movie Two', '7')]);
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    expect(container.querySelector('.catalog-browse')).toBe(browse);
    expect(container.querySelector('.catalog-layer-browse')!.classList)
      .toContain('catalog-layer-hidden');
    expect(container.querySelector('.catalog-layer-grid .focused')?.getAttribute('data-item-id'))
      .toBe('20');
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).toBe(browse);
    expect(cat.isConnected).toBe(true);
    expect(cat.classList).toContain('focused');
    expect(container.querySelector('.catalog-grid')).toBeNull();
  });

  it('lands on the next Watchlist tile after removing the opened one', async () => {
    const saved = (id: string, addedAt: number): WatchlistEntry => ({
      accountId: 'x1', kind: 'vod', itemId: id, name: `Saved ${id}`, poster: '',
      rating: '', categoryId: '9', containerExtension: 'mp4', addedAt,
    });
    watchlistState.entries = [saved('41', 3), saved('42', 2), saved('43', 1)];
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    container.querySelector('[data-watchlist-item="42"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    container.querySelector('[data-action="watchlist"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    view.handleAction('back');

    expect(container.querySelector('[data-watchlist-item="42"]')).toBeNull();
    expect(container.querySelector('.catalog-browse .focused')?.getAttribute('data-watchlist-item'))
      .toBe('43');
  });

  it('shows browse again after Back from a Search deep link', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One'), vod('11', 'Movie Two')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="11"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    const back = vi.fn();
    await view.openItem(account, vod('99', 'Found Movie'), back);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    view.handleAction('back');

    expect(back).toHaveBeenCalled();
    expect(container.querySelector('.catalog-layer-browse')!.classList)
      .not.toContain('catalog-layer-hidden');
    expect(container.querySelector('.movies-detail')).toBeNull();
    expect(tile.classList).toContain('focused');
  });

  it('reloads a browse a Search deep link interrupted once it is shown again', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    catalogMock.loadVodCategories.mockReturnValueOnce(new Promise(() => {}));
    catalogMock.loadVodStreams.mockResolvedValue([vod('10', 'Movie One')]);
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    void view.open(account);
    await view.openItem(account, vod('99', 'Found Movie'), vi.fn());
    catalogMock.loadVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    view.handleAction('back');
    await Promise.resolve(); await Promise.resolve();
    // Not behind Search: only once the section is shown again.
    expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(1);
    view.ensureLoaded(account);
    await vi.waitFor(() => expect(container.querySelector('.catalog-browse')).not.toBeNull());
    expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.catalog-tile[data-item-id="10"]')).not.toBeNull();
  });

  it('keeps a second deep-linked detail when the section is shown again', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    catalogMock.loadVodCategories.mockReturnValueOnce(new Promise(() => {}));
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    void view.open(account);
    await view.openItem(account, vod('98', 'First Find'), vi.fn());
    view.handleAction('back');
    await view.openItem(account, vod('99', 'Second Find'), vi.fn());
    view.ensureLoaded(account);

    expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.movies-detail')?.textContent).toContain('Second Find');
  });

  it('reopens browse on the active account when the section is shown again', async () => {
    const { view } = await openWith();
    view.ensureLoaded(account);
    expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(1);

    const other: PlaylistEntry = { ...account, id: 'x2' };
    view.ensureLoaded(other);
    await vi.waitFor(() => expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(2));
    expect(catalogMock.loadVodCategories).toHaveBeenLastCalledWith(other, expect.anything());
  });

  it('stays in browse when Back cancels a category grid that is still loading', async () => {
    const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    const { view } = await openWith(cats, [vod('10', 'Movie One')]);
    const cat = container.querySelector('.catalog-cat[data-category-id="7"]') as HTMLElement;
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    let resolve!: (items: unknown[]) => void;
    catalogMock.loadVodStreams.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    view.handleAction('select');
    expect(container.querySelector('.catalog-layer-grid .catalog-loading')).not.toBeNull();
    // The hidden category tile no longer takes OK while the grid loads.
    expect(container.querySelector('.focused')).toBeNull();
    const loads = catalogMock.loadVodStreams.mock.calls.length;
    view.handleAction('select');
    expect(catalogMock.loadVodStreams).toHaveBeenCalledTimes(loads);
    view.handleAction('back');
    resolve([vod('20', 'Movie Two', '7')]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(container.querySelector('.catalog-grid')).toBeNull();
    expect(container.querySelector('.catalog-layer-browse')!.classList)
      .not.toContain('catalog-layer-hidden');
    expect(cat.classList).toContain('focused');
  });

  it('finds the origin rail of a category id that needs selector escaping', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const id = 'q"1\\';
    const { view } = await openWith([{ id, name: 'Cat Q' }], [vod('10', 'Movie One', id), vod('11', 'Movie Two', id)]);
    const tile = container.querySelector('.catalog-tile[data-item-id="11"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    // Browse rebuilds the tile as a new node, so focus must find it by rail.
    tile.remove();
    expect(() => view.handleAction('back')).not.toThrow();
    expect(container.querySelector('.catalog-browse .focused')?.getAttribute('data-item-id'))
      .toBe('11');
  });

  // Issue 77: rails stop at RAIL_ITEMS, so every category's full grid must stay
  // reachable from browse — through See all on a rail and through All Categories.
  const eightFullCategories = async () => {
    const cats = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), name: `Cat ${String(i + 1)}` }));
    catalogMock.loadVodCategories.mockResolvedValue(cats);
    catalogMock.loadVodStreams.mockImplementation((_account: PlaylistEntry, categoryId: string) =>
      Promise.resolve(Array.from({ length: 50 }, (_, i) => vod(`${categoryId}-${String(i)}`, `Movie ${String(i)}`, categoryId))));
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    await view.open(account);
    return view;
  };
  const selectAndSettle = async (view: Movies, el: HTMLElement) => {
    el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();
  };

  it('opens the full grid of every category from browse', async () => {
    const view = await eightFullCategories();
    const fullHeight = new VirtualGrid({ columnStride: 244, rowStride: 395, overscanRows: 0 })
      .getTotalSize(50, 1760);

    for (let id = 1; id <= 6; id++) {
      const rail = container.querySelector<HTMLElement>(`.catalog-see-all[data-category-id="${String(id)}"]`)!
        .closest<HTMLElement>('.catalog-rail')!;
      expect(rail.querySelectorAll('.catalog-tile[data-item-id]').length).toBe(20);
      const seeAll = rail.querySelector<HTMLElement>('.catalog-see-all')!;
      expect(seeAll.textContent).toContain('See all');
      expect(seeAll.textContent).toContain('50 movies');
      await selectAndSettle(view, seeAll);
      expect(container.querySelector('.catalog-grid-title')?.textContent).toBe(`Cat ${String(id)}`);
      expect(container.querySelector<HTMLElement>('.catalog-grid-track')?.style.height)
        .toBe(`${String(fullHeight)}px`);
      view.handleAction('back');
    }

    const tiles = Array.from(container.querySelectorAll<HTMLElement>('.catalog-cat'))
      .map((el) => el.dataset.categoryId);
    expect(tiles).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-cat[data-category-id="2"]')!);
    expect(container.querySelector('.catalog-grid-title')?.textContent).toBe('Cat 2');
  });

  it('returns focus to See all when backing out of its grid', async () => {
    const view = await eightFullCategories();
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-see-all[data-category-id="3"]')!);
    view.handleAction('back');
    const focused = container.querySelector<HTMLElement>('.focused');
    expect(focused?.classList.contains('catalog-see-all')).toBe(true);
    expect(focused?.dataset.categoryId).toBe('3');
  });

  const noInfo = { plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 };
  const focusedKey = () => container.querySelector<HTMLElement>('.focused')?.dataset.key;

  it('returns focus to See all after detail, grid, and back to browse', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(noInfo);
    const view = await eightFullCategories();
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-see-all[data-category-id="4"]')!);
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-grid .catalog-tile[data-item-id="4-30"]')!);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    view.handleAction('back');
    expect(container.querySelector('.catalog-grid')).not.toBeNull();
    view.handleAction('back');
    expect(focusedKey()).toBe('all:4');
  });

  it('shows a locked category as locked on its See all tile too', async () => {
    const lockState = vi.spyOn(ParentalControlService, 'groupLockState').mockImplementation(
      (targets) => (targets.some((target) => 'categoryId' in target && target.categoryId === '2') ? 'locked' : null));
    try {
      await eightFullCategories();
      expect(container.querySelector('.catalog-see-all[data-category-id="2"] .lock-badge.is-locked')).not.toBeNull();
      expect(container.querySelector('.catalog-see-all[data-category-id="1"] .lock-badge')).toBeNull();
    } finally {
      lockState.mockRestore();
    }
  });

  it('keeps focus in the Watchlist rail after the origin title is removed', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(noInfo);
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '1-5', categoryId: '1', name: 'Movie 5', poster: '', ext: 'mp4', position: 100, duration: 6000, updatedAt: 1 },
    ]);
    watchlistState.entries = ['42', '43'].map((itemId, i) => ({
      accountId: 'x1', kind: 'vod' as const, itemId, name: `Saved ${itemId}`, poster: '',
      rating: '', categoryId: '1', containerExtension: 'mp4', addedAt: 2 - i,
    }));
    const view = await eightFullCategories();
    await selectAndSettle(view, container.querySelector<HTMLElement>('[data-watchlist-item="42"]')!);
    await selectAndSettle(view, container.querySelector<HTMLElement>('[data-action="watchlist"]')!);
    view.handleAction('back');
    expect(container.querySelector('[data-watchlist-item="42"]')).toBeNull();
    expect(focusedKey()).toBe('w:43');
  });

  it('returns focus to the rail tile a detail was opened from', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(noInfo);
    const view = await eightFullCategories();
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-tile[data-item-id="2-14"]')!);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    view.handleAction('back');
    expect(focusedKey()).toBe('i:2:2-14');
  });

  it('returns focus to the Continue tile, not its twin in a category rail', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(noInfo);
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '1-5', categoryId: '1', name: 'Movie 5', poster: '', ext: 'mp4', position: 100, duration: 6000, updatedAt: 1 },
    ]);
    const view = await eightFullCategories();
    const twin = container.querySelector<HTMLElement>('[data-rail-key="continue"] .catalog-tile')!;
    expect(container.querySelectorAll(`[data-key="${twin.dataset.key!}"]`).length).toBe(2);
    await selectAndSettle(view, twin);
    view.handleAction('back');
    expect(container.querySelector('.focused')?.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey)
      .toBe('continue');
  });

  it('returns focus to an All Categories tile beyond the first rendered window', async () => {
    const cats = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), name: `Cat ${String(i + 1)}` }));
    catalogMock.loadVodCategories.mockResolvedValue(cats);
    catalogMock.loadVodStreams.mockResolvedValue([]);
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    await view.open(account);
    container.querySelector<HTMLElement>('.catalog-cat[data-category-id="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    for (let i = 0; i < 40; i++) view.handleAction('right');
    expect(focusedKey()).toBe('c:41');
    expect(container.querySelector('.catalog-cat[data-category-id="1"]')).toBeNull();
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('.catalog-grid-title')?.textContent).toBe('Cat 41');
    view.handleAction('back');
    expect(focusedKey()).toBe('c:41');
  });

  describe('rail edge gutter', () => {
    // A 1000px scrollport scrolled to 500, holding 220px tiles.
    const stubRail = (tileStart: number) => {
      const track = container.querySelector<HTMLElement>('[data-rail-key="cat:1"] .catalog-rail-track')!;
      const tile = track.querySelector<HTMLElement>('.catalog-tile[data-item-id="1-3"]')!;
      let scrollLeft = 500;
      const writes: { value: number; behavior: string }[] = [];
      Object.defineProperty(track, 'scrollLeft', {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => { writes.push({ value, behavior: track.style.scrollBehavior }); scrollLeft = value; },
      });
      Object.defineProperty(track, 'clientWidth', { configurable: true, value: 1000 });
      Object.defineProperty(tile, 'offsetWidth', { configurable: true, value: 220 });
      track.getBoundingClientRect = () => ({ left: 0 } as DOMRect);
      tile.getBoundingClientRect = () => ({ left: tileStart - scrollLeft } as DOMRect);
      track.style.scrollBehavior = 'smooth';
      return { track, tile, writes };
    };
    const keyboard = (on: boolean) => document.documentElement.classList.toggle('keyboard-nav', on);

    it('nudges a flush, fully visible tile instantly', async () => {
      await eightFullCategories();
      keyboard(true);
      const { track, tile, writes } = stubRail(1280); // ends exactly at 1500
      tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      keyboard(false);
      expect(writes).toEqual([{ value: 1512 - 1000, behavior: 'auto' }]);
      expect(track.style.scrollBehavior).toBe('smooth');
    });

    it('retargets the smooth scroll for a tile still out of view', async () => {
      await eightFullCategories();
      keyboard(true);
      const { writes } = stubRail(1400);
      container.querySelector<HTMLElement>('[data-rail-key="cat:1"] .catalog-tile[data-item-id="1-3"]')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      keyboard(false);
      expect(writes).toEqual([{ value: 1632 - 1000, behavior: 'smooth' }]);
    });

    it('leaves the rail alone when a pointer focuses an edge tile', async () => {
      await eightFullCategories();
      keyboard(false);
      const { tile, writes } = stubRail(1280);
      tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(writes).toEqual([]);
    });
  });

  it('omits See all when a rail already shows the whole category', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], Array.from({ length: 20 }, (_, i) => vod(String(i), `Movie ${String(i)}`)));
    expect(container.querySelectorAll('.catalog-tile[data-item-id]').length).toBe(20);
    expect(container.querySelector('.catalog-see-all')).toBeNull();
  });

  it('virtualizes 50,000 categories and a 50,000-item grid', async () => {
    const cats = Array.from(
      { length: 50_000 },
      (_, i) => ({ id: String(i + 1), name: `Category ${String(i + 1)}` }),
    );
    const streams = Array.from(
      { length: 50_000 },
      (_, i) => vod(String(i), `Movie ${String(i)}`, '7'),
    );
    const { view } = await openWith(cats, streams);

    expect(container.querySelectorAll('.catalog-category-rail-cell').length).toBeLessThan(20);
    expect(container.querySelector<HTMLElement>('.catalog-category-rail-spacer')?.style.width)
      .toBe(`${String(50_000 * 320)}px`);

    const category = container.querySelector<HTMLElement>(
      '.catalog-cat[data-category-id="7"]',
    )!;
    category.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelectorAll('.catalog-grid-cell').length).toBeLessThan(60);
    expect(container.querySelector<HTMLElement>('.catalog-grid-track')?.style.height)
      .toBe('2821485px');
  });

  // The grid virtualizer is only measured while rendering, so a call to
  // getTotalSize is the observable trace of a full grid render.
  const openGrid = async () => {
    const streams = Array.from(
      { length: 50 },
      (_, index) => vod(String(index), `Movie ${String(index)}`, '7'),
    );
    const cats = Array.from(
      { length: 7 },
      (_, index) => ({ id: String(index + 1), name: `Cat ${String(index + 1)}` }),
    );
    const { view } = await openWith(cats, streams);
    container.querySelector<HTMLElement>('.catalog-cat[data-category-id="7"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();
    return view;
  };

  it('moves focus inside the window without re-rendering the grid', async () => {
    const view = await openGrid();
    const rendered = vi.spyOn(VirtualGrid.prototype, 'getTotalSize');
    view.handleAction('right');
    expect(rendered).not.toHaveBeenCalled();
    expect(container.querySelector(
      '[data-grid-index="1"] [data-focusable].focused',
    )).not.toBeNull();
    expect(container.querySelector(
      '[data-grid-index="0"] [data-focusable].focused',
    )).toBeNull();
    rendered.mockRestore();
  });

  it('re-renders the grid once a focus move scrolls the window', async () => {
    const view = await openGrid();
    const rendered = vi.spyOn(VirtualGrid.prototype, 'getTotalSize');
    view.handleAction('down');
    expect(rendered).not.toHaveBeenCalled();
    view.handleAction('down');
    expect(rendered).toHaveBeenCalled();
    expect(container.querySelector(
      '[data-grid-index="14"] [data-focusable].focused',
    )).not.toBeNull();
    rendered.mockRestore();
  });

  it('snaps free grid scrolling to the nearest row after it stops', async () => {
    const cats = Array.from(
      { length: 7 },
      (_, index) => ({ id: String(index + 1), name: `Cat ${String(index + 1)}` }),
    );
    const streams = Array.from(
      { length: 50 },
      (_, index) => vod(String(index), `Movie ${String(index)}`, '7'),
    );
    const { view } = await openWith(cats, streams);
    const category = container.querySelector<HTMLElement>(
      '.catalog-cat[data-category-id="7"]',
    )!;
    category.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();

    vi.useFakeTimers();
    try {
      const grid = container.querySelector<HTMLElement>('.catalog-grid')!;
      const track = container.querySelector<HTMLElement>('.catalog-grid-track')!;
      Object.defineProperty(grid, 'clientHeight', { value: 900, configurable: true });
      grid.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
      track.getBoundingClientRect = () => ({ top: 126 - grid.scrollTop } as DOMRect);
      grid.scrollTop = 577;
      grid.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(100);

      expect(grid.scrollTop).toBe(521);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes back to Live from the browse top level', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('back');
    expect(handlers.onBack).toHaveBeenCalled();
  });

  it('refreshes the Continue rail from storage on each browse render', async () => {
    const { StorageService } = await import('../services/storage-service');
    const getResumeList = StorageService.getResumeList as ReturnType<typeof vi.fn>;
    getResumeList.mockReturnValue([]);
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    expect(container.textContent).not.toContain('Continue Watching');

    // A movie is watched, so a resume entry now exists; walking detail -> browse
    // should surface it without re-entering the section.
    getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4', position: 100, duration: 6000, updatedAt: 1 },
    ]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    view.handleAction('back'); // detail -> browse re-render
    expect(container.textContent).toContain('Continue Watching');
  });
});

describe('Movies detail', () => {
  it('adds and removes the movie from Watchlist without losing button focus', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    const button = container.querySelector('[data-action="watchlist"]') as HTMLElement;
    button.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One',
    }));
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Remove from Watchlist');
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Added to Watchlist');

    view.handleAction('select');
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Add to Watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Watchlist');
  });

  it('renders plot/meta and a Play button, and plays from the start', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: 'A plot.', cast: 'Actor A', director: 'Dir A', genre: 'Drama',
      releaseDate: '2020-05-01', durationSecs: 3600, poster: 'http://host:8080/p.jpg',
      imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    expect(container.querySelector('.detail-plot')?.textContent).toContain('A plot.');
    expect(container.textContent).toContain('Drama');
    expect(container.textContent).toContain('2020');

    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: '10', accountId: 'x1', kind: 'vod', resumeSecs: 0,
      url: 'http://host:8080/movie/u/p/10.mp4',
      watchlistQueue: undefined,
    }));
  });

  it('offers Resume when a resume point exists and passes its position', async () => {
    const { StorageService } = await import('../services/storage-service');
    (StorageService.getResume as ReturnType<typeof vi.fn>).mockReturnValue(
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', position: 900, duration: 3600, updatedAt: 1 },
    );
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 3600, poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    const resume = container.querySelector('[data-action="resume"]') as HTMLElement;
    expect(resume).not.toBeNull();
    resume.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ resumeSecs: 900 }));
  });

  it('refreshes the detail actions when playback creates a resume point', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 3600,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('[data-action="resume"]')).toBeNull();

    storageMock.getResume.mockReturnValue({
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '',
      ext: 'mp4', position: 20, duration: 3600, updatedAt: 1,
    });
    view.refreshPlaybackState();
    expect(container.querySelector('[data-action="resume"]')).not.toBeNull();
  });

  it('backs out of detail to the browse view', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({ plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    const { view, handlers } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('forwards searchMeta.tmdbId to onPlayVod when currentInfo has it', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: 'p', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '',
      imdbId: '1375666', tmdbId: '27205', year: 2010,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      searchMeta: { imdbId: '1375666', tmdbId: '27205', year: 2010 },
    }));
  });

  it('preserves detail focus across the info re-render instead of snapping to the first button', async () => {
    const { StorageService } = await import('../services/storage-service');
    (StorageService.getResume as ReturnType<typeof vi.fn>).mockReturnValue(
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', position: 900, duration: 3600, updatedAt: 1 },
    );
    let resolveInfo!: (v: unknown) => void;
    catalogMock.loadVodInfo.mockReturnValue(new Promise((r) => { resolveInfo = r; }));
    const { view } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); // info-less render committed; focus lands on the first button (Resume)
    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })); // move focus to Play
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('play');
    resolveInfo({ plot: 'x', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    await Promise.resolve(); await Promise.resolve(); // info re-render
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('play');
  });
});

describe('Movies deep-link (openItem)', () => {
  it('opens a movie detail directly and Back returns to Search via the callback', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({ plot: 'Deep plot.', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const onDetailBack = vi.fn();
    const view = new Movies(container, handlers);
    await view.openItem(account, vod('42', 'Deep Movie', '9'), onDetailBack);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    expect(container.textContent).toContain('Deep Movie');
    // No browse is loaded underneath; Back returns to Search via the callback.
    expect(container.querySelector('.catalog-browse')).toBeNull();
    view.handleAction('back');
    expect(onDetailBack).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).not.toHaveBeenCalled(); // did not fall through to Live
  });
});

describe('Movies account-switch race', () => {
  it('a superseded a1 open() cannot clobber a2 rails (account-switch race)', async () => {
    const a1: PlaylistEntry = { id: 'a1', name: 'A1', url: 'http://host/a', source: 'xtream', xtream: { username: 'u1', password: 'p1' } };
    const a2: PlaylistEntry = { id: 'a2', name: 'A2', url: 'http://host/a', source: 'xtream', xtream: { username: 'u2', password: 'p2' } };

    let resolveA1Cats!: (v: unknown) => void;
    let resolveA2Cats!: (v: unknown) => void;
    let resolveA2Streams!: (v: unknown) => void;

    catalogMock.loadVodCategories
      .mockReturnValueOnce(new Promise((r) => { resolveA1Cats = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolveA2Cats = r; }));
    // a1's categories guard fires before loadVodStreams is called for a1,
    // so only one stream load occurs (for a2).
    catalogMock.loadVodStreams
      .mockReturnValueOnce(new Promise((r) => { resolveA2Streams = r; }));

    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const view = new Movies(container, handlers);

    // Start both opens concurrently; neither has resolved yet.
    const p1 = view.open(a1);
    const a1Signal = catalogMock.loadVodCategories.mock.calls[0][1] as AbortSignal;
    const p2 = view.open(a2);
    expect(a1Signal.aborted).toBe(true);
    expect(catalogMock.loadVodCategories.mock.calls[1][1]).toBeInstanceOf(AbortSignal);

    // Resolve a2's categories; wait for open(a2) to resume and call loadVodStreams.
    resolveA2Cats([{ id: 'c2', name: 'Cat Bravo' }]);
    await Promise.resolve(); await Promise.resolve();
    resolveA2Streams([vod('v2', 'Bravo Movie', 'c2')]);
    await p2;

    // Resolve a1's stale categories last — first guard discards them.
    resolveA1Cats([{ id: 'c1', name: 'Cat Alpha' }]);
    await p1;

    expect(container.textContent).toContain('Bravo Movie');
    expect(container.textContent).not.toContain('Alpha Movie');
    expect(container.textContent).toContain('Cat Bravo');
    expect(container.textContent).not.toContain('Cat Alpha');
  });
});
