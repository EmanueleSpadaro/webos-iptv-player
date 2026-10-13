import type { Action, PlaylistEntry, XtreamLiveCategoryFilter, XtreamLiveCategorySnapshot } from '../types';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { SpatialNav } from '../navigation/spatial-nav';
import { t } from '../i18n';
import { createLogger } from '../utils/logger';
import type { XtreamLiveCategory } from '../services/xtream-client';
import { CHECK_ICON } from './icons';
import { doneHint, keyHint, okHint } from './key-hints';
import { sourceToggle } from './toggle-controls';
import { showToast } from './toast';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { AccountSwitcher } from './account-switcher';

const log = createLogger('LiveCategories');

// Rows and headers are absolutely positioned at fixed heights (see
// css/live-category-picker.css), so thousands of categories mount only a window.
const ROW_STRIDE = 64;
const HEAD_HEIGHT = 44;
const HEAD_GAP = 10;
const HEAD_STRIDE = HEAD_HEIGHT + 8;
const LIST_PADDING = 4;
const LIST_OVERSCAN = 8;
const FALLBACK_LIST_HEIGHT = 600;

type ListEntry =
  | { kind: 'head'; section: 'new' | 'all'; count: number }
  | { kind: 'row'; category: XtreamLiveCategory; isNew: boolean };

export interface LiveCategoryPickerOptions {
  accountId: string;
  accountName: string;
  // Other accounts to switch to; the picker applies the current one first.
  accounts?: PlaylistEntry[];
  onSwitch?: (accountId: string) => void;
  filter: XtreamLiveCategoryFilter | undefined;
  snapshot: XtreamLiveCategorySnapshot | null;
  loadCategories: (signal: AbortSignal) => Promise<XtreamLiveCategory[]>;
  // `filter` is the edited value, or the original one when nothing changed.
  onDone: (filter: XtreamLiveCategoryFilter | undefined, categories: XtreamLiveCategory[]) => void;
  onCancel: () => void;
}

/** The choice the picker's checkboxes and toggle stand for. */
export function liveCategoryFilterFrom(
  categoryIds: readonly string[],
  selected: ReadonlySet<string>,
  autoShowNew: boolean,
): XtreamLiveCategoryFilter | undefined {
  if (autoShowNew) {
    const ids = categoryIds.filter(id => !selected.has(id));
    return ids.length ? { mode: 'exclude', ids } : undefined;
  }
  return { mode: 'include', ids: categoryIds.filter(id => selected.has(id)) };
}

export function initialLiveCategorySelection(
  categoryIds: readonly string[],
  filter: XtreamLiveCategoryFilter | undefined,
): Set<string> {
  if (!filter) return new Set(categoryIds);
  const listed = new Set(filter.ids);
  return new Set(categoryIds.filter(id => listed.has(id) === (filter.mode === 'include')));
}

/** Categories the user has not reviewed yet. Only include mode hides new
 *  categories, and its selections are never new because the user picked them. */
export function unseenLiveCategoryIds(
  categoryIds: readonly string[],
  filter: XtreamLiveCategoryFilter | undefined,
  snapshot: XtreamLiveCategorySnapshot | null,
): string[] {
  if (!snapshot || !filter || filter.mode !== 'include') return [];
  const known = new Set(snapshot.knownIds.concat(filter.ids));
  return categoryIds.filter(id => !known.has(id));
}

export class LiveCategoryPicker {
  private el: HTMLElement | null = null;
  private nav: SpatialNav | null = null;
  private switcher: AccountSwitcher | null = null;
  private options: LiveCategoryPickerOptions | null = null;
  private categories: XtreamLiveCategory[] = [];
  private selected = new Set<string>();
  private newIds: string[] = [];
  private autoShowNew = false;
  private dirty = false;
  private state: 'loading' | 'error' | 'ready' = 'loading';
  private controller: AbortController | null = null;
  private entries: ListEntry[] = [];
  private readonly virtualizer = new VirtualList({
    overscan: LIST_OVERSCAN,
    fallbackViewportSize: FALLBACK_LIST_HEIGHT,
  });
  private readonly scrollGuard = new VirtualScrollGuard();
  private scrollFrame: number | null = null;
  // A wheel scroll can unmount the focused row; D-pad resumes from here.
  private detachedEntry: number | null = null;

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  open(options: LiveCategoryPickerOptions): void {
    this.options = options;
    this.autoShowNew = options.filter?.mode === 'exclude';
    this.dirty = false;
    this.categories = [];
    this.selected = new Set();
    this.newIds = [];
    this.entries = [];
    this.detachedEntry = null;
    this.virtualizer.setScrollOffset(0);
    this.mount().classList.remove('hidden');
    void this.load();
  }

  /** Closes without applying, for a view change behind the picker. */
  hide(): void {
    this.switcher?.closeMenu();
    this.controller?.abort();
    this.controller = null;
    this.options = null;
    this.el?.classList.add('hidden');
  }

  handleAction(action: Action): void {
    if (!this.visible || !this.nav) return;
    if (this.switcher?.menuOpen) {
      if (action === 'yellow') this.switcher.closeMenu();
      else this.switcher.handleAction(action);
      return;
    }
    switch (action) {
      case 'back':
      case 'yellow':
        this.done();
        return;
      case 'up':
      case 'down':
        if (!this.moveInList(action === 'up' ? -1 : 1)) this.nav.move(action);
        return;
      case 'left':
      case 'right':
        if (!this.nav.focused) this.restoreDetachedEntry();
        this.nav.move(action);
        return;
      case 'select':
        if (!this.nav.focused) this.restoreDetachedEntry();
        if (this.nav.focused) this.activate(this.nav.focused);
        return;
      case 'red':
        this.setAll(true);
        return;
      case 'green':
        this.setAll(false);
        return;
    }
  }

  private mount(): HTMLElement {
    if (this.el) return this.el;
    const el = document.createElement('div');
    el.className = 'live-category-picker hidden';
    el.setAttribute('data-self-activate', '');
    document.body.appendChild(el);
    this.el = el;
    this.nav = new SpatialNav(el, focused => {
      this.switcher?.setFocused(!!focused?.hasAttribute('data-live-category-avatar'));
    });
    el.addEventListener('click', (event: MouseEvent) => {
      const clicked = event.target as HTMLElement;
      // The account switcher handles its own slot, and a click elsewhere
      // only dismisses its open menu.
      if (this.switcher?.menuOpen || clicked.closest('[data-live-category-avatar]')) return;
      const target = clicked.closest<HTMLElement>('[data-focusable]');
      if (!target || !this.nav) return;
      this.nav.focus(target);
      this.activate(target);
    });
    el.addEventListener('scroll', (event: Event) => {
      const list = event.target;
      if (!(list instanceof HTMLElement) || !list.hasAttribute('data-live-category-list')) return;
      const offset = this.scrollGuard.readUserOffset(list, 'vertical');
      if (offset === null || Math.abs(offset - this.virtualizer.scrollOffset) < 1) return;
      this.virtualizer.setScrollOffset(offset);
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        this.render();
      });
    }, true);
    return el;
  }

  private async load(): Promise<void> {
    const options = this.options;
    if (!options) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.state = 'loading';
    this.render();
    let categories: XtreamLiveCategory[] = [];
    try {
      categories = await options.loadCategories(controller.signal);
    } catch {
      categories = [];
    }
    if (controller.signal.aborted || this.options !== options) return;
    this.controller = null;
    if (!categories.length) {
      log.warn('Live categories unavailable', 'event=xtream.category_filter.picker_failed');
      this.state = 'error';
      this.render();
      const retry = this.el?.querySelector<HTMLElement>('[data-live-categories-retry]');
      if (retry) this.nav?.focus(retry);
      return;
    }
    const ids = categories.map(category => category.id);
    this.categories = categories;
    this.selected = initialLiveCategorySelection(ids, options.filter);
    this.newIds = unseenLiveCategoryIds(ids, options.filter, options.snapshot);
    this.entries = this.buildEntries();
    this.virtualizer.setItemSizes(this.entries.map((entry, index) =>
      entry.kind === 'row' ? ROW_STRIDE : HEAD_STRIDE + (index ? HEAD_GAP : 0)));
    this.virtualizer.setScrollOffset(0);
    this.state = 'ready';
    this.render();
    const first = this.el?.querySelector<HTMLElement>('[data-category-id]');
    if (first) this.nav?.focus(first);
    else this.nav?.focusFirst();
  }

  private activate(el: HTMLElement): void {
    const id = el.dataset.categoryId;
    if (id !== undefined) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.dirty = true;
      this.render();
    } else if (el.classList.contains('source-toggle')) {
      this.autoShowNew = !this.autoShowNew;
      this.dirty = true;
      this.render();
    } else if (el.hasAttribute('data-live-categories-retry')) {
      void this.load();
    } else if (el.dataset.liveCategoriesAction === 'red') {
      this.setAll(true);
    } else if (el.dataset.liveCategoriesAction === 'green') {
      this.setAll(false);
    } else if (el.hasAttribute('data-live-categories-done')) {
      this.done();
    } else if (el.hasAttribute('data-live-category-avatar')) {
      this.switcher?.openMenu();
    }
  }

  private setAll(selected: boolean): void {
    if (this.state !== 'ready') return;
    this.selected = selected ? new Set(this.categories.map(category => category.id)) : new Set();
    this.dirty = true;
    this.render();
  }

  /** Applies the edit and closes; false while nothing is selected. */
  private done(): boolean {
    const options = this.options;
    if (!options) return false;
    if (this.state !== 'ready') {
      this.hide();
      options.onCancel();
      return true;
    }
    if (!this.selected.size) {
      showToast(t('liveCategories.selectOne'));
      return false;
    }
    const ids = this.categories.map(category => category.id);
    const filter = this.dirty
      ? liveCategoryFilterFrom(ids, this.selected, this.autoShowNew)
      : options.filter;
    const categories = this.categories;
    this.hide();
    options.onDone(filter, categories);
    return true;
  }

  private switchAccount(accountId: string): void {
    const onSwitch = this.options?.onSwitch;
    if (!onSwitch) return;
    if (this.done()) onSwitch(accountId);
    // A blocked switch leaves the avatar on the account still being edited.
    else this.mountAccount();
  }

  private switchableAccounts(): PlaylistEntry[] {
    const options = this.options;
    if (!options?.onSwitch || !options.accounts) return [];
    const accounts = options.accounts;
    return accounts.length > 1 && accounts.some(account => account.id === options.accountId)
      ? accounts
      : [];
  }

  // The slot stays mounted (empty when unused) so the AccountSwitcher that
  // owns its DOM is created once.
  private mountAccount(): void {
    const slot = this.el?.querySelector<HTMLElement>('[data-live-category-avatar]');
    if (!slot || !this.options) return;
    if (!this.switcher) {
      this.switcher = new AccountSwitcher(slot, { onSelect: id => this.switchAccount(id) });
      this.switcher.init();
    }
    const accounts = this.switchableAccounts();
    this.switcher.setAccounts(accounts, this.options.accountId);
    this.switcher.setFocused(!!accounts.length && this.nav?.focused === slot);
  }

  // New categories come first under their own header; each category has one row.
  private buildEntries(): ListEntry[] {
    const newIds = new Set(this.newIds);
    const fresh = this.categories.filter(category => newIds.has(category.id));
    const rest = this.categories.filter(category => !newIds.has(category.id));
    const entries: ListEntry[] = [];
    if (fresh.length) {
      entries.push({ kind: 'head', section: 'new', count: fresh.length });
      for (const category of fresh) entries.push({ kind: 'row', category, isNew: true });
    }
    entries.push({ kind: 'head', section: 'all', count: rest.length });
    for (const category of rest) entries.push({ kind: 'row', category, isNew: false });
    return entries;
  }

  private row(category: XtreamLiveCategory, isNew: boolean, index: number, top: number): Safe {
    const selected = this.selected.has(category.id);
    const count = this.options?.snapshot?.counts[category.id];
    return html`
      <button class="live-category-row ${selected ? 'favorite-selected' : ''}"
              style="top:${top}px" data-entry="${index}"
              data-focusable data-key="${isNew ? 'new' : 'all'}:${category.id}"
              data-category-id="${category.id}" aria-pressed="${selected ? 'true' : 'false'}">
        <span class="favorite-checkbox">${selected ? raw(CHECK_ICON) : ''}</span>
        <span>${category.name}</span>
        ${isNew ? html`<em class="live-category-new">${t('liveCategories.newTag')}</em>` : ''}
        ${count === undefined ? '' : html`<strong>${count}</strong>`}
      </button>`;
  }

  private renderList(): Safe {
    if (this.state === 'loading') {
      return html`<div class="live-category-empty">${t('common.loading')}</div>`;
    }
    if (this.state === 'error') {
      return html`
        <div class="live-category-empty live-category-error">
          <div>${t('liveCategories.loadError')}</div>
          <button class="btn btn-secondary" data-focusable data-key="retry"
                  data-live-categories-retry>${t('liveCategories.tryAgain')}</button>
        </div>`;
    }
    this.virtualizer.setLeadingSize(LIST_PADDING);
    const range = this.virtualizer.getRange(this.entries.length, this.listViewport());
    const items: Safe[] = [];
    for (let index = range.start; index < range.end; index++) {
      const entry = this.entries[index];
      const top = this.virtualizer.getItemOffset(index);
      if (entry.kind === 'row') {
        items.push(this.row(entry.category, entry.isNew, index, top));
      } else {
        items.push(html`
          <div class="live-category-section" style="top:${top + (index ? HEAD_GAP : 0)}px"
               data-key="head:${entry.section}">
            <h3>${entry.section === 'new' ? t('liveCategories.newSection') : t('catalog.allCategories')}</h3>
            <span class="live-category-section-count">${entry.count}</span>
          </div>`);
      }
    }
    return html`
      <div class="live-category-list" data-nav-container data-nav-enter="last-focused"
           data-live-category-list>
        <div class="live-category-spacer" data-key="live-category-spacer"
             style="height:${this.virtualizer.getTotalSize(this.entries.length)}px">${items}</div>
      </div>`;
  }

  private listElement(): HTMLElement | null {
    return this.el?.querySelector<HTMLElement>('[data-live-category-list]') ?? null;
  }

  private listViewport(): number {
    return this.listElement()?.clientHeight || FALLBACK_LIST_HEIGHT;
  }

  private focusedEntry(): number | null {
    const entry = this.nav?.focused?.dataset.entry;
    return entry === undefined ? null : Number(entry);
  }

  // Up/Down step by index, since the neighboring row may not be mounted yet.
  private moveInList(delta: number): boolean {
    let from = this.focusedEntry();
    if (from === null && !this.nav?.focused && this.detachedEntry !== null) {
      from = this.detachedEntry;
      this.detachedEntry = null;
      if (!this.stepInList(from, delta)) {
        // At a list end, remount the row so nav.move() leaves the list from it.
        this.focusEntry(from);
        return false;
      }
      return true;
    }
    this.detachedEntry = null;
    return from !== null && this.stepInList(from, delta);
  }

  private stepInList(from: number, delta: number): boolean {
    for (let index = from + delta; index >= 0 && index < this.entries.length; index += delta) {
      if (this.entries[index].kind !== 'row') continue;
      // Reveal a section header when its first row is reached going up.
      if (delta < 0 && index > 0 && this.entries[index - 1].kind === 'head') {
        this.virtualizer.ensureVisible(index - 1, this.listViewport());
      }
      this.focusEntry(index);
      return true;
    }
    return false;
  }

  private restoreDetachedEntry(): void {
    const index = this.detachedEntry;
    this.detachedEntry = null;
    if (index !== null && index < this.entries.length) this.focusEntry(index);
  }

  private focusEntry(index: number): void {
    this.virtualizer.ensureVisible(index, this.listViewport());
    this.render();
    const row = this.el?.querySelector<HTMLElement>(`[data-entry="${index}"]`);
    if (row) this.nav?.focus(row);
  }

  private render(): void {
    const el = this.el;
    const options = this.options;
    if (!el || !options) return;
    const ready = this.state === 'ready';
    const focusedEntry = this.focusedEntry();
    const switchable = this.switchableAccounts().length > 0;
    morph(el, html`
      <div class="live-category-view">
        <header class="live-category-header">
          <div class="live-category-heading"><h2>${t('liveCategories.title')}</h2></div>
          <div class="live-category-account" data-nav-container>
            <span class="live-category-account-name">${options.accountName}</span>
            <div class="live-category-account-slot ${switchable ? '' : 'hidden'}"
                 data-key="live-category-account-slot" data-morph-preserve
                 ${raw(switchable ? 'data-focusable' : '')} data-live-category-avatar></div>
          </div>
        </header>
        ${ready ? html`
          <div class="live-category-toolbar" data-nav-container>
            <div class="live-category-auto">
              <div>
                <div class="live-category-auto-label">${t('liveCategories.autoShowNew')}</div>
                <div class="live-category-auto-hint">${t('liveCategories.autoShowNewHint')}</div>
              </div>
              ${sourceToggle(this.autoShowNew)}
            </div>
            <div class="live-category-summary"><span>${t('liveCategories.selected', {
              count: this.selected.size,
              total: this.categories.length,
            })}</span></div>
          </div>` : ''}
        <div class="live-category-body">${this.renderList()}</div>
        <div class="edit-hints live-category-hints">
          ${ready ? html`
            ${okHint(t('channel.favoriteSelect'))}
            ${keyHint('red', t('channel.favoriteSelectAll'), 'live-categories:red',
              { 'data-live-categories-action': 'red' })}
            ${keyHint('green', t('common.clear'), 'live-categories:green',
              { 'data-live-categories-action': 'green' })}
          ` : ''}
          ${doneHint('live-categories:done', { 'data-live-categories-done': '' })}
        </div>
      </div>`);
    const list = this.listElement();
    if (list) this.scrollGuard.syncOffset(list, 'vertical', this.virtualizer.scrollOffset);
    // morph() resets `class` from the template, dropping the nav highlight.
    this.nav?.clearDetachedFocus();
    if (focusedEntry !== null && !this.nav?.focused) this.detachedEntry = focusedEntry;
    if (this.nav?.focused) this.nav.focused.classList.add('focused');
    this.mountAccount();
  }
}
