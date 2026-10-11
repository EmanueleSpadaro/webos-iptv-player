import type {
  Action,
  CatalogCategoryTarget,
  CatalogItemTarget,
  Channel,
  LiveChannelTarget,
  LiveGroupTarget,
  ParentalItemTarget,
  ParentalParentTarget,
  ParentalUnlockDuration,
  PlaylistEntry,
  SeriesCategory,
  SeriesItem,
  VodCategory,
  VodItem,
} from '../types';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { SpatialNav } from '../navigation/spatial-nav';
import { StorageService } from '../services/storage-service';
import { PlaylistService } from '../services/playlist-service';
import { channelKey, groupDisplayLabel } from '../utils/channel';
import { isSourceEnabled } from '../utils/playlist';
import {
  loadAllSeries,
  loadAllVodStreams,
  loadSeries,
  loadSeriesCategories,
  loadVodCategories,
  loadVodStreams,
} from '../services/xtream-catalog';
import { ParentalControlService, liveParentalRequest, parentalTargetKey } from '../services/parental-control';
import { t, tp } from '../i18n';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { LOCK_ICON } from './icons';
import { doneHint, keyHint, okHint } from './key-hints';
import { AccountSwitcher } from './account-switcher';
import { lockBadge } from './parental-badge';
import { sourceToggle, toggleGroup } from './toggle-controls';
import { ConfirmationPrompt } from './confirmation-prompt';
import { showToast } from './toast';
import { isAdultGroupName } from './group-icon';

const log = createLogger('ParentalControls');

type SourceKind = 'live' | 'vod' | 'series';

interface SourceEntry {
  key: string;
  kind: SourceKind;
  account: PlaylistEntry;
}

interface GroupEntry {
  key: string;
  name: string;
  count: number | null;
  // Adult by name or source metadata; offered for locking, never locked silently.
  suggested: boolean;
  target: ParentalParentTarget;
  // Live groups know their channels up front, so a partial lock can show a count.
  members: ItemEntry[] | null;
}

interface ItemEntry {
  key: string;
  name: string;
  target: ParentalItemTarget;
  // A channel merged from several sources is locked by any of its groups.
  parents?: Array<LiveGroupTarget | CatalogCategoryTarget>;
}

function groupTarget(group: GroupEntry): LiveGroupTarget | CatalogCategoryTarget {
  return group.target as LiveGroupTarget | CatalogCategoryTarget;
}

function itemTarget(item: ItemEntry): LiveChannelTarget | CatalogItemTarget {
  return item.target as LiveChannelTarget | CatalogItemTarget;
}

// Playlist conventions for adult entries: `adult="1"` or a `parent-code`.
function isAdultChannel(channel: Channel): boolean {
  const attributes = channel.sourceAttributes;
  return !!attributes && (attributes.adult === '1' || !!attributes['parent-code']);
}

export class ParentalControls {
  private nav: SpatialNav;
  private sources: SourceEntry[] = [];
  private groups: GroupEntry[] = [];
  private items: ItemEntry[] = [];
  private sourceIndex = 0;
  private kind: SourceKind = 'live';
  private liveKey = '';
  private xtreamId = '';
  private switcher: AccountSwitcher | null = null;
  // Which column the color keys act on; it survives the pointer moving onto the legend.
  private focusArea: 'group' | 'item' = 'group';
  // The current group survives focus leaving the column (Magic Remote pointer
  // on the legend), so the blue key and the item column always have a target.
  private groupIndex = -1;
  private hovering = false;
  private groupsLoading = false;
  private itemsLoading = false;
  private itemsGroupKey: string | null = null;
  private itemsLoad: Promise<void> | null = null;
  private itemsTimer: ReturnType<typeof setTimeout> | null = null;
  private itemsController: AbortController | null = null;
  private requestController: AbortController | null = null;
  // Item rule key -> owning group key, so "Mixed" holds for every group, not
  // only the one whose items are loaded.
  private memberGroups = new Map<string, string>();
  private mixedGroups = new Set<string>();
  private tab: 'rules' | 'options' = 'rules';
  private readonly confirmationPrompt = new ConfirmationPrompt();

  constructor(
    private container: HTMLElement,
    private onBack: () => void,
    private onChangePin: (done: () => void) => void = () => {},
    private onCreatePin: (done: () => void) => void = () => {},
  ) {
    // Pointer hover only highlights a row; it must not change the current group,
    // or reaching the footer hints would select every row the pointer crosses.
    this.container.addEventListener('nav:hover', () => { this.hovering = true; }, true);
    this.nav = new SpatialNav(container, el => this.onFocusChange(el));
    this.container.addEventListener('nav:hover', () => { this.hovering = false; });
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const clicked = event.target as HTMLElement;
      // The account switcher handles its own slot, and a click elsewhere
      // only dismisses its open menu.
      if (this.switcher?.menuOpen || clicked.closest('.parental-account-slot')) return;
      const target = clicked.closest<HTMLElement>('[data-focusable]');
      if (!target) return;
      const group = target.dataset.parentalGroup;
      const selecting = group !== undefined && Number(group) !== this.groupIndex;
      this.nav.focus(target);
      if (selecting) this.setCurrentGroup(Number(group));
      else this.activate(target);
    });
  }

  open(): void {
    ParentalControlService.setRevealAll(true);
    // Channels hidden by customization can be shown again from Settings, so
    // they must be reviewed and adopted too.
    PlaylistService.setIncludeHidden(true);
    this.requestController?.abort();
    this.sources = this.buildSources();
    for (const source of this.sources) {
      if (source.kind === 'live') this.adoptLiveSource(source.account);
    }
    const accounts = this.xtreamAccounts();
    if (!accounts.some(account => account.id === this.xtreamId)) {
      const selected = StorageService.getSelectedXtreamAccountId();
      this.xtreamId = (accounts.find(account => account.id === selected) ?? accounts[0])?.id ?? '';
    }
    this.switcher?.closeMenu();
    this.focusArea = 'group';
    this.tab = 'rules';
    this.groups = [];
    this.resetItems();
    const index = this.sourceIndexFor(this.kind);
    this.render();
    if (index >= 0) void this.selectSource(index, true);
  }

  dismissPrompt(): void {
    this.confirmationPrompt.hide();
    this.switcher?.closeMenu();
  }

  // Leaving stops catalog loads so they neither render nor take focus later.
  close(): void {
    log.info('Parental manager closed', 'event=parental.manager.closed',
      `loading=${String(this.requestController !== null)}`);
    PlaylistService.setIncludeHidden(false);
    this.dismissPrompt();
    this.requestController?.abort();
    this.requestController = null;
    this.resetItems();
  }

  handleAction(action: Action): void {
    if (this.confirmationPrompt.visible) {
      this.confirmationPrompt.handleAction(action);
      return;
    }
    if (this.switcher?.menuOpen) {
      if (action === 'yellow') this.switcher.closeMenu();
      else this.switcher.handleAction(action);
      return;
    }
    if (action === 'back' || action === 'yellow') {
      this.onBack();
      return;
    }
    if (action === 'left' || action === 'right') {
      if (!this.hopColumn(action)) this.nav.move(action);
      return;
    }
    if (action === 'up' || action === 'down') {
      this.nav.move(action);
      return;
    }
    if (action === 'select') {
      if (this.nav.focused) this.activate(this.nav.focused);
      return;
    }
    if (this.tab !== 'rules') return;
    if (action === 'red' || action === 'green') {
      this.colorAction(action);
      return;
    }
    if (action === 'blue') {
      void this.clearCurrentExceptions();
    }
  }

  private showTab(tab: 'rules' | 'options'): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.render();
    this.focusKey(`parental-tab:${tab}`);
  }

  private confirmRemoveAll(): void {
    this.confirmationPrompt.show({
      title: t('parental.removeAllTitle'),
      message: t('parental.removeAllMessage'),
      confirmLabel: t('parental.removeAll'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        ParentalControlService.clearRules();
        showToast(t('parental.allRemoved'));
        this.render();
        this.focusKey('parental-remove-all');
      },
      onCancel: () => this.focusKey('parental-remove-all'),
    });
  }

  private commitOption(el: HTMLElement, toggle: string): void {
    const value = el.dataset.value ?? '';
    if (toggle === 'parental-conceal') {
      ParentalControlService.setConcealMode(value === 'hide-locked' ? 'hide-locked' : 'show-locked');
    } else {
      ParentalControlService.setUnlockDuration(value as ParentalUnlockDuration);
    }
    this.render();
    this.focusKey(el.dataset.key ?? '');
  }

  private buildSources(): SourceEntry[] {
    const sources: SourceEntry[] = [];
    for (const account of StorageService.getPlaylists()) {
      sources.push({
        key: `live:${account.id}`,
        kind: 'live',
        account,
      });
      if (account.source === 'xtream') {
        sources.push({ key: `vod:${account.id}`, kind: 'vod', account });
        sources.push({ key: `series:${account.id}`, kind: 'series', account });
      }
    }
    return sources;
  }

  // A loaded playlist only: adopting one with no groups yet would unlock it.
  private adoptLiveSource(
    account: PlaylistEntry,
    groups: Array<LiveGroupTarget | CatalogCategoryTarget> = this.liveGroupTargets(account.id),
  ): void {
    if (!groups.length || !isSourceEnabled(account)) return;
    ParentalControlService.adoptSource('live', account.id, groups);
  }

  private liveGroupTargets(playlistId: string): LiveGroupTarget[] {
    return PlaylistService.getGroupsForPlaylist(playlistId).map(name => ({
      kind: 'live-group',
      playlistId,
      groupKey: PlaylistService.getGroupKeyForDisplay(name),
    }));
  }

  private xtreamAccounts(): PlaylistEntry[] {
    return this.sources.filter(source => source.kind === 'vod').map(source => source.account);
  }

  private sourceIndexFor(kind: SourceKind): number {
    const key = kind === 'live' ? this.liveKey : `${kind}:${this.xtreamId}`;
    const index = this.sources.findIndex(source => source.key === key);
    if (index >= 0) return index;
    return this.sources.findIndex(source => source.kind === 'live');
  }

  private selectKind(kind: SourceKind): void {
    if (kind === this.kind) return;
    const index = this.sourceIndexFor(kind);
    if (index >= 0) void this.selectSource(index);
  }

  private selectAccount(id: string): void {
    this.xtreamId = id;
    this.render();
    const index = this.sources.findIndex(source => source.key === `${this.kind}:${id}`);
    if (index >= 0 && index !== this.sourceIndex) void this.selectSource(index);
  }

  private async selectSource(index: number, focusGroups = false): Promise<void> {
    const source = this.sources[index];
    if (!source) return;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    this.sourceIndex = index;
    this.kind = source.kind;
    if (source.kind === 'live') this.liveKey = source.key;
    if (source.account.source === 'xtream') this.xtreamId = source.account.id;
    this.groups = [];
    this.memberGroups = new Map();
    this.resetItems();
    this.groupsLoading = true;
    this.render();
    try {
      if (source.kind === 'live') {
        this.groups = PlaylistService.getGroupsForPlaylist(source.account.id).map(name => {
          const groupKey = PlaylistService.getGroupKeyForDisplay(name);
          const channels = PlaylistService.getByGroup(`source:${name}`, source.account.id);
          const key = `live:${source.account.id}:${groupKey}`;
          const members = channels.map(channel => this.liveItem(channel));
          for (const member of members) this.memberGroups.set(parentalTargetKey(member.target), key);
          return {
            key,
            name: groupDisplayLabel(name),
            count: channels.length,
            suggested: isAdultGroupName(name) || channels.some(isAdultChannel),
            target: {
              kind: 'live-group',
              playlistId: source.account.id,
              groupKey,
            } satisfies LiveGroupTarget,
            members,
          };
        });
        this.adoptLiveSource(source.account, this.groupTargets());
      } else {
        const categories = source.kind === 'vod'
          ? await loadVodCategories(source.account, controller.signal)
          : await loadSeriesCategories(source.account, controller.signal);
        if (controller.signal.aborted) return;
        this.groups = categories.map(category => this.catalogGroup(source, category));
        if (this.groups.length) {
          ParentalControlService.adoptSource(source.kind, source.account.id, this.groupTargets());
        }
        void this.mapCatalogMembers(source, controller.signal);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        log.error('Parental category load failed', 'event=parental.manager.load.failed',
          'stage=groups', `source=${source.key}`, err);
      }
    } finally {
      if (!controller.signal.aborted) {
        log.info('Parental source opened', 'event=parental.manager.source',
          `source=${source.key}`, `enabled=${String(isSourceEnabled(source.account))}`,
          `groups=${this.groups.length}`,
          `approved=${String(ParentalControlService.sourceApproved(source.kind, source.account.id))}`);
        this.groupsLoading = false;
        if (this.groups.length) {
          this.groupIndex = 0;
          void this.loadItems(0);
        }
        this.render();
        if (focusGroups) this.focusColumn('group');
      }
    }
  }

  // Catalog item rules don't record their category, so map them through the
  // full catalog, which is fetched only when the account has item rules.
  private async mapCatalogMembers(source: SourceEntry, signal: AbortSignal): Promise<void> {
    const prefix = parentalTargetKey({
      kind: source.kind === 'vod' ? 'vod-item' : 'series-item',
      accountId: source.account.id,
      itemId: '',
    });
    if (!ParentalControlService.itemRuleEntries().some(([key]) => key.startsWith(prefix))) return;
    try {
      const items = source.kind === 'vod'
        ? (await loadAllVodStreams(source.account, signal))
          .map(item => ({ entry: this.vodItem(item), categoryId: item.categoryId }))
        : (await loadAllSeries(source.account, signal))
          .map(item => ({ entry: this.seriesItem(item), categoryId: item.categoryId }));
      if (signal.aborted) return;
      for (const { entry, categoryId } of items) {
        const key = parentalTargetKey(entry.target);
        if (!this.memberGroups.has(key)) {
          this.memberGroups.set(key, `${source.kind}:${source.account.id}:${categoryId}`);
        }
      }
      this.render();
    } catch (err) {
      if (!signal.aborted) {
        log.error('Parental catalog mapping failed', 'event=parental.manager.load.failed',
          'stage=mapping', `source=${source.key}`, err);
      }
    }
  }

  private catalogGroup(
    source: SourceEntry,
    category: VodCategory | SeriesCategory,
  ): GroupEntry {
    return {
      key: `${source.kind}:${source.account.id}:${category.id}`,
      name: category.name,
      count: null,
      suggested: isAdultGroupName(category.name),
      target: {
        kind: source.kind === 'vod' ? 'vod-category' : 'series-category',
        accountId: source.account.id,
        categoryId: category.id,
      } satisfies CatalogCategoryTarget,
      members: null,
    };
  }

  private resetItems(): void {
    if (this.itemsTimer) clearTimeout(this.itemsTimer);
    this.itemsTimer = null;
    this.itemsController?.abort();
    this.itemsController = null;
    this.itemsLoad = null;
    this.itemsGroupKey = null;
    this.itemsLoading = false;
    this.groupIndex = -1;
    this.items = [];
  }

  private onFocusChange(el: HTMLElement | null): void {
    this.switcher?.setFocused(!!el?.classList.contains('parental-account-slot'));
    const data = el?.dataset;
    const area = !data ? null
      : data.parentalItem !== undefined ? 'item'
        : data.parentalGroup !== undefined || data.parentalSuggest !== undefined
          || data.parentalSource !== undefined ? 'group' : null;
    const areaChanged = area !== null && area !== this.focusArea;
    if (area) this.focusArea = area;
    const index = this.hovering ? undefined : data?.parentalGroup;
    const rendered = index !== undefined && this.setCurrentGroup(Number(index));
    if (areaChanged && !rendered) this.render();
  }

  private setCurrentGroup(index: number): boolean {
    const group = this.groups[index];
    if (!group || index === this.groupIndex) return false;
    this.groupIndex = index;
    this.itemsController?.abort();
    this.itemsLoad = null;
    this.itemsGroupKey = null;
    this.items = [];
    this.itemsLoading = true;
    this.render();
    if (this.itemsTimer) clearTimeout(this.itemsTimer);
    // Debounced so scrolling through catalog categories doesn't fetch each one.
    this.itemsTimer = setTimeout(() => {
      this.itemsTimer = null;
      void this.loadItems(index);
    }, CONFIG.PARENTAL_ITEMS_DELAY_MS);
    return true;
  }

  private loadItems(index: number): Promise<void> {
    const source = this.sources[this.sourceIndex];
    const group = this.groups[index];
    if (!source || !group) return Promise.resolve();
    if (this.itemsTimer) clearTimeout(this.itemsTimer);
    this.itemsTimer = null;
    if (this.itemsGroupKey === group.key && this.itemsLoad) return this.itemsLoad;
    this.itemsController?.abort();
    const controller = new AbortController();
    this.itemsController = controller;
    this.itemsGroupKey = group.key;
    this.items = [];
    this.itemsLoading = true;
    this.render();
    this.itemsLoad = (async () => {
      try {
        let items: ItemEntry[];
        if (source.kind === 'live') {
          const target = group.target as LiveGroupTarget;
          const display = PlaylistService.getGroupsForPlaylist(source.account.id)
            .find(name => PlaylistService.getGroupKeyForDisplay(name) === target.groupKey);
          const channels = display
            ? PlaylistService.getByGroup(`source:${display}`, source.account.id)
            : [];
          items = channels.map(channel => this.liveItem(channel));
        } else {
          const categoryId = (group.target as CatalogCategoryTarget).categoryId;
          items = source.kind === 'vod'
            ? (await loadVodStreams(source.account, categoryId, controller.signal))
              .map(item => this.vodItem(item))
            : (await loadSeries(source.account, categoryId, controller.signal))
              .map(item => this.seriesItem(item));
        }
        if (!controller.signal.aborted) {
          this.items = items;
          for (const item of items) this.memberGroups.set(parentalTargetKey(item.target), group.key);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          log.error('Parental item load failed', 'event=parental.manager.load.failed',
            'stage=items', `source=${source.key}`, `group=${group.key}`, err);
        }
      } finally {
        if (!controller.signal.aborted) {
          this.itemsLoading = false;
          this.render();
        }
      }
    })();
    return this.itemsLoad;
  }

  private liveItem(channel: Channel): ItemEntry {
    return {
      key: `live:${channelKey(channel)}`,
      name: channel.name,
      target: { kind: 'live-channel', channelKey: channelKey(channel) },
      parents: liveParentalRequest(channel).parents,
    };
  }

  private vodItem(item: VodItem): ItemEntry {
    return {
      key: `vod:${item.accountId}:${item.streamId}`,
      name: item.name,
      target: { kind: 'vod-item', accountId: item.accountId, itemId: item.streamId },
    };
  }

  private seriesItem(item: SeriesItem): ItemEntry {
    return {
      key: `series:${item.accountId}:${item.seriesId}`,
      name: item.name,
      target: { kind: 'series-item', accountId: item.accountId, itemId: item.seriesId },
    };
  }

  private activate(el: HTMLElement): void {
    if (el.dataset.parentalBack !== undefined) {
      this.onBack();
      return;
    }
    const color = el.dataset.parentalAction;
    if (color === 'red' || color === 'green') {
      this.colorAction(color);
      return;
    }
    if (el.dataset.parentalAvatar !== undefined) {
      this.switcher?.openMenu();
      return;
    }
    const toggle = el.closest('.toggle-group')?.id;
    const kind = el.dataset.value;
    if (toggle === 'parental-kind' && (kind === 'live' || kind === 'vod' || kind === 'series')) {
      this.selectKind(kind);
      return;
    }
    if (el.dataset.parentalAction === 'blue') {
      void this.clearCurrentExceptions();
      return;
    }
    if (el.dataset.parentalSuggest !== undefined) {
      this.lockSuggested();
      return;
    }
    if (el.dataset.parentalChangePin !== undefined) {
      this.onChangePin(() => {
        showToast(t('parental.pinChanged'));
        this.focusKey('parental-change-pin');
      });
      return;
    }
    const tab = el.dataset.parentalTab;
    if (tab === 'rules' || tab === 'options') {
      this.showTab(tab);
      return;
    }
    if (toggle === 'parental-conceal' || toggle === 'parental-duration') {
      this.commitOption(el, toggle);
      return;
    }
    if (el.dataset.parentalRemoveAll !== undefined) {
      this.confirmRemoveAll();
      return;
    }
    if (el.classList.contains('source-toggle')) {
      const refresh = () => {
        this.render();
        this.focusSelector('.source-toggle');
      };
      if (ParentalControlService.enabled) {
        ParentalControlService.disable();
        refresh();
      } else {
        this.onCreatePin(refresh);
      }
      return;
    }
    const sourceIndex = el.dataset.parentalSource;
    if (sourceIndex !== undefined) {
      void this.selectSource(Number(sourceIndex));
      return;
    }
    const groupIndex = el.dataset.parentalGroup;
    if (groupIndex !== undefined) {
      const group = this.groups[Number(groupIndex)];
      if (!group) return;
      ParentalControlService.setGroupProtected(groupTarget(group), !this.isGroupLocked(group));
      this.render();
      return;
    }
    const itemIndex = el.dataset.parentalItem;
    if (itemIndex !== undefined) {
      const item = this.items[Number(itemIndex)];
      const group = this.groups[this.groupIndex];
      if (!item || !group) return;
      ParentalControlService.setItemLocked(
        itemTarget(item),
        this.itemParents(item, group),
        !this.isItemLocked(item, group),
      );
      this.render();
      this.focusKey(item.key);
      return;
    }
  }

  private colorAction(color: 'red' | 'green'): void {
    if (this.focusArea === 'item' && this.groups[this.groupIndex]) {
      void this.setCurrentGroupContents(color === 'red');
    } else if (color === 'red') {
      this.protectAllGroups();
    } else {
      this.unlockAllGroups();
    }
  }

  // Locks or unlocks the whole group and drops its exceptions.
  private async setCurrentGroupContents(locked: boolean): Promise<void> {
    const group = this.groups[this.groupIndex];
    if (!group) return;
    await this.loadItems(this.groupIndex);
    if (this.groups[this.groupIndex]?.key !== group.key) return;
    ParentalControlService.setGroupProtected(groupTarget(group), locked);
    ParentalControlService.clearItemRules(this.items.map(itemTarget));
    this.render();
  }

  private groupTargets(): Array<LiveGroupTarget | CatalogCategoryTarget> {
    return this.groups.map(groupTarget);
  }

  private protectAllGroups(): void {
    if (!this.groups.length) return;
    ParentalControlService.setGroupsProtected(this.groupTargets(), true);
    this.render();
  }

  private unlockAllGroups(): void {
    const source = this.sources[this.sourceIndex];
    if (!source || !this.groups.length) return;
    const channelKeys = source.kind === 'live'
      ? PlaylistService.getByGroup('builtin:all', source.account.id).map(channelKey)
      : [];
    ParentalControlService.clearSourceRules(source.kind, source.account.id, channelKeys);
    this.render();
  }

  private pendingSuggestions(): GroupEntry[] {
    return this.groups.filter(group => group.suggested && !this.isGroupLocked(group));
  }

  private lockSuggested(): void {
    const groups = this.pendingSuggestions();
    if (!groups.length) return;
    ParentalControlService.setGroupsProtected(groups.map(groupTarget), true);
    this.render();
    this.focusColumn('group');
  }

  private async clearCurrentExceptions(): Promise<void> {
    const group = this.groups[this.groupIndex];
    if (!group) return;
    await this.loadItems(this.groupIndex);
    if (this.groups[this.groupIndex]?.key !== group.key) return;
    ParentalControlService.clearItemRules(this.items.map(itemTarget));
    this.render();
  }

  // Exceptions are item rules that differ from their group's lock; a stale
  // rule matching the group is harmless and doesn't count.
  private computeMixedGroups(): Set<string> {
    const locked = new Map(this.groups.map(group => [group.key, this.isGroupLocked(group)]));
    const mixed = new Set<string>();
    for (const [key, rule] of ParentalControlService.itemRuleEntries()) {
      const groupKey = this.memberGroups.get(key);
      if (groupKey !== undefined && locked.has(groupKey)
        && (rule === 'allow') === locked.get(groupKey)) {
        mixed.add(groupKey);
      }
    }
    return mixed;
  }

  private hasExceptions(group: GroupEntry): boolean {
    return this.mixedGroups.has(group.key);
  }

  private groupState(group: GroupEntry): string {
    if (this.hasExceptions(group)) {
      if (!group.members) return t('parental.partlyLocked');
      const locked = group.members.filter(member => this.isItemLocked(member, group)).length;
      return t('parental.lockedOf', { locked, total: group.members.length });
    }
    return t(this.isGroupLocked(group) ? 'parental.locked' : 'parental.notLocked');
  }

  private isGroupLocked(group: GroupEntry): boolean {
    return ParentalControlService.groupProtected(groupTarget(group));
  }

  private isItemLocked(item: ItemEntry, group: GroupEntry | undefined): boolean {
    return ParentalControlService.itemLocked(itemTarget(item), this.itemParents(item, group));
  }

  private itemParents(
    item: ItemEntry,
    group: GroupEntry | undefined,
  ): Array<LiveGroupTarget | CatalogCategoryTarget> {
    return item.parents ?? (group ? [groupTarget(group)] : []);
  }

  private render(): void {
    this.mixedGroups = this.computeMixedGroups();
    const currentGroup = this.groups[this.groupIndex];
    const tabs: Array<{ id: 'rules' | 'options'; label: string }> = [
      { id: 'rules', label: t('parental.tabLocks') },
      { id: 'options', label: t('parental.tabOptions') },
    ];
    const inItems = this.focusArea === 'item' && !!currentGroup;
    morph(this.container, html`
      <div class="parental-view">
        <header class="parental-header">
          <div class="parental-heading">
            <h2>${t('settings.parentalControls')}</h2>
            <div class="playlist-tabs parental-tabs" data-nav-container>
              ${tabs.map(tab => html`
                <div class="playlist-tab ${tab.id === this.tab ? 'active' : ''}"
                     data-focusable data-key="parental-tab:${tab.id}"
                     data-parental-tab="${tab.id}">${tab.label}</div>
              `)}
            </div>
          </div>
          ${this.renderAccount()}
        </header>
        ${this.tab === 'rules' ? this.renderRules(currentGroup) : this.renderOptions()}
        <div class="edit-hints parental-hints">
          ${this.tab === 'rules' ? html`
            ${okHint(t('parental.toggleLock'))}
            ${keyHint('red', inItems ? t('parental.lockAllIn', { name: currentGroup.name }) : t('parental.lockAll'),
              'parental:red', { 'data-parental-action': 'red' })}
            ${keyHint('green', inItems ? t('parental.unlockAllIn', { name: currentGroup.name }) : t('parental.unlockAll'),
              'parental:green', { 'data-parental-action': 'green' })}
            ${currentGroup && this.hasExceptions(currentGroup)
              ? keyHint('blue', t('parental.clearSeparate', { name: currentGroup.name }),
                'parental:blue', { 'data-parental-action': 'blue' })
              : ''}
          ` : ''}
          ${doneHint('parental:back', { 'data-parental-back': '' })}
        </div>
      </div>
    `);
    // morph() resets `class` from the template, dropping the nav highlight.
    this.nav.clearDetachedFocus();
    if (this.nav.focused) this.nav.focused.classList.add('focused');
    this.mountAccount();
  }

  // The slot stays mounted (hidden when unused) so the AccountSwitcher that
  // owns its DOM is created once.
  private renderAccount(): Safe {
    const current = this.tab === 'rules' ? this.currentAccount() : undefined;
    return html`
      <div class="parental-account ${current ? '' : 'hidden'}" data-nav-container>
        <span class="parental-account-name">${current?.name ?? ''}</span>
        <div class="parental-account-slot" data-key="parental-account-slot" data-morph-preserve
             data-focusable data-parental-avatar></div>
      </div>`;
  }

  private currentAccount(): PlaylistEntry | undefined {
    const accounts = this.xtreamAccounts();
    return accounts.find(account => account.id === this.xtreamId) ?? accounts[0];
  }

  private mountAccount(): void {
    const slot = this.container.querySelector<HTMLElement>('.parental-account-slot');
    if (!slot) return;
    if (!this.switcher) {
      this.switcher = new AccountSwitcher(slot, { onSelect: id => this.selectAccount(id) });
      this.switcher.init();
    }
    const current = this.tab === 'rules' ? this.currentAccount() : undefined;
    this.switcher.setAccounts(current ? this.xtreamAccounts() : [], current?.id ?? '');
    this.switcher.setFocused(!!current && this.nav.focused === slot);
  }

  private renderRules(currentGroup: GroupEntry | undefined): Safe {
    const kinds: Array<{ id: SourceKind; label: string }> = [
      { id: 'live', label: t('nav.live') },
      { id: 'vod', label: t('nav.movies') },
      { id: 'series', label: t('nav.series') },
    ];
    const playlists = this.sources
      .map((source, index) => ({ source, index }))
      .filter(({ source }) => source.kind === 'live');
    const groupRules = ParentalControlService.groupRuleKeys();
    const lockedGroups = this.groups.filter(group => this.isGroupLocked(group)).length;
    const groupLocked = !!currentGroup && this.isGroupLocked(currentGroup);
    const exceptions = currentGroup && !this.itemsLoading
      ? this.items.filter(item => this.isItemLocked(item, currentGroup) !== groupLocked).length
      : 0;
    return html`
      <div class="parental-toolbar">
        ${this.xtreamAccounts().length ? html`
          <div class="parental-kinds" data-nav-container>${
            toggleGroup('parental-kind', kinds.map(kind => ({ value: kind.id, label: kind.label })), this.kind)
          }</div>` : ''}
        ${this.groups.length ? html`
          <div class="parental-summary">${raw(LOCK_ICON)}<span>${
            t(this.kind === 'live' ? 'parental.lockedGroupsSummary' : 'parental.lockedCategoriesSummary',
              { count: lockedGroups, total: this.groups.length })}</span></div>`
          : ''}
      </div>
      <div class="parental-columns">
        ${this.kind === 'live' && playlists.length > 1
          ? this.column(t('settings.playlists'), html``, playlists.map(({ source, index }) => {
            const prefix = parentalTargetKey({
              kind: 'live-group',
              playlistId: source.account.id,
              groupKey: '',
            });
            const locked = groupRules.filter(key => key.startsWith(prefix)).length;
            const unreviewed = !ParentalControlService.sourceApproved('live', source.account.id);
            return html`
              <button class="parental-row ${index === this.sourceIndex ? 'active' : ''}"
                      data-focusable data-key="${source.key}" data-parental-source="${index}">
                <span>${source.account.name}</span>
                ${isSourceEnabled(source.account)
                  ? ''
                  : html`<small>${t('parental.sourceDisabled')}</small>`}
                <strong class="${locked || unreviewed ? 'is-locked' : ''}">${
                  unreviewed ? t('parental.locked')
                    : locked ? tp('parental.lockedCount', locked) : t('parental.notLocked')}</strong>
              </button>`;
          }), 'source')
          : ''}
        ${this.column(
          t(this.kind === 'live' ? 'common.groups' : 'parental.categories'),
          this.groupsLoading || !this.groups.length
            ? html``
            : html`<span class="parental-column-note">${this.groups.length}</span>`,
          this.groupsLoading
            ? [html`<div class="parental-empty">${t('common.loading')}</div>`]
            : this.groups.length
              ? [this.suggestionRow(), ...this.groups.map((group, index) => {
                const locked = this.isGroupLocked(group);
                return html`
                <button class="parental-row ${index === this.groupIndex ? 'active' : ''}"
                        data-focusable data-key="${group.key}"
                        data-parental-group="${index}">
                  ${raw(lockBadge(locked ? 'locked' : 'unlocked'))}
                  <span>${group.name}</span>
                  ${group.count === null ? '' : html`<small>${group.count}</small>`}
                  ${group.suggested && !locked
                    ? html`<em class="parental-suggested">${t('parental.suggested')}</em>`
                    : ''}
                  <strong class="${locked || this.hasExceptions(group) ? 'is-locked' : ''}">${
                    this.groupState(group)}</strong>
                </button>`;
              })]
              : [html`<div class="parental-empty">${t('parental.noGroups')}</div>`],
          'group')}
        ${this.column(
          currentGroup?.name ?? '',
          currentGroup && !this.itemsLoading ? html`
            <span class="parental-column-note">${
              t(groupLocked ? 'parental.locked' : 'parental.notLocked')}</span>
            ${exceptions
              ? html`<span class="parental-column-note">${tp('parental.setSeparatelyCount', exceptions)}</span>`
              : ''}` : html``,
          this.itemsLoading
            ? [html`<div class="parental-empty">${t('common.loading')}</div>`]
            : this.items.length
              ? this.items.map((item, index) => {
                const locked = this.isItemLocked(item, currentGroup);
                return html`
                <button class="parental-row" data-focusable data-key="${item.key}"
                        data-parental-item="${index}">
                  ${raw(lockBadge(locked ? 'locked' : 'unlocked'))}
                  <span>${item.name}</span>
                  ${currentGroup && locked !== groupLocked
                    ? html`<em class="parental-exception">${t('parental.setSeparately')}</em>`
                    : ''}
                  <strong class="${locked ? 'is-locked' : ''}">${
                    t(locked ? 'parental.locked' : 'parental.notLocked')}</strong>
                </button>`;
              })
              : [html`<div class="parental-empty">${t('parental.selectGroup')}</div>`],
          'item')}
      </div>`;
  }

  private renderOptions(): Safe {
    const config = ParentalControlService.snapshot();
    const enabled = ParentalControlService.enabled;
    const conceal = [
      { value: 'show-locked', label: t('parental.showWithLock') },
      { value: 'hide-locked', label: t('parental.hide') },
    ];
    const durations: Array<{ value: ParentalUnlockDuration; label: string }> = [
      { value: 'once', label: t('parental.askEveryTime') },
      { value: '5-minutes', label: t('parental.askAfter5') },
      { value: '15-minutes', label: t('parental.askAfter15') },
      { value: 'until-backgrounded', label: t('parental.askAfterLeaving') },
    ];
    return html`
      <div class="parental-options-pane ${enabled ? '' : 'parental-options-off'}" data-nav-container>
        <section class="parental-options-section">
          <div class="settings-item">
            <div class="settings-item-title">${t('parental.useControls')}</div>
            ${sourceToggle(enabled)}
            <div class="settings-item-hint">${
              t(enabled ? 'parental.turnOffHint' : 'parental.settingsHint')}</div>
          </div>
        </section>
        <section class="parental-options-section parental-options-rules">
          <div class="settings-item">
            <div class="settings-item-title">${t('parental.lockedInLists')}</div>
            ${toggleGroup('parental-conceal', conceal, config.concealMode)}
            <div class="settings-item-hint">${t('parental.lockedInListsHint')}</div>
          </div>
          <div class="settings-item">
            <div class="settings-item-title">${t('parental.askAgain')}</div>
            ${toggleGroup('parental-duration', durations, config.unlockDuration,
              config.concealMode === 'hide-locked' ? ['once'] : [])}
            <div class="settings-item-hint">${t('parental.askAgainHint')}</div>
          </div>
        </section>
        <section class="parental-options-section parental-options-actions">
          ${enabled ? html`
          <button class="btn btn-secondary" data-focusable data-key="parental-change-pin"
                  data-parental-change-pin>${t('parental.changePin')}</button>` : ''}
          <button class="btn btn-danger" data-focusable data-key="parental-remove-all"
                  data-parental-remove-all>${t('parental.removeAll')}</button>
        </section>
      </div>`;
  }

  private suggestionRow(): Safe {
    const count = this.pendingSuggestions().length;
    if (!count) return html``;
    return html`
      <button class="parental-row parental-suggest-row" data-focusable
              data-key="parental-suggest" data-parental-suggest>
        ${raw(LOCK_ICON)}<span>${t('parental.lockSuggested', { count })}</span>
      </button>`;
  }

  private column(title: string, note: Safe, rows: Safe[], kind: string): Safe {
    return html`
      <section class="parental-column parental-column-${kind}" data-nav-container
               data-nav-enter="last-focused">
        <header class="parental-column-head"><h3>${title}</h3>${note}</header>
        <div class="parental-list">${rows}</div>
      </section>`;
  }

  // Left/Right always crosses to the neighboring column — geometric nav would
  // jump to the tabs when the next column is shorter than the focused row.
  private hopColumn(direction: 'left' | 'right'): boolean {
    const from = this.nav.focused;
    const column = from?.closest('.parental-column');
    if (!from || !column) return false;
    const next = direction === 'left' ? column.previousElementSibling : column.nextElementSibling;
    if (!next?.classList.contains('parental-column')) return false;
    const rows = Array.from(next.querySelectorAll<HTMLElement>('[data-focusable]'));
    if (!rows.length) return false;
    const center = (el: HTMLElement): number => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    const y = center(from);
    const nearest = rows.reduce((best, row) =>
      Math.abs(center(row) - y) < Math.abs(center(best) - y) ? row : best);
    this.nav.focus(rows.find(row => row.classList.contains('active')) ?? nearest);
    return true;
  }

  private focusColumn(kind: 'group' | 'item'): void {
    setTimeout(() => {
      const selector = kind === 'group' ? '[data-parental-group]' : '[data-parental-item]';
      const target = this.container.querySelector<HTMLElement>(selector);
      if (target) this.nav.focus(target);
    }, 0);
  }

  private focusSelector(selector: string): void {
    setTimeout(() => {
      const target = this.container.querySelector<HTMLElement>(selector);
      if (target) this.nav.focus(target);
    }, 0);
  }

  private focusKey(key: string): void {
    setTimeout(() => {
      const target = Array.from(
        this.container.querySelectorAll<HTMLElement>('[data-key]'),
      ).find(element => element.dataset.key === key);
      if (target) this.nav.focus(target);
    }, 0);
  }
}
