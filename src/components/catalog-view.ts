import type {
  Action,
  PlaylistEntry,
  ResumeEntry,
  ResumeKind,
  VodPlayback,
  WatchlistEntry,
  WatchlistKind,
} from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html, raw, Safe } from '../utils/dom';
import { categoryLockBadge, lockBadge } from './parental-badge';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import {
  catalogParentalRequest,
  isResumeConcealed,
  isWatchlistConcealed,
  ParentalControlService,
} from '../services/parental-control';
import { CONFIG } from '../config';
import { t } from '../i18n';
import { VirtualGrid } from '../utils/virtual-grid';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { createLogger } from '../utils/logger';

const log = createLogger('Catalog');

const CATALOG_GRID_COLUMN_STRIDE = 244;
const CATALOG_GRID_ROW_STRIDE = 395;
const CATALOG_GRID_OVERSCAN_ROWS = 2;
const CATALOG_GRID_VIEWPORT_WIDTH = 1760;
const CATALOG_GRID_VIEWPORT_HEIGHT = 900;
const CATEGORY_RAIL_STRIDE = 320;
const CATEGORY_RAIL_VIEWPORT = 1760;
const GRID_SNAP_DELAY_MS = 95;

export interface CatalogHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayVod: (req: Omit<VodPlayback, 'onBack'>) => void;
}

type Mode = 'browse' | 'grid' | 'detail';

interface BrowseReturn {
  el: HTMLElement;
  railKey: string;
  index: number;
}

// Shared browse/grid/detail machinery for the Xtream catalog sections (Movies,
// Series): a hero + poster rails browse view, a per-category poster grid, and a
// detail screen, driven by one SpatialNav across all modes. Up at the top row
// hands off to the tab bar; Back walks detail -> grid -> browse -> Live.
// Each mode renders into its own stacked layer. Browse stays resident (hidden,
// not rebuilt) while a grid or detail is open, so Back finds its rails, scroll
// positions, and focused tile exactly as they were.
// Subclasses supply the catalog loaders, item accessors, and the detail
// rendering / playback specifics.
export abstract class CatalogView<C extends { id: string; name: string }, I> {
  protected nav: SpatialNav;
  protected account: PlaylistEntry | null = null;
  protected mode: Mode = 'browse';
  protected categories: C[] = [];
  protected railGroups: { category: C; items: I[] }[] = [];
  protected resume: ResumeEntry[] = [];
  protected itemsByCategory: Record<string, I[]> = {};
  protected gridCategory: C | null = null;
  protected deepLinkBack: (() => void) | null = null;
  private gridFocusIndex = 0;
  private readonly gridVirtualizer = new VirtualGrid({
    columnStride: CATALOG_GRID_COLUMN_STRIDE,
    rowStride: CATALOG_GRID_ROW_STRIDE,
    overscanRows: CATALOG_GRID_OVERSCAN_ROWS,
    fallbackViewportWidth: CATALOG_GRID_VIEWPORT_WIDTH,
    fallbackViewportHeight: CATALOG_GRID_VIEWPORT_HEIGHT,
  });
  private gridScrollFrame: number | null = null;
  private readonly categoryVirtualizer = new VirtualList({
    itemSize: CATEGORY_RAIL_STRIDE,
    overscan: 4,
    fallbackViewportSize: CATEGORY_RAIL_VIEWPORT,
  });
  private categoryScrollFrame: number | null = null;
  protected readonly scrollGuard = new VirtualScrollGuard();
  private gridSnapTimer: ReturnType<typeof setTimeout> | null = null;
  private requestController: AbortController | null = null;
  private readonly layers: Record<Mode, HTMLElement>;
  private browseReturn: BrowseReturn | null = null;
  private gridRequest = 0;
  private browseStale = false;

  constructor(protected container: HTMLElement, protected handlers: CatalogHandlers) {
    const layer = (mode: Mode): HTMLElement => {
      const el = document.createElement('div');
      el.className = `catalog-layer catalog-layer-${mode}`;
      if (mode !== 'browse') el.classList.add('catalog-layer-hidden');
      container.appendChild(el);
      return el;
    };
    this.layers = { browse: layer('browse'), grid: layer('grid'), detail: layer('detail') };
    this.nav = new SpatialNav(container, (el) => this.onFocusChanged(el));
    this.nav.setRestrict(this.layers.browse);
    this.container.addEventListener('mouseleave', () => this.nav.clearHighlight());
    this.container.addEventListener('scroll', (event: Event) => {
      const target = event.target as HTMLElement;
      if (this.handleExtraScroll(target)) return;
      if (this.mode === 'browse' && target.classList.contains('catalog-category-rail')) {
        const offset = this.scrollGuard.readUserOffset(target, 'horizontal');
        if (offset === null) return;
        this.categoryVirtualizer.setScrollOffset(offset);
        if (this.categoryScrollFrame === null) {
          this.categoryScrollFrame = requestAnimationFrame(() => {
            this.categoryScrollFrame = null;
            if (this.mode === 'browse') this.renderBrowse(false);
          });
        }
        return;
      }
      if (this.mode !== 'grid' || !target.classList.contains('catalog-grid')) return;
      const scrollTop = this.scrollGuard.readUserOffset(target, 'vertical');
      if (scrollTop === null) return;
      const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, scrollTop - this.gridTrackStart(target, track)),
      );
      this.scheduleGridSnap(target);
      if (this.gridScrollFrame !== null) return;
      this.gridScrollFrame = requestAnimationFrame(() => {
        this.gridScrollFrame = null;
        if (this.mode === 'grid') this.renderGrid(false);
      });
    }, true);
  }

  // --- subclass configuration ---
  protected abstract readonly kicker: string;             // hero/grid label, e.g. 'Movies'
  protected abstract readonly resumeKind: ResumeKind;     // which resume entries this section owns
  protected abstract readonly emptyMessage: string;       // no catalog on the account
  protected abstract readonly gridEmptyMessage: string;   // empty category grid
  protected abstract loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<C[]>;
  protected abstract loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]>;
  protected abstract itemId(item: I): string;
  protected abstract itemName(item: I): string;
  protected abstract itemPoster(item: I): string;
  protected abstract itemCategoryId(item: I): string;
  protected abstract readonly parentalKind: 'vod' | 'series';
  protected abstract openDetail(item: I): Promise<void>;
  protected abstract renderDetail(restoreFocus?: boolean): void;
  protected abstract clearDetail(): void;                 // drop detail state on deep-link back
  // Section-specific selects (play/resume/season/episode). Returns true if handled.
  protected abstract selectExtra(el: HTMLElement): boolean;
  protected moveExtraFocus(_action: Action): boolean { return false; }
  protected handleExtraScroll(_target: HTMLElement): boolean { return false; }
  protected onRequestSessionReset(): void {}
  // The Continue Watching rail (or '' when there is nothing to resume).
  protected abstract continueRail(): Safe | '';
  // The Watchlist rail (or '' when it is empty).
  protected abstract watchlistRail(): Safe | '';
  // A tile id that isn't in a loaded category (Continue/Watchlist); default none.
  protected fallbackItem(_id: string): I | null { return null; }
  // Hero when no rail item exists (Movies falls back to a resumed item); default none.
  protected heroFallback(): I | null { return null; }

  // The active mode's layer; hidden layers keep their DOM but never take focus.
  protected layer(mode: Mode = this.mode): HTMLElement {
    return this.layers[mode];
  }

  protected showLayer(mode: Mode): void {
    if (this.mode === 'browse' && mode !== 'browse') this.leaveBrowse();
    this.mode = mode;
    (Object.keys(this.layers) as Mode[]).forEach((key) => {
      this.layers[key].classList.toggle('catalog-layer-hidden', key !== mode);
    });
    this.nav.setRestrict(this.layers[mode]);
  }

  // Keys embed provider ids, so compare rather than build a selector from them.
  protected focusableByKey(root: HTMLElement, key: string): HTMLElement | null {
    return Array.from(root.querySelectorAll<HTMLElement>('[data-focusable][data-key]'))
      .find((el) => el.getAttribute('data-key') === key) ?? null;
  }

  protected clearLayer(mode: Mode): void {
    morph(this.layers[mode], html``);
  }

  // Detail entry for subclasses: remembers where browse focus was first.
  protected enterDetail(): void {
    this.showLayer('detail');
  }

  private leaveBrowse(): void {
    const el = this.nav.focused;
    if (!el || !this.layers.browse.contains(el)) return;
    const rail = el.closest<HTMLElement>('[data-rail-key]');
    const tiles = rail
      ? Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'))
      : [];
    this.browseReturn = {
      el,
      railKey: rail?.dataset.railKey ?? '',
      index: Math.max(0, tiles.indexOf(el)),
    };
  }

  // Back lands on the tile browse was left from. A tile that is gone (e.g. a
  // title removed from the Watchlist) hands focus to its neighbor in the same
  // rail, and a rail that is gone falls back to the first tile.
  private restoreBrowseFocus(): void {
    const origin = this.browseReturn;
    this.browseReturn = null;
    const browse = this.layers.browse;
    if (origin && origin.el.isConnected && browse.contains(origin.el)) {
      this.nav.focus(origin.el);
      return;
    }
    // Rail keys embed provider category ids, so compare rather than build a selector.
    const rail = origin?.railKey
      ? Array.from(browse.querySelectorAll<HTMLElement>('[data-rail-key]'))
        .find((el) => el.dataset.railKey === origin.railKey) ?? null
      : null;
    const tiles = rail
      ? Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'))
      : [];
    if (origin && tiles.length) {
      this.nav.focus(tiles[Math.min(origin.index, tiles.length - 1)]);
      return;
    }
    if (!this.nav.focusFirst()) this.nav.focus(null);
  }

  setAccount(account: PlaylistEntry): void {
    if (this.account?.id !== account.id) {
      this.requestController?.abort();
      this.onRequestSessionReset();
    }
    this.account = account;
  }

  protected get requestSignal(): AbortSignal | null {
    return this.requestController?.signal ?? null;
  }

  protected requestFailed(context: string, err: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    log.error(
      `${context} failed`,
      'event=xtream.view.load.failed',
      `operation=${context.toLowerCase().replace(/\s+/g, '_')}`,
      err,
    );
    return true;
  }

  private beginRequests(): AbortSignal {
    this.requestController?.abort();
    this.onRequestSessionReset();
    this.requestController = new AbortController();
    return this.requestController.signal;
  }

  refreshPlaybackState(): void {
    if (this.mode === 'detail') this.renderDetail();
  }

  deactivate(): void {
    this.requestController?.abort();
    this.requestController = null;
    this.onRequestSessionReset();
  }

  async open(account: PlaylistEntry): Promise<void> {
    const signal = this.beginRequests();
    this.account = account;
    this.deepLinkBack = null;
    this.browseReturn = null;
    this.browseStale = false;
    this.clearLayer('grid');
    this.clearLayer('detail');
    this.categories = [];
    this.railGroups = [];
    this.itemsByCategory = {};
    this.gridCategory = null;
    this.categoryVirtualizer.setScrollOffset(0);
    this.gridVirtualizer.setScrollOffset(0);
    this.resume = this.visibleResume(account.id);
    this.clearLayer('browse');
    this.renderLoading('browse');
    try {
      const categories = await this.loadCategories(account, signal);
      if (signal.aborted || this.account?.id !== account.id) return;
      this.categories = categories.filter(category => !ParentalControlService.isCategoryConcealed({
        kind: this.parentalKind === 'vod' ? 'vod-category' : 'series-category',
        accountId: account.id,
        categoryId: category.id,
      }));
      const railCats = this.categories.slice(0, CONFIG.XTREAM.RAIL_CATEGORIES);
      const loaded = await Promise.all(
        railCats.map((c) => this.loadVisibleItems(account, c.id, signal)),
      );
      if (signal.aborted || this.account?.id !== account.id) return;
      this.railGroups = railCats.map((category, i) => {
        this.itemsByCategory[category.id] = loaded[i];
        return { category, items: loaded[i].slice(0, CONFIG.XTREAM.RAIL_ITEMS) };
      });
      this.renderBrowse();
    } catch (err) {
      if (signal.aborted) return;
      log.error(
        'Catalog browse load failed',
        'event=xtream.view.load.failed',
        'operation=browse',
        err,
      );
      if (this.account?.id === account.id) this.renderBrowse();
    }
  }

  // Deep-link entry (from Search): open this item's detail directly. Back returns
  // to the caller via onDetailBack (no browse is loaded underneath).
  async openItem(account: PlaylistEntry, item: I, onDetailBack: () => void): Promise<void> {
    this.beginRequests();
    // Showing this detail; deep-link Back recomputes whether browse is stale.
    this.browseStale = false;
    if (this.account && this.account.id !== account.id
        && this.layers.browse.querySelector('.catalog-view')) {
      this.gridCategory = null;
      this.browseReturn = null;
      this.clearLayer('grid');
      morph(this.layers.browse, this.loadingMarkup());
    }
    this.account = account;
    this.deepLinkBack = onDetailBack;
    await this.openDetail(item);
  }

  // A Search deep link opens over whatever this section last showed. Put that
  // back, so showing the section again never lands on an empty detail layer.
  // A detail the deep link replaced is not restored: Back skips to its grid or
  // browse.
  private restoreBeneathDeepLink(): void {
    if (this.gridCategory && this.layers.grid.querySelector('.catalog-grid')) {
      this.renderGrid();
      return;
    }
    this.gridCategory = null;
    this.clearLayer('grid');
    if (this.layers.browse.querySelector('.catalog-browse')) {
      this.renderBrowse();
      return;
    }
    // The deep link aborted a browse load (or switched accounts). Reload it
    // only if the section is shown again (ensureLoaded), not behind Search.
    this.browseStale = !!this.layers.browse.querySelector('.catalog-loading');
    this.showLayer('browse');
  }

  // For re-showing the section without open(), e.g. when Search closes: reload
  // an interrupted browse, or one left on an account no longer active.
  ensureLoaded(account: PlaylistEntry | null): void {
    if (!account) return;
    if (this.browseStale || this.account?.id !== account.id) void this.open(account);
  }

  // Search is closing over this section: drop a deep-linked detail it left
  // here and show what it opened over.
  leaveDeepLink(): void {
    if (!this.deepLinkBack) return;
    this.beginRequests();
    this.deepLinkBack = null;
    this.clearDetail();
    this.restoreBeneathDeepLink();
    this.clearLayer('detail');
  }

  handleAction(action: Action): void {
    if (this.moveExtraFocus(action)) return;
    if (this.mode === 'browse' && (action === 'left' || action === 'right')
        && this.moveCategoryFocus(action)) return;
    if (this.mode === 'grid'
        && (action === 'up' || action === 'down' || action === 'left' || action === 'right')) {
      if (this.moveGridFocus(action)) return;
      if (action === 'up') this.handlers.onRevealTabBar();
      return;
    }
    switch (action) {
      case 'up':
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
        return;
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.onBack();
        return;
      default:
        return;
    }
  }

  private onBack(): void {
    if (this.mode === 'detail') {
      this.clearDetail();
      if (this.deepLinkBack) {
        const back = this.deepLinkBack;
        this.deepLinkBack = null;
        this.restoreBeneathDeepLink();
        this.clearLayer('detail');
        back();
        return;
      }
      this.gridCategory ? this.renderGrid() : this.renderBrowse();
      this.clearLayer('detail');
      return;
    }
    if (this.mode === 'grid') {
      this.gridCategory = null;
      this.renderBrowse();
      this.clearLayer('grid');
      return;
    }
    this.handlers.onBack();
  }

  private onSelect(): void {
    const el = this.nav.focused;
    if (!el || !this.account) return;
    if (el.dataset.categoryId !== undefined && el.classList.contains('catalog-cat')) {
      void this.openGrid(el.dataset.categoryId);
      return;
    }
    if (this.selectExtra(el)) return;
    if (el.dataset.itemId !== undefined) {
      const item = this.findItem(el.dataset.categoryId ?? '', el.dataset.itemId);
      if (item) void this.openDetail(item);
    }
  }

  // Keep the browse hero (title + backdrop) in sync with the focused item tile.
  // Category tiles and non-browse modes leave the hero unchanged.
  private onFocusChanged(el: HTMLElement | null): void {
    const gridCell = el?.closest<HTMLElement>('[data-grid-index]');
    if (this.mode === 'grid' && gridCell?.dataset.gridIndex !== undefined) {
      this.gridFocusIndex = parseInt(gridCell.dataset.gridIndex, 10);
      return;
    }
    const categoryCell = el?.closest<HTMLElement>('[data-category-virtual-index]');
    if (this.mode === 'browse' && categoryCell) return;
    if (this.mode !== 'browse' || !el) return;
    const id = el.dataset.itemId;
    if (id === undefined) return;
    const item = this.findItem(el.dataset.categoryId ?? '', id);
    if (item) this.updateHero(this.itemName(item), this.itemPoster(item));
  }

  private updateHero(name: string, poster: string): void {
    const hero = this.layers.browse.querySelector<HTMLElement>('.catalog-hero');
    if (!hero) return;
    const title = this.layers.browse.querySelector<HTMLElement>('.catalog-hero-title');
    if (title) title.textContent = name; // textContent escapes untrusted names
    // Poster sits inside a CSS url('…') string; percent-encode the characters
    // that could break out of it (matches renderBrowse's heroBg).
    const bg = poster ? poster.replace(/["'()\\\s]/g, encodeURIComponent) : '';
    hero.style.backgroundImage = bg ? `url('${bg}')` : 'none';
  }

  // Concealed titles are dropped at load, so every rail, grid, and hero built
  // from these lists stays free of them without per-render checks.
  private async loadVisibleItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]> {
    const items = await this.loadItems(account, categoryId, signal);
    if (!ParentalControlService.concealing) return items;
    return items.filter(item => !ParentalControlService.isConcealed(
      catalogParentalRequest(this.parentalKind, {
        accountId: account.id,
        categoryId: this.itemCategoryId(item) || categoryId,
        name: this.itemName(item),
        id: this.itemId(item),
      }),
    ));
  }

  private visibleResume(accountId: string): ResumeEntry[] {
    return StorageService.getResumeList(accountId)
      .filter(entry => entry.kind === this.resumeKind && !isResumeConcealed(entry));
  }

  protected visibleWatchlist(kind: WatchlistKind): WatchlistEntry[] {
    return StorageService.getWatchlist(this.account!.id, kind)
      .filter(entry => !isWatchlistConcealed(entry));
  }

  protected findItem(categoryId: string, id: string): I | null {
    const inCat = this.itemsByCategory[categoryId] ?? [];
    return inCat.find((x) => this.itemId(x) === id) ?? this.fallbackItem(id);
  }

  private async openGrid(categoryId: string): Promise<void> {
    if (!this.account) return;
    const account = this.account;
    const signal = this.requestSignal;
    if (!signal || signal.aborted) return;
    this.gridCategory = this.categories.find((c) => c.id === categoryId) ?? null;
    const request = ++this.gridRequest;
    this.clearLayer('grid');
    if (!this.itemsByCategory[categoryId]) {
      this.renderLoading('grid');
      try {
        this.itemsByCategory[categoryId] = await this.loadVisibleItems(
          account,
          categoryId,
          signal,
        );
      } catch (err) {
        if (signal.aborted) return;
        log.error(
          'Catalog category load failed',
          'event=xtream.view.load.failed',
          'operation=category',
          err,
        );
        this.itemsByCategory[categoryId] = [];
      }
      // Back (or another category) may have superseded this grid meanwhile.
      if (signal.aborted || this.account?.id !== account.id
          || this.mode !== 'grid' || request !== this.gridRequest) return;
      this.clearLayer('grid');
    }
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.renderGrid();
  }

  protected posterCell(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  protected itemLockBadge(categoryId: string, id: string): Safe {
    return raw(lockBadge(ParentalControlService.lockState(
      catalogParentalRequest(this.parentalKind, {
        accountId: this.account?.id ?? '',
        categoryId,
        name: '',
        id,
      }),
    )));
  }

  // Lock badges follow the unlock session without changing what is listed.
  refreshLocks(): void {
    if (!this.layer().querySelector('.catalog-view')) return;
    if (this.mode === 'browse') this.renderBrowse(false);
    else if (this.mode === 'grid') this.renderGrid(false);
  }

  protected tile(item: I): Safe {
    const id = this.itemId(item);
    const cat = this.itemCategoryId(item);
    return html`
      <div class="catalog-tile" data-focusable data-key="i:${cat}:${id}"
           data-item-id="${id}" data-category-id="${cat}">
        <div class="catalog-poster-wrap">${this.posterCell(this.itemName(item), this.itemPoster(item))}${
          this.itemLockBadge(cat, id)}</div>
        <div class="catalog-tile-name">${this.itemName(item)}</div>
      </div>
    `;
  }

  protected rail(key: string, title: string, items: Safe[]): Safe {
    return html`
      <div class="catalog-rail" data-key="rail:${key}" data-rail-key="${key}">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track">${items}</div>
      </div>
    `;
  }

  private loadingMarkup(): Safe {
    return html`
      <div class="catalog-view catalog-loading" data-nav-container>
        <p class="catalog-hint">${t('common.loading')}</p>
      </div>
    `;
  }

  private renderLoading(mode: Mode): void {
    this.showLayer(mode);
    // Drop focus from the hidden layer so OK can't reselect it meanwhile.
    this.nav.focus(null);
    morph(this.layers[mode], this.loadingMarkup());
  }

  protected renderBrowse(restoreFocus = true): void {
    this.showLayer('browse');
    const browse = this.layers.browse;
    this.resume = this.visibleResume(this.account!.id);
    const hero = this.railGroups[0]?.items[0] ?? this.heroFallback();
    const continueRail = this.continueRail();
    const watchlistRail = this.watchlistRail();
    const hasContent = this.categories.length > 0 || !!continueRail || !!watchlistRail;
    // A poster URL sits inside a CSS url('…') string, where the html escaper's
    // entity encoding is decoded before CSS parses it; percent-encode the
    // characters that could break out of the string.
    const heroBg = hero ? this.itemPoster(hero).replace(/["'()\\\s]/g, encodeURIComponent) : '';
    // Categories shown as their own poster rail; the "All Categories" rail lists
    // only the rest, so a category is never both a rail and a tile.
    const railCatIds: Record<string, true> = {};
    this.railGroups.forEach((r) => { railCatIds[r.category.id] = true; });
    const moreCats = this.categories.filter((c) => !railCatIds[c.id]);
    const previousCategoryRail = browse.querySelector<HTMLElement>('.catalog-category-rail');
    if (restoreFocus && previousCategoryRail) {
      this.categoryVirtualizer.setScrollOffset(previousCategoryRail.scrollLeft);
    }
    const categoryViewport = previousCategoryRail?.clientWidth || CATEGORY_RAIL_VIEWPORT;
    const categoryRange = this.categoryVirtualizer.getRange(moreCats.length, categoryViewport);

    morph(browse, html`
      <div class="catalog-view catalog-browse" data-nav-container>
        ${!hasContent
          ? html`<p class="catalog-hint catalog-empty">${this.emptyMessage}</p>`
          : html`
            <div class="catalog-hero" style="background-image: url('${heroBg}')">
              <div class="catalog-hero-scrim"></div>
            </div>
            <div class="catalog-hero-body">
              <div class="catalog-hero-kicker">${this.kicker}</div>
              <h1 class="catalog-hero-title">${hero ? this.itemName(hero) : this.kicker}</h1>
            </div>
            <div class="catalog-rails">
              <div class="catalog-rails-spacer"></div>
              <div class="catalog-rails-body">
                ${continueRail}
                ${watchlistRail}
                ${this.railGroups.map((r) => this.rail(
                  `cat:${r.category.id}`,
                  r.category.name,
                  r.items.map((it) => this.tile(it)),
                ))}
                ${moreCats.length ? html`
                  <div class="catalog-rail" data-key="rail:all-categories"
                       data-rail-key="all-categories">
                    <h2 class="catalog-rail-title">${t('catalog.allCategories')}</h2>
                    <div class="catalog-rail-track catalog-category-rail">
                      <div class="catalog-category-rail-spacer"
                           style="width:${this.categoryVirtualizer.getTotalSize(moreCats.length)}px">
                        ${moreCats.slice(categoryRange.start, categoryRange.end)
                          .map((c, offset) => {
                            const index = categoryRange.start + offset;
                            return html`
                              <div class="catalog-category-rail-cell"
                                   data-key="category-cell:${c.id}"
                                   data-category-virtual-index="${index}"
                                   style="left:${this.categoryVirtualizer.getItemOffset(index)}px">
                                <div class="catalog-cat" data-focusable
                                     data-key="c:${c.id}" data-category-id="${c.id}">${
                                  raw(categoryLockBadge(this.parentalKind, this.account!.id, c.id))
                                }${c.name}</div>
                              </div>
                            `;
                          })}
                      </div>
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>
          `}
      </div>
    `);
    const categoryRail = browse.querySelector<HTMLElement>('.catalog-category-rail');
    if (categoryRail) {
      this.scrollGuard.syncOffset(
        categoryRail,
        'horizontal',
        this.categoryVirtualizer.scrollOffset,
      );
    }
    if (restoreFocus) this.restoreBrowseFocus();
    else this.nav.clearDetachedFocus();
  }

  protected renderGrid(restoreFocus = true): void {
    this.showLayer('grid');
    const gridLayer = this.layers.grid;
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    this.gridFocusIndex = Math.max(0, Math.min(this.gridFocusIndex, items.length - 1));
    const previousView = gridLayer.querySelector<HTMLElement>('.catalog-grid');
    const previousTrack = gridLayer.querySelector<HTMLElement>('.catalog-grid-track');
    if (restoreFocus && previousView) {
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, previousView.scrollTop - this.gridTrackStart(previousView, previousTrack)),
      );
    }
    const viewportWidth = previousTrack?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const viewportHeight = previousView?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    if (restoreFocus && items.length) {
      this.gridVirtualizer.ensureVisible(this.gridFocusIndex, viewportWidth, viewportHeight);
    }
    const range = this.gridVirtualizer.getRange(items.length, viewportWidth, viewportHeight);
    morph(gridLayer, html`
      <div class="catalog-view catalog-grid" data-nav-container>
        <h1 class="catalog-grid-title">${cat ? cat.name : this.kicker}</h1>
        ${items.length === 0
          ? html`<p class="catalog-hint">${this.gridEmptyMessage}</p>`
          : html`
            <div class="catalog-grid-track"
                 style="height:${this.gridVirtualizer.getTotalSize(items.length, viewportWidth)}px">
              ${items.slice(range.start, range.end).map((it, offset) => {
                const index = range.start + offset;
                const position = this.gridVirtualizer.getItemPosition(index, range.columns);
                return html`
                  <div class="catalog-grid-cell"
                       data-key="grid:${this.itemId(it)}"
                       data-grid-index="${index}"
                       style="left:${position.left}px;top:${position.top}px">
                    ${this.tile(it)}
                  </div>
                `;
              })}
            </div>
          `}
      </div>
    `);
    const view = gridLayer.querySelector<HTMLElement>('.catalog-grid');
    const track = gridLayer.querySelector<HTMLElement>('.catalog-grid-track');
    const viewOffset = this.gridVirtualizer.scrollOffset === 0
      ? 0
      : this.gridVirtualizer.scrollOffset + this.gridTrackStart(view, track);
    if (view) this.scrollGuard.syncOffset(view, 'vertical', viewOffset);
    if (restoreFocus) {
      const focused = gridLayer.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      );
      this.nav.focus(focused);
    } else this.nav.clearDetachedFocus();
  }

  private moveGridFocus(direction: Action & ('up' | 'down' | 'left' | 'right')): boolean {
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    if (!items.length) return false;
    const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
    const view = this.layers.grid.querySelector<HTMLElement>('.catalog-grid');
    const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const next = this.gridVirtualizer.getAdjacentIndex(
      this.gridFocusIndex,
      direction,
      items.length,
      viewportWidth,
    );
    if (next === this.gridFocusIndex) return false;
    this.gridFocusIndex = next;
    const viewportHeight = view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    // renderGrid() re-reads the live scroll position before it measures, so
    // do the same here or the comparison below runs against a stale offset.
    const offsetBefore = this.gridVirtualizer.scrollOffset;
    if (view) {
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, view.scrollTop - this.gridTrackStart(view, track)),
      );
    }
    const scrolled = this.gridVirtualizer.ensureVisible(next, viewportWidth, viewportHeight);
    if (!scrolled && this.gridVirtualizer.scrollOffset === offsetBefore
        && this.gridScrollFrame === null) {
      const cell = this.layers.grid.querySelector<HTMLElement>(
        `[data-grid-index="${next}"] [data-focusable]`,
      );
      // Same window and same offset: renderGrid() would morph byte-identical
      // markup, since tiles carry no focus state - SpatialNav owns the class.
      // The channel list already moves focus this way (moveVirtualFocus).
      if (cell) {
        this.nav.focus(cell);
        return true;
      }
    }
    this.renderGrid();
    return true;
  }

  private moveCategoryFocus(direction: 'left' | 'right'): boolean {
    const focused = this.nav.focused;
    const cell = focused?.closest<HTMLElement>('[data-category-virtual-index]');
    if (!cell) return false;
    const railCatIds: Record<string, true> = {};
    this.railGroups.forEach((group) => { railCatIds[group.category.id] = true; });
    const categories = this.categories.filter(category => !railCatIds[category.id]);
    const current = parseInt(cell.dataset.categoryVirtualIndex!, 10);
    const next = current + (direction === 'left' ? -1 : 1);
    if (next < 0 || next >= categories.length) return false;
    const rail = this.layers.browse.querySelector<HTMLElement>('.catalog-category-rail');
    this.categoryVirtualizer.ensureVisible(
      next,
      rail?.clientWidth || CATEGORY_RAIL_VIEWPORT,
    );
    this.renderBrowse(false);
    this.nav.focus(
      this.layers.browse.querySelector<HTMLElement>(
        `[data-category-virtual-index="${next}"] [data-focusable]`,
      ),
    );
    return true;
  }

  private scheduleGridSnap(view: HTMLElement): void {
    if (this.gridSnapTimer !== null) clearTimeout(this.gridSnapTimer);
    this.gridSnapTimer = setTimeout(() => {
      this.gridSnapTimer = null;
      if (this.mode !== 'grid') return;
      const category = this.gridCategory;
      const items = category ? (this.itemsByCategory[category.id] ?? []) : [];
      const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
      const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
      const viewportHeight = view.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
      const maxOffset = Math.max(
        0,
        this.gridVirtualizer.getTotalSize(items.length, viewportWidth) - viewportHeight,
      );
      const snapped = Math.min(
        maxOffset,
        Math.round(this.gridVirtualizer.scrollOffset / CATALOG_GRID_ROW_STRIDE)
          * CATALOG_GRID_ROW_STRIDE,
      );
      if (snapped === this.gridVirtualizer.scrollOffset) return;
      this.gridVirtualizer.setScrollOffset(snapped);
      this.renderGrid(false);
    }, GRID_SNAP_DELAY_MS);
  }

  private gridTrackStart(
    view: HTMLElement | null,
    track: HTMLElement | null,
  ): number {
    if (!view || !track) return 0;
    return Math.max(
      0,
      track.getBoundingClientRect().top
        - view.getBoundingClientRect().top
        + view.scrollTop,
    );
  }
}
