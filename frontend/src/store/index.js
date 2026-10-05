import { create } from 'zustand';
import { api } from '../utils/api.js';
import { mergeCountSnapshots, adjustCountPending, expireCountPending, settleCountPending, displayCountSnapshot, mergeFolderSnapshots } from '../utils/countSnapshots.js';
import { resolveSelectedAccount, pruneFolders } from '../utils/accountScope.js';
import { withProvisionalHealth } from '../utils/accountHealth.js';
import { applyTheme, applyCustomCss, getInitialTheme, resolveSystemTheme, readThemeFollowsSystem, writeThemeFollowsSystem } from '../themes.js';
import { applyFontSet, applyFontSize, effectiveFontSet, isRetroFont, THEME_FONT, DEFAULT_FONT_SIZE } from '../fonts.js';
import { applyLayout, normalizeLayout } from '../layouts.js';
import { DEFAULT_AI_ACTIONS } from '../aiActions.js';
import { needsLanguageChoice, normalizeLanguage } from '../utils/language.js';
import { abortAllRuns } from '../aiRuns.js';
import {
  removeGtdThreadFromSections,
  restoreGtdThreadRemoval,
  setGtdThreadReadInSections,
  snapshotGtdThreadRemoval,
  appendMessagesByIdentity,
  dedupeByIdentity,
  missingByIdentity,
} from '../utils/gtd.js';
import { applyGtdRemovalGuard } from '../utils/pendingGtdRemovals.js';
import { DEFAULT_HOVER_ACTIONS, sanitizeHoverActionSet } from '../utils/hoverActions.js';
import { clampRightSidebarWidth } from '../utils/rightSidebar.js';
import { pinAccountIds, prunePinnedIds, unpinAccountIds } from '../utils/accountOrder.js';
import { threadCacheKey } from '../utils/threadKey.js';
import {
  cacheFolderOrderFromPreferences,
  mergeFolderOrder,
  readFolderOrder,
} from './folderOrder.js';
import { removeThreadCacheEntry } from '../utils/threadedArchive.js';
import i18n from '../i18n.js';
import { createPrefSaveQueue } from '../utils/prefSaveQueue.js';

// Accumulate rapid preference changes and flush at most once per second. The queue itself
// lives in prefSaveQueue.js so its behaviour is testable without a network or a DOM.
const _prefQueue = createPrefSaveQueue({
  save: (prefs) => api.savePreferences(prefs),
  saveOnExit: (prefs) => api.savePreferencesOnExit(prefs),
  delayMs: 1000,
  onError: (err, keys) => {
    // Previously `.catch(() => {})`. A preference that failed to save said nothing and then
    // reverted on the next load, when loadPreferences overwrote localStorage with the older
    // server value. Naming the keys makes that diagnosable instead of a mystery.
    console.error(`Failed to save preference(s): ${keys.join(', ')}`, err?.message || err);
  },
});

function schedulePrefSave(prefs) {
  _prefQueue.schedule(prefs);
}

// Applies whichever theme is actually going into effect right now — a hand pick, or the
// system-resolved theme while "как в системе" is on — plus the retro-font fallout a theme
// switch can trigger. Shared by setTheme, setThemeFollowsSystem, loadPreferences and the
// OS-change listener below, so there is exactly one place that keeps the font picker honest
// and effectiveTheme (what a settings UI should highlight as "currently showing") in sync.
function applyThemeAndFont(get, set, theme) {
  applyTheme(theme); // keep CSS vars + favicon in sync
  set({ effectiveTheme: theme });
  // If a retro font was left as the saved choice, a non-retro theme must not keep it —
  // normalise the stored choice so it can't "stick" (and the font picker stays honest).
  if (!THEME_FONT[theme] && isRetroFont(get().fontSet)) {
    localStorage.setItem('mailexpert_font', 'default');
    set({ fontSet: 'default' });
    schedulePrefSave({ font: 'default' });
  }
  // Retro themes bring their own font; other themes fall back to the saved choice.
  applyFontSet(effectiveFontSet(theme, get().fontSet));
}

// Live-follows the OS light/dark setting while themeFollowsSystem is on — a single
// matchMedia listener at module scope (not a component effect), so it also works before
// sign-in and isn't torn down/recreated by every component that reads theme state.
// Added when following turns on, removed when it turns off ("cleaned up when turned off").
let _systemThemeMql = null;
let _systemThemeListener = null;
function watchSystemTheme(follows) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (follows) {
    if (_systemThemeMql) return; // already watching
    _systemThemeMql = window.matchMedia('(prefers-color-scheme: dark)');
    _systemThemeListener = () => {
      if (!useStore.getState().themeFollowsSystem) return; // stale event after a race with turning off
      applyThemeAndFont(useStore.getState, useStore.setState, resolveSystemTheme());
    };
    _systemThemeMql.addEventListener('change', _systemThemeListener);
  } else if (_systemThemeMql) {
    _systemThemeMql.removeEventListener('change', _systemThemeListener);
    _systemThemeMql = null;
    _systemThemeListener = null;
  }
}

// Drop any queued preference flush. Called on logout / account switch: a pending debounce
// belongs to the previous user's session, so letting it fire would either save into the new
// user's account or hit a dead session (401). The prefs are already applied locally; only the
// deferred network write is discarded.
function cancelPendingPrefSave() {
  _prefQueue.cancel();
}

// Write anything still queued before the page can go away. Without this a setting changed
// inside the debounce window was lost outright, and because it had already been written to
// localStorage the UI looked correct until the next load hydrated the older server value
// back over it, so the setting appeared to revert on its own.
//
// pagehide plus visibilitychange rather than beforeunload: beforeunload does not fire
// reliably on mobile, where the page is frozen or discarded instead. visibilitychange also
// covers tab switches and app backgrounding, which simply means the write lands sooner.
if (typeof window !== 'undefined') {
  const flushOnExit = () => _prefQueue.flush({ exiting: true });
  window.addEventListener('pagehide', flushOnExit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnExit();
  });
}

// GTD sections fetch coordination. A monotonic seq guards against stale
// responses landing after a newer context switch; the timer debounces the
// WS-driven refetch (gtd_sections_updated can fire several times per tick).
let _gtdSectionsSeq = 0;
let _gtdFetchTimer = null;

function readGtdCollapsedSections() {
  try {
    const raw = JSON.parse(localStorage.getItem('mailexpert_gtd_collapsed_sections') || 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch { /* fall through to default */ }
  // Someday is collapsed by default — lowest-priority section, out of the way
  // until the user wants it.
  return { someday: true };
}

let pendingCountTimer;
function expirePendingCounts() {
  clearTimeout(pendingCountTimer);
  const deadlines = Object.values(useStore.getState().pendingCounts).map(p => p.expiresAt);
  if (!deadlines.length) { pendingCountTimer = null; return; }
  pendingCountTimer = setTimeout(() => {
    pendingCountTimer = null;
    const state = useStore.getState();
    if (state.isLocked) return;
    const pending = expireCountPending(state.pendingCounts);
    useStore.setState({ pendingCounts: pending,
      unreadCounts: displayCountSnapshot(state.serverUnreadCounts, pending, state.accounts) });
    if (Object.keys(pending).length) expirePendingCounts();
    window.dispatchEvent(new CustomEvent('mailexpert:counts_refresh'));
  }, Math.max(1, Math.min(...deadlines) - Date.now()));
}

// Mail state that belongs to whoever is signed in. Dropped when the screen locks and when the
// identity changes, so neither the lock overlay nor the next user's session can show it.
function privateMailState() {
  return {
    serverUnreadCounts: { total: 0, byAccount: {}, snapshots: {} }, pendingCounts: {},
    messages: [], searchResults: [], searchQuery: '',
    accounts: [], accountsReady: false,
    folders: {}, selectedMessageId: null,
    unreadCounts: { total: 0, byAccount: {} },
    notifications: [], threadMessages: {}, expandedThreadId: null,
    backfillProgress: {},
    gtdSections: null, categoryCounts: {}, activeGtdTab: null,
  };
}

export const useStore = create((set, get) => ({
  // Auth
  user: null,
  setUser: (user) => {
    // On a real identity change (login, logout, account switch) drop any queued preference
    // flush so the previous user's debounce can't save into the new/absent session.
    if (get().user?.id !== user?.id) {
      cancelPendingPrefSave();
      // Background AI runs (#428) belong to the previous session; never let them
      // finish and persist a result after the identity changed. Selecting another
      // mailbox of the same user is not an identity change and keeps runs alive.
      abortAllRuns();
      clearTimeout(pendingCountTimer);
      pendingCountTimer = null;
    }
    // One person leaves, another (or nobody) takes the tab: the sidebar's per-user view (pins, the
    // order switch, which mailboxes are expanded) must not be inherited. The first sign-in of a
    // page load (nobody -> someone) keeps what this browser cached for that person's sake.
    const leaving = get().user != null && get().user.id !== user?.id;
    if (leaving) {
      for (const key of ['mailexpert_pinned_accounts', 'mailexpert_sort_accounts_by_latest', 'mailexpert_expanded_accounts']) {
        localStorage.removeItem(key);
      }
    }
    set(state => ({
      user,
      ...(leaving ? { pinnedAccounts: [], sortAccountsByLatest: true, expandedAccounts: {} } : {}),
      ...(state.user?.id !== user?.id ? {
        // An expired session shows the sign-in screen without a page reload, so the next
        // person to sign in on this tab must not inherit the previous user's mail or draft.
        ...privateMailState(),
        composing: false, composeData: null, messageWindows: [], lastViewedMessageId: null,
        queuedCompose: null, showScheduled: false, scheduledSummary: { count: 0, failed: 0 },
        unreadCounts: { total: 0, byAccount: {}, snapshots: {}, complete: false },
        senderFaviconsLoaded: false,
        senderFavicons: false,
        senderFaviconsSaving: false,
      } : {}),
    }));
  },
  updateUser: (updates) => set(state => ({ user: state.user ? { ...state.user, ...updates } : state.user })),

  // Plugins an administrator switched on for the whole panel (GET /api/plugins, backed by
  // system_settings.enabled_plugins). Loaded with the preferences after sign-in; only an
  // administrator changes it, via setPluginEnabled (the Plugins settings tab). Independent of a
  // plugin's own per-account config; a plugin's UI gates on membership here (e.g. GTD's
  // gtdActiveForContext requires 'gtd' to be present).
  enabledPlugins: [],
  loadEnabledPlugins: async () => {
    const userId = get().user?.id;
    try {
      const list = await api.plugins.list();
      if (get().user?.id !== userId) return;
      set({ enabledPlugins: Array.isArray(list) ? list.filter(p => p?.enabled === true).map(p => p.id) : [] });
    } catch {
      // Leave the current set: a failed read never switches a plugin's UI off mid-session.
    }
  },
  setPluginEnabled: async (id, enabled) => {
    await api.plugins.setEnabled(id, enabled);
    set(state => {
      const next = new Set(state.enabledPlugins);
      if (enabled) next.add(id); else next.delete(id);
      return { enabledPlugins: [...next] };
    });
  },

  // Todoist integration status (persisted across page loads via localStorage)
  todoistConnected: localStorage.getItem('mailexpert_todoist_connected') === '1',
  setTodoistConnected: (connected) => {
    if (connected) localStorage.setItem('mailexpert_todoist_connected', '1');
    else localStorage.removeItem('mailexpert_todoist_connected');
    set({ todoistConnected: connected });
  },

  // Lock screen
  isLocked: localStorage.getItem('mailexpert_locked') === '1',
  setLocked: (locked) => {
    if (locked) {
      const { selectedMessageId } = get();
      if (selectedMessageId) localStorage.setItem('mailexpert_locked_message', selectedMessageId);
      localStorage.setItem('mailexpert_locked', '1');
      clearTimeout(pendingCountTimer);
      pendingCountTimer = null;
      // Locking is the user stepping away: a background AI run must not finish and
      // land its result in this device's cache behind the lock screen.
      abortAllRuns();
      set({ ...privateMailState(), isLocked: true });
    } else {
      const restoredMessageId = localStorage.getItem('mailexpert_locked_message') || null;
      localStorage.removeItem('mailexpert_locked_message');
      localStorage.removeItem('mailexpert_locked');
      set({ isLocked: false, selectedMessageId: restoredMessageId });
    }
  },
  // Lock now: tell the server (it then 423s the API until unlocked), then drop into
  // the lock overlay locally. Lock the UI even if the server call fails (#235).
  lockScreen: () => {
    // Lock the UI immediately (never block on the network), then enforce server-side.
    get().setLocked(true);
    api.lock().catch(() => {});
  },
  autoLockMinutes: 0,
  setAutoLockMinutes: (m) => {
    const v = [0, 1, 5, 15, 30].includes(Number(m)) ? Number(m) : 0;
    set({ autoLockMinutes: v });
    schedulePrefSave({ autoLockMinutes: String(v) });
  },

  // Accounts
  accounts: [],
  accountsReady: false, // true once the initial getAccounts() call has resolved
  setAccounts: (accounts) => {
    // Every refresh of the account list is also the moment to notice that the selected
    // account has been deleted. Without this the client stays pinned to a dead id forever,
    // because localStorage restores it on every load. See utils/accountScope.js.
    const previous = get().selectedAccountId;
    const selectedAccountId = resolveSelectedAccount(accounts, previous);
    const reselected = selectedAccountId !== previous;
    if (reselected) {
      // Mirror setSelectedAccount's persistence so the fallback survives a reload.
      localStorage.setItem('mailexpert_selected_account', '');
      localStorage.setItem('mailexpert_selected_folder', 'INBOX');
    }
    set(state => ({
      accounts, accountsReady: true, selectedAccountId,
      ...(reselected ? { selectedFolder: 'INBOX' } : {}),
      folders: pruneFolders(state.folders, accounts),
      unreadCounts: displayCountSnapshot(state.serverUnreadCounts, state.pendingCounts, accounts),
    }));
  },
  updateAccount: (id, updates) => set(state => {
    // WebSocket account events patch sync_error here; recompute a provisional health code
    // until the next GET /api/accounts returns the server's (see utils/accountHealth.js).
    const accounts = state.accounts.map(a => a.id === id ? withProvisionalHealth(a, updates) : a);
    return { accounts, unreadCounts: displayCountSnapshot(state.serverUnreadCounts, state.pendingCounts, accounts) };
  }),
  // Sidebar mailbox filter. In memory only: not persisted and not sent to the server,
  // so each manager sharing the login keeps their own filter in their own browser.
  accountFilter: '',
  setAccountFilter: (accountFilter) => set({ accountFilter: typeof accountFilter === 'string' ? accountFilter : '' }),

  // Navigation
  selectedAccountId: localStorage.getItem('mailexpert_selected_account') || null, // '' stored as null
  selectedFolder: localStorage.getItem('mailexpert_selected_folder') || 'INBOX',
  messagesRefreshToken: 0, // incremented on every nav click so the effect always re-fires
  setSelectedAccount: (accountId, folder = 'INBOX') => {
    localStorage.setItem('mailexpert_selected_account', accountId ?? '');
    localStorage.setItem('mailexpert_selected_folder', folder);
    return set(state => {
      // #221: auto-close a folder-scoped search when navigating to a different
      // folder/account. A scoped search (a specific account with "Search all folders"
      // off) targets the current folder, so its results are stale once you leave it;
      // an all-folders search spans everything and is left intact. Clearing only
      // searchQuery lets the search effect tear down the rest of the search state,
      // exactly like the in-box clear (X) button does.
      const navChanged = state.selectedAccountId !== accountId || state.selectedFolder !== folder;
      const wasScopedSearch = !!state.selectedAccountId && !state.searchAllFolders && !!state.searchQuery.trim();
      return {
        selectedAccountId: accountId,
        selectedFolder: folder,
        selectedMessageId: null,
        messages: [],
        messagesOffset: 0,
        hasMoreMessages: true,
        messagesRefreshToken: state.messagesRefreshToken + 1,
        expandedThreadId: null,
        threadMessages: {},
        showContacts: false,
        ...(navChanged && wasScopedSearch ? { searchQuery: '' } : {}),
      };
    });
  },


  // Messages
  messages: [],
  // Dedupe by delivery on every raw list load: one email can arrive as two rows (a received copy
  // plus its Sent twin, or an INBOX copy plus its label-folder copy) and must render once,
  // matching isSelectedRow's identity model (#378). Copies in two different accounts are separate
  // mail and both render (#476). appendMessages/restore dedupe on their own paths; this covers the
  // initial/refresh/page loads that replace wholesale.
  setMessages: (messages) => set({ messages: dedupeByIdentity(messages) }),
  appendMessages: (newMessages) => set(state => {
    // Merge by stable identity (Message-ID when present, else id): a same-id row is dropped so the
    // existing copy keeps any optimistic local-only fields a refresh lost (unread_count, etc.),
    // while a reindexed message (same Message-ID, new id after a purge+reinsert) replaces its stale
    // row in place instead of appearing as a duplicate. See appendMessagesByIdentity.
    const messages = appendMessagesByIdentity(state.messages, newMessages);
    return messages === state.messages ? {} : { messages };
  }),
  updateMessage: (id, updates) => set(state => {
    const apply = (m) => m.id === id ? { ...m, ...updates } : m;
    const threadMessages = Object.fromEntries(
      Object.entries(state.threadMessages).map(([tid, msgs]) => [tid, msgs.map(apply)])
    );
    // Resync the parent thread row's aggregate read state only when a sub-message was
    // updated. Sub-messages live exclusively in threadMessages, not in the main list.
    // Resyncing on direct thread-row updates would read stale sub-messages and revert
    // keyboard mark-read and setMessagesReadState changes.
    const inMainList = state.messages.some(m => m.id === id);
    const messages = state.messages.map(m => {
      const updated = apply(m);
      if (inMainList) return updated;
      const subs = threadMessages[threadCacheKey(m)];
      if (!subs) return updated;
      const unread_count = subs.filter(s => !s.is_read).length;
      return { ...updated, unread_count, is_read: unread_count === 0 };
    });
    return { messages, searchResults: state.searchResults.map(apply), threadMessages };
  }),
  removeMessage: (id) => set(state => ({
    messages: state.messages.filter(m => m.id !== id),
    searchResults: state.searchResults.filter(m => m.id !== id),
    selectedMessageId: state.selectedMessageId === id ? null : state.selectedMessageId,
  })),
  // Remove many messages in a single state update. Bulk triage (e.g. archiving ~40 rows)
  // otherwise calls removeMessage once per id, firing one store update — and, in a
  // non-virtualized list, one re-render — each, which stalls the UI. This collapses them
  // into one filter pass and one update.
  removeMessages: (ids) => set(state => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) return {};
    return {
      messages: state.messages.filter(m => !idSet.has(m.id)),
      searchResults: state.searchResults.filter(m => !idSet.has(m.id)),
      selectedMessageId: idSet.has(state.selectedMessageId) ? null : state.selectedMessageId,
    };
  }),
  restoreMessages: (msgs) => set(state => {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    const sort = arr => [...arr].sort((a, b) => new Date(b.date) - new Date(a.date));
    // Deduplicate against both the main list and searchResults by stable identity (Message-ID when
    // present, else id): if the message is already present — including re-added by a network
    // refresh under a regenerated id (matched via Message-ID) — skip it. The local copy carries the
    // freshest optimistic state, so we prefer it over the server view. See missingByIdentity.
    const missing = missingByIdentity(state.messages, list);
    if (missing.length === 0 && !state.searchQuery.trim()) return {};
    const missingFromSearch = missingByIdentity(state.searchResults, list);
    return {
      messages: missing.length ? sort([...state.messages, ...missing]) : state.messages,
      searchResults: state.searchQuery.trim() && missingFromSearch.length
        ? sort([...state.searchResults, ...missingFromSearch])
        : state.searchResults,
    };
  }),
  messagesOffset: 0,
  setMessagesOffset: (offset) => set({ messagesOffset: offset }),
  messagesTotal: 0,
  setMessagesTotal: (total) => set({ messagesTotal: total }),
  hasMoreMessages: true,
  setHasMoreMessages: (v) => set({ hasMoreMessages: v }),

  // Selected message
  selectedMessageId: null,
  lastViewedMessageId: null,
  setSelectedMessage: (id) => set(id ? { selectedMessageId: id, lastViewedMessageId: id } : { selectedMessageId: null }),

  // Server snapshots are retained separately from a bounded optimistic window.
  serverUnreadCounts: { total: 0, byAccount: {}, snapshots: {} },
  pendingCounts: {},
  unreadCounts: { total: 0, byAccount: {}, snapshots: {}, complete: false },
  setUnreadCounts: (counts) => set(state => {
    if (state.isLocked) return {};
    const server = mergeCountSnapshots(state.serverUnreadCounts, counts);
    // Retire windows the server has now had a chance to observe, rather than waiting for the
    // backstop to expire them: the timer alone reverted the badge ~1-2s before the replacement
    // observation landed, which read as the count bouncing back on every read or move.
    const pending = settleCountPending(state.pendingCounts, server);
    if (!Object.keys(pending).length) { clearTimeout(pendingCountTimer); pendingCountTimer = null; }
    return { serverUnreadCounts: server, pendingCounts: pending,
      unreadCounts: displayCountSnapshot(server, pending, state.accounts) };
  }),
  adjustUnread: (accountId, delta) => {
    set(state => {
      if (state.isLocked) return {};
      const displayed = displayCountSnapshot(state.serverUnreadCounts, state.pendingCounts, state.accounts);
      const pending = adjustCountPending(state.pendingCounts, displayed, accountId, delta);
      return { pendingCounts: pending,
        unreadCounts: displayCountSnapshot(state.serverUnreadCounts, pending, state.accounts) };
    });
    // Do not reset this timer on subsequent clicks: continuous activity cannot freeze counts.
    if (!pendingCountTimer) expirePendingCounts();
  },
  decrementUnread: (accountId, count = 1) => get().adjustUnread(accountId, -count),
  incrementUnread: (accountId, count = 1) => get().adjustUnread(accountId, count),

  // Folder badges always show observed server values. Row-level read/move optimism
  // remains immediate; aggregate thread estimates must not overwrite these snapshots.
  folders: {},
  setFolders: (accountId, folders) => set(state => state.isLocked ? {} : ({
    folders: { ...state.folders, [accountId]: mergeFolderSnapshots(state.folders[accountId], folders) }
  })),

  // UI state
  sidebarCollapsed: localStorage.getItem('mailexpert_sidebar_collapsed') === 'true',
  toggleSidebar: () => set(state => {
    const next = !state.sidebarCollapsed;
    localStorage.setItem('mailexpert_sidebar_collapsed', String(next));
    return { sidebarCollapsed: next };
  }),
  sidebarWidth: (() => {
    const n = parseInt(localStorage.getItem('mailexpert_sidebar_width'));
    // 280 leaves room for a mailbox name and most addresses at the default 110% scale.
    return (n >= 160 && n <= 400) ? n : 280;
  })(),
  setSidebarWidth: (w) => {
    localStorage.setItem('mailexpert_sidebar_width', String(w));
    set({ sidebarWidth: w });
    schedulePrefSave({ sidebarWidth: String(w) });
  },
  isSidebarResizing: false,
  setIsSidebarResizing: (v) => set({ isSidebarResizing: v }),
  pageSize: parseInt(localStorage.getItem('mailexpert_page_size')) || 50,
  setPageSize: (size) => {
    localStorage.setItem('mailexpert_page_size', String(size));
    set({ pageSize: size });
    schedulePrefSave({ pageSize: String(size) });
  },
  scrollMode: localStorage.getItem('mailexpert_scroll_mode') || 'infinite',
  setScrollMode: (mode) => {
    localStorage.setItem('mailexpert_scroll_mode', mode);
    set({ scrollMode: mode });
    schedulePrefSave({ scrollMode: mode });
  },
  // When true, search spans every folder of the selected mailbox(es) instead of just the
  // current one (per device). Defaults ON: the owner wants search to cover the whole
  // mailbox unless narrowed, so a stored value is only ever the opt-OUT ('0') — no stored
  // value means "on", which is also what a fresh install/device gets.
  searchAllFolders: localStorage.getItem('mailexpert_search_all_folders') !== '0',
  setSearchAllFolders: (v) => {
    if (v) localStorage.removeItem('mailexpert_search_all_folders');
    else localStorage.setItem('mailexpert_search_all_folders', '0');
    set({ searchAllFolders: v });
  },
  swipeActions: (() => {
    try {
      return JSON.parse(localStorage.getItem('mailexpert_swipe_actions') || 'null') || { left: 'archive', right: 'markRead' };
    } catch {
      return { left: 'archive', right: 'markRead' };
    }
  })(),
  setSwipeAction: (direction, action) => set(state => {
    const next = { ...state.swipeActions, [direction]: action };
    localStorage.setItem('mailexpert_swipe_actions', JSON.stringify(next));
    schedulePrefSave({ swipeActions: next });
    return { swipeActions: next };
  }),
  // Install-wide message sync interval in seconds, from GET /auth/preferences. Only MailApp's
  // refresh fallback while the WebSocket is down reads it; admins change it in security settings.
  syncInterval: 60,
  notificationSound: localStorage.getItem('mailexpert_notification_sound') || 'tritone',
  setNotificationSound: (sound) => {
    localStorage.setItem('mailexpert_notification_sound', sound);
    set({ notificationSound: sound });
    schedulePrefSave({ notificationSound: sound });
  },
  customSoundDataUrl: localStorage.getItem('mailexpert_custom_sound') || null,
  setCustomSoundDataUrl: (dataUrl) => {
    if (dataUrl) {
      localStorage.setItem('mailexpert_custom_sound', dataUrl);
    } else {
      localStorage.removeItem('mailexpert_custom_sound');
    }
    set({ customSoundDataUrl: dataUrl });
  },
  composing: false,
  composeData: null,
  // Desktop-only minimize state for the single global composer (#compose-minimize-restore).
  composeMinimized: false,
  openCompose: (data = null) => set(state => {
    // Reopening while a composer is already up: if it's minimized, restore
    // + focus it instead of discarding the in-progress draft underneath,
    // mirroring how openMessageWindow re-focuses an existing window below.
    if (state.composing && state.composeMinimized) {
      return { composeMinimized: false };
    }
    return { composing: true, composeData: data, composeMinimized: false };
  }),
  setComposeMinimized: (minimized) => set({ composeMinimized: minimized }),
  closeCompose: () => set({ composing: false, composeData: null, composeMinimized: false }),

  // Detached message windows (#219): floating, draggable/resizable in-app windows
  // that each show one message via a MessagePane instance. Desktop-only; mounted by
  // WindowLayer. `_winSeq` is a monotonic counter serving as both a unique id source
  // and the z-order stamp (higher = on top / more recently focused).
  messageWindows: [],
  _winSeq: 0,
  openMessageWindow: (messageId) => set(state => {
    const seq = state._winSeq + 1;
    // Re-opening a message that already has a window focuses + un-minimizes it
    // rather than spawning a duplicate.
    if (state.messageWindows.some(w => w.messageId === messageId)) {
      return {
        _winSeq: seq,
        messageWindows: state.messageWindows.map(w =>
          w.messageId === messageId ? { ...w, minimized: false, z: seq } : w),
      };
    }
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const w = Math.min(660, Math.max(360, vw - 80));
    const h = Math.min(740, Math.max(280, vh - 80));
    // Cascade each new window down-right so they don't stack exactly on top.
    const cascade = (state.messageWindows.length % 6) * 28;
    const x = Math.max(12, Math.min(vw - w - 12, Math.round((vw - w) / 2) - 80 + cascade));
    const y = Math.max(12, Math.min(vh - h - 12, 72 + cascade));
    return {
      _winSeq: seq,
      messageWindows: [...state.messageWindows, { winId: `mw-${seq}`, messageId, x, y, w, h, z: seq, minimized: false }],
    };
  }),
  closeMessageWindow: (winId) => set(state => ({
    messageWindows: state.messageWindows.filter(w => w.winId !== winId),
  })),
  focusMessageWindow: (winId) => set(state => {
    const seq = state._winSeq + 1;
    return {
      _winSeq: seq,
      messageWindows: state.messageWindows.map(w => w.winId === winId ? { ...w, z: seq } : w),
    };
  }),
  setMessageWindowMinimized: (winId, minimized) => set(state => {
    const seq = state._winSeq + 1;
    return {
      _winSeq: seq,
      // Restoring (minimized=false) also brings the window to the front.
      messageWindows: state.messageWindows.map(w =>
        w.winId === winId ? { ...w, minimized, z: minimized ? w.z : seq } : w),
    };
  }),
  updateMessageWindowRect: (winId, rect) => set(state => ({
    messageWindows: state.messageWindows.map(w => w.winId === winId ? { ...w, ...rect } : w),
  })),
  closeAllMessageWindows: () => set({ messageWindows: [] }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  isSearching: false,
  setIsSearching: (v) => set({ isSearching: v }),
  searchResults: [],
  setSearchResults: (r) => set({ searchResults: r }),

  // Loading
  loadingMessages: false,
  setLoadingMessages: (v) => set({ loadingMessages: v }),

  // Notifications
  notifications: [],
  addNotification: (n) => set(state => ({
    notifications: [{ ...n, id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` }, ...state.notifications].slice(0, 5)
  })),
  removeNotification: (id) => set(state => ({
    notifications: state.notifications.filter(n => n.id !== id)
  })),

  // Admin panel
  showAdmin: false,
  adminTab: 'accounts', // a TABS id of AdminPanel.jsx: 'accounts' | 'appearance' | 'integrations' | 'mail-node' | 'users' | ...
  // Closing the settings also drops a request still waiting for the (lazy-loaded) panel to take it,
  // so it cannot fire later and open a view nobody asked for.
  setShowAdmin: (v) => set(v ? { showAdmin: true } : { showAdmin: false, addAccountRequested: false, accountSettingsRequested: null }),
  setAdminTab: (t) => set({ adminTab: t }),
  // Set by the sidebar's "Add account" item; the accounts tab opens its add view and clears it.
  addAccountRequested: false,
  openAddAccount: () => set({ showAdmin: true, adminTab: 'accounts', addAccountRequested: true }),
  clearAddAccountRequest: () => set({ addAccountRequested: false }),
  // Set by the sidebar's "Account settings" item with the account's id: the accounts tab opens
  // that account's own settings view (the edit form) and clears it. Same hand-off as above, so
  // the target survives the tab not being mounted yet.
  accountSettingsRequested: null,
  openAccountSettings: (accountId) => set({ showAdmin: true, adminTab: 'accounts', accountSettingsRequested: accountId || null }),
  clearAccountSettingsRequest: () => set({ accountSettingsRequested: null }),

  // Letters waiting to be sent (undo window, send later, kept after a failure): the Scheduled
  // dialog, the sidebar's count of them (failed: this user's letters that were not sent), and a
  // letter given back by an undo or edit while another composer was open, opened once it closes.
  showScheduled: false,
  setShowScheduled: (v) => set({ showScheduled: v }),
  scheduledSummary: { count: 0, failed: 0 },
  setScheduledSummary: (summary) => set({ scheduledSummary: summary }),
  queuedCompose: null,
  setQueuedCompose: (data) => set({ queuedCompose: data }),

  // Contacts view
  showContacts: false,
  setShowContacts: (v) => set({ showContacts: v }),
  // A sender the contacts page should show: its contact when one exists, otherwise a new
  // contact prefilled from the message. The page clears it once handled.
  contactsFocus: null,
  openContactFor: ({ email, name } = {}) => {
    if (!email) return;
    set({ showContacts: true, showAdmin: false, contactsFocus: { email, name: name || '' } });
  },
  clearContactsFocus: () => set({ contactsFocus: null }),
  // A Microsoft mailbox to reconnect with the device-code flow (the redirect flow is not set up):
  // opens Settings → Integrations, whose Microsoft section starts the flow for it and clears this.
  msDeviceReconnectRequested: null,
  requestMsDeviceReconnect: (accountId) => set({ msDeviceReconnectRequested: accountId, adminTab: 'integrations', showAdmin: true }),
  clearMsDeviceReconnect: () => set({ msDeviceReconnectRequested: null }),
  rulesPreFill: null, // { accountId, fromEmail, fromName } — transient, set by context menu
  setRulesPreFill: (v) => set({ rulesPreFill: v }),

  backfillProgress: {}, // { [accountId]: { synced: N, total: N } | null } — transient
  setBackfillProgress: (accountId, progress) => set(state => ({
    backfillProgress: { ...state.backfillProgress, [accountId]: progress },
  })),

  // Mobile navigation
  mobileSidebarOpen: false,
  setMobileSidebarOpen: (v) => set({ mobileSidebarOpen: v }),

  // Language
  language: normalizeLanguage(localStorage.getItem('mailexpert_language')),
  setLanguage: (lng) => {
    localStorage.setItem('mailexpert_language', lng);
    set({ language: lng });
    i18n.changeLanguage(lng);
    schedulePrefSave({ language: lng });
  },
  // The first-entry language picker (components/LanguagePicker.jsx).
  languagePickerOpen: false,
  setLanguagePickerOpen: (open) => set({ languagePickerOpen: open }),

  // Threaded view
  threadedView: localStorage.getItem('mailexpert_threaded_view') === 'true',
  setThreadedView: (val) => {
    localStorage.setItem('mailexpert_threaded_view', String(val));
    set({ threadedView: val, expandedThreadId: null, threadMessages: {} });
    schedulePrefSave({ threadedView: val });
  },

  // Compose format
  plaintextEmail: localStorage.getItem('mailexpert_plaintext_email') === 'true',
  setPlaintextEmail: (val) => {
    localStorage.setItem('mailexpert_plaintext_email', String(val));
    set({ plaintextEmail: val });
    schedulePrefSave({ plaintextEmail: val });
  },

  // Default sender for composes with no account context, i.e. the unified inbox (#417).
  // Holds a From selector value ('account:<id>' or 'alias:<aliasId>:<accountId>') so an
  // alias can be the default too. '' means "no preference", which keeps the previous
  // last-used-account behaviour. Validated at use, since accounts and aliases outlive it.
  defaultSender: localStorage.getItem('mailexpert_default_sender') || '',
  setDefaultSender: (val) => {
    const clean = typeof val === 'string' ? val : '';
    localStorage.setItem('mailexpert_default_sender', clean);
    set({ defaultSender: clean });
    schedulePrefSave({ defaultSender: clean });
  },

  // Message list quick actions
  hoverQuickActions: localStorage.getItem('mailexpert_hover_quick_actions') !== 'false',
  setHoverQuickActions: (val) => {
    localStorage.setItem('mailexpert_hover_quick_actions', String(val));
    set({ hoverQuickActions: val });
    schedulePrefSave({ hoverQuickActions: val });
  },

  // #440: WHICH quick actions the hover cluster shows. Stored as a subset of
  // HOVER_ACTION_KEYS (utils/hoverActions.js); order is always canonical, so the setter
  // normalizes by filtering the canonical list — customization is membership, not order.
  // Unknown keys from an older or edited pref are dropped on read.
  hoverActionSet: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('mailexpert_hover_action_set') || 'null');
      if (Array.isArray(saved)) return sanitizeHoverActionSet(saved);
    } catch { /* corrupted pref — fall back to the default cluster */ }
    return [...DEFAULT_HOVER_ACTIONS];
  })(),
  setHoverActionSet: (keys) => {
    const val = sanitizeHoverActionSet(keys);
    localStorage.setItem('mailexpert_hover_action_set', JSON.stringify(val));
    set({ hoverActionSet: val });
    schedulePrefSave({ hoverActionSet: val });
  },

  // Show sender avatars in the mobile message list (off by default — they cost row width
  // on a narrow screen; opt-in for users who prefer the scannability). Desktop always shows them.
  showMobileAvatars: localStorage.getItem('mailexpert_show_mobile_avatars') === 'true',
  setShowMobileAvatars: (val) => {
    localStorage.setItem('mailexpert_show_mobile_avatars', String(val));
    set({ showMobileAvatars: val });
    schedulePrefSave({ showMobileAvatars: val });
  },

  // Fetch sender avatars from Gravatar (off by default — opt-in third-party lookup, proxied
  // through the backend so the user's IP is never exposed). Falls back to initials on a miss.
  gravatarAvatars: localStorage.getItem('mailexpert_gravatar_avatars') === 'true',
  setGravatarAvatars: (val) => {
    localStorage.setItem('mailexpert_gravatar_avatars', String(val));
    set({ gravatarAvatars: val });
    schedulePrefSave({ gravatarAvatars: val });
  },

  // Show message preview snippets in the message list (on by default).
  showMessagePreviews: localStorage.getItem('mailexpert_show_message_previews') !== 'false',
  setShowMessagePreviews: (val) => {
    localStorage.setItem('mailexpert_show_message_previews', String(val));
    set({ showMessagePreviews: val });
    schedulePrefSave({ showMessagePreviews: val });
  },

  replyDefault: localStorage.getItem('mailexpert_reply_default') || 'reply',
  setReplyDefault: (val) => {
    localStorage.setItem('mailexpert_reply_default', val);
    set({ replyDefault: val });
    schedulePrefSave({ replyDefault: val });
  },

  markReadBehavior: localStorage.getItem('mailexpert_mark_read_behavior') || 'immediate',
  setMarkReadBehavior: (val) => {
    localStorage.setItem('mailexpert_mark_read_behavior', val);
    set({ markReadBehavior: val });
    schedulePrefSave({ markReadBehavior: val });
  },
  markReadDelay: parseInt(localStorage.getItem('mailexpert_mark_read_delay') || '1') || 1,
  setMarkReadDelay: (val) => {
    const n = Math.max(1, Math.min(10, parseInt(val) || 1));
    localStorage.setItem('mailexpert_mark_read_delay', String(n));
    set({ markReadDelay: n });
    schedulePrefSave({ markReadDelay: n });
  },

  // Thread expansion cache (not persisted — reset on navigation)
  expandedThreadId: null,
  setExpandedThreadId: (id) => set({ expandedThreadId: id }),
  threadMessages: {},
  setThreadMessages: (threadId, msgs) => set(state => ({
    threadMessages: { ...state.threadMessages, [threadId]: msgs },
  })),
  clearThreadMessages: (threadId) => set(state => ({
    threadMessages: removeThreadCacheEntry(state.threadMessages, threadId),
  })),
  loadingThread: null,
  setLoadingThread: (id) => set({ loadingThread: id }),

  // Theme
  // `theme` always holds the user's own last hand-picked theme, meaningful even while
  // themeFollowsSystem is on — it is never overwritten with the resolved system theme, so
  // turning "как в системе" back off returns to it.
  theme: localStorage.getItem('mailexpert_theme') || getInitialTheme(),
  themeFollowsSystem: readThemeFollowsSystem(),
  // The theme actually in effect right now — the system-resolved theme while following it,
  // otherwise `theme` above. A settings UI (ThemesTab) highlights this, not `theme`, so the
  // highlighted card matches what is actually on screen. Kept updated by applyThemeAndFont.
  effectiveTheme: readThemeFollowsSystem()
    ? resolveSystemTheme()
    : (localStorage.getItem('mailexpert_theme') || getInitialTheme()),
  setTheme: (theme) => {
    // Picking a theme by hand — in the appearance settings or the command palette — always
    // turns "как в системе" off; it would otherwise be silently overridden on the next OS
    // change or reload.
    localStorage.setItem('mailexpert_theme', theme);
    writeThemeFollowsSystem(false);
    set({ theme, themeFollowsSystem: false });
    watchSystemTheme(false);
    applyThemeAndFont(get, set, theme);
    schedulePrefSave({ theme, themeFollowsSystem: false });
  },
  setThemeFollowsSystem: (follows) => {
    writeThemeFollowsSystem(follows);
    set({ themeFollowsSystem: follows });
    watchSystemTheme(follows);
    // Turning it on applies the system-resolved theme at once; turning it off returns to the
    // user's own last pick (`theme`, never overwritten while following).
    applyThemeAndFont(get, set, follows ? resolveSystemTheme() : get().theme);
    schedulePrefSave({ themeFollowsSystem: follows });
  },

  // Font
  fontSet: localStorage.getItem('mailexpert_font') || 'default',
  setFontSet: (fontSet) => {
    localStorage.setItem('mailexpert_font', fontSet);
    set({ fontSet });
    // A retro theme's paired font still wins over an explicit pick while it's active.
    applyFontSet(effectiveFontSet(get().theme, fontSet));
    schedulePrefSave({ font: fontSet });
  },

  fontSize: parseInt(localStorage.getItem('mailexpert_font_size')) || DEFAULT_FONT_SIZE,
  setFontSize: (pct) => {
    localStorage.setItem('mailexpert_font_size', String(pct));
    set({ fontSize: pct });
    applyFontSize(pct);
    schedulePrefSave({ fontSize: String(pct) });
  },

  showAppBadge: localStorage.getItem('mailexpert_app_badge') !== 'false',
  setShowAppBadge: (val) => {
    localStorage.setItem('mailexpert_app_badge', String(val));
    set({ showAppBadge: val });
    schedulePrefSave({ showAppBadge: val });
  },

  showFaviconBadge: localStorage.getItem('mailexpert_favicon_badge') !== 'false',
  setShowFaviconBadge: (val) => {
    localStorage.setItem('mailexpert_favicon_badge', String(val));
    set({ showFaviconBadge: val });
    schedulePrefSave({ showFaviconBadge: val });
  },

  categorizationEnabled: false,
  // Install-wide: only an admin can switch it, so a refused change reverts the toggle.
  setCategorizationEnabled: (val) => {
    const previous = get().categorizationEnabled;
    set({ categorizationEnabled: val });
    api.admin.updateSettings({ categorization_enabled: val })
      .catch(() => set({ categorizationEnabled: previous }));
  },

  // Unread counts per category for the tab bar badges { primary: N, newsletter: N, ... }
  categoryCounts: {},
  setCategoryCounts: (counts) => set({ categoryCounts: counts }),
  adjustCategoryCount: (category, delta) => set(state => {
    const key = category || 'primary';
    const current = state.categoryCounts[key] || 0;
    return { categoryCounts: { ...state.categoryCounts, [key]: Math.max(0, current + delta) } };
  }),

  // ── Right-sidebar layout ────────────────────────────────────────────────────
  // Independent column width (own var + handle, not --list-width).
  rightSidebarWidth: clampRightSidebarWidth(localStorage.getItem('mailexpert_right_sidebar_width')),
  setRightSidebarWidth: (w) => {
    const clamped = clampRightSidebarWidth(w);
    localStorage.setItem('mailexpert_right_sidebar_width', String(clamped));
    set({ rightSidebarWidth: clamped });
    schedulePrefSave({ rightSidebarWidth: clamped });
  },
  isRightSidebarResizing: false,
  setIsRightSidebarResizing: (v) => set({ isRightSidebarResizing: v }),

  rightSidebarHidden: localStorage.getItem('mailexpert_right_sidebar_hidden') === 'true',
  toggleRightSidebarHidden: () => set(state => {
    const next = !state.rightSidebarHidden;
    localStorage.setItem('mailexpert_right_sidebar_hidden', String(next));
    schedulePrefSave({ rightSidebarHidden: next });
    return { rightSidebarHidden: next };
  }),

  // ── GTD content + tabs ──────────────────────────────────────────────────────
  // Per-section collapse state (section key -> bool). Someday collapsed by default.
  gtdCollapsedSections: readGtdCollapsedSections(),
  toggleGtdSection: (section) => set(state => {
    const next = { ...state.gtdCollapsedSections, [section]: !state.gtdCollapsedSections[section] };
    localStorage.setItem('mailexpert_gtd_collapsed_sections', JSON.stringify(next));
    schedulePrefSave({ gtdCollapsedSections: next });
    return { gtdCollapsedSections: next };
  }),

  // Active GTD browse tab in the message-list pill strip (null = normal list).
  activeGtdTab: null,
  setActiveGtdTab: (tab) => set({ activeGtdTab: tab }),

  // Sections data feeding both the rail and the tab list. null before first load.
  gtdSections: null,
  fetchGtdSections: async () => {
    const seq = ++_gtdSectionsSeq;
    const accountId = get().selectedAccountId || undefined;
    try {
      const data = await api.getGtdSections({ accountId, limit: 50 });
      if (seq !== _gtdSectionsSeq) return; // superseded by a newer fetch
      set({ gtdSections: applyGtdRemovalGuard(data.sections || {}) });
    } catch {
      // Best-effort; scheduleGtdSectionsFetch/the next context change will retry.
    }
  },
  // Debounced refetch — used by the WS gtd_sections_updated handler and after a
  // classify so the rail converges without waiting on (or racing) the socket.
  scheduleGtdSectionsFetch: () => {
    clearTimeout(_gtdFetchTimer);
    _gtdFetchTimer = setTimeout(() => { get().fetchGtdSections(); }, 400);
  },
  // Optimistically drop a thread's head from the given GTD state sections after a
  // "done" action so the rail row disappears instantly; the gtd_sections_updated
  // refetch reconciles the authoritative counts. identity is message_id||id; states
  // are the backend section keys whose labels were removed (todo/watch/delegated/…).
  // Delegates to a pure helper (unit-tested in gtd.test.js) that also keeps the deduped
  // Waiting rollup in step so the Waiting badge is correct instantly.
  removeGtdThread: (identity, states) => {
    let snapshot = null;
    set(state => {
      snapshot = snapshotGtdThreadRemoval(state.gtdSections, identity, states);
      const next = removeGtdThreadFromSections(state.gtdSections, identity, states);
      return next === state.gtdSections ? {} : { gtdSections: next };
    });
    return snapshot;
  },
  restoreGtdThread: (snapshot) => set(state => {
    const next = restoreGtdThreadRemoval(state.gtdSections, snapshot);
    return next === state.gtdSections ? {} : { gtdSections: next };
  }),
  // Optimistically flip a section thread's read flag so a rail row's bold/normal styling
  // updates instantly on a mark-read/unread from the rail; the WS/gtd refetch reconciles.
  // identity is message_id||id and matches across every state a thread is labelled with
  // (a merged Waiting row lives in both watch and delegated), keeping them in sync — and
  // the deduped Waiting rollup's unread with them (pure helper, unit-tested in gtd.test.js).
  markGtdThreadRead: (identity, isRead) => set(state => {
    const next = setGtdThreadReadInSections(state.gtdSections, identity, isRead);
    return next === state.gtdSections ? {} : { gtdSections: next };
  }),
  // Optimistically flip a section thread's star so a rail row's star fills/empties instantly
  // on a toggle; the WS/gtd refetch reconciles. identity is message_id||id and matches across
  // every state a thread is labelled with (a merged Waiting row lives in both watch and
  // delegated), keeping them in sync. Star does not affect the unread rollup.
  markGtdThreadStarred: (identity, isStarred) => set(state => {
    const cur = state.gtdSections;
    if (!cur || identity == null) return {};
    const next = { ...cur };
    let changed = false;
    for (const [key, sec] of Object.entries(cur)) {
      if (!sec || !Array.isArray(sec.threads)) continue;
      let touched = false;
      const threads = sec.threads.map(th => {
        if ((th.message_id || th.id) !== identity || !!th.is_starred === isStarred) return th;
        touched = true;
        return { ...th, is_starred: isStarred };
      });
      if (!touched) continue;
      changed = true;
      next[key] = { ...sec, threads };
    }
    return changed ? { gtdSections: next } : {};
  }),

  // Which cached imported pet renders at inbox-zero (null = the built-in SVG dog).
  // A flat user preference; the asset bytes live server-side, keyed by this slug.
  gtdPetSlug: null,
  setGtdPetSlug: (slug) => {
    const value = slug || null;
    set({ gtdPetSlug: value });
    // '' is the explicit "clear" sentinel the prefs allow-list understands.
    api.savePreferences({ gtdPetSlug: value || '' }).catch(() => {});
  },

  // Layout
  layout: (() => {
    const raw = localStorage.getItem('mailexpert_layout');
    const clean = normalizeLayout(raw);
    // Self-heal a stale/removed preset so it can never reach a consumer (#207).
    if (raw && raw !== clean) localStorage.setItem('mailexpert_layout', clean);
    return clean;
  })(),
  setLayout: (layout) => {
    const clean = normalizeLayout(layout);
    localStorage.setItem('mailexpert_layout', clean);
    localStorage.removeItem('mailexpert_list_width');
    set({ layout: clean });
    applyLayout(clean);
    schedulePrefSave({ layout: clean });
  },

  // Image privacy. Remote images show by default (owner's choice, 2026-09-23): the team reads
  // business mail and wants letters as the sender sent them; blocking stays one switch away.
  blockRemoteImages: false,
  imageWhitelist: { addresses: [], domains: [] },
  senderFaviconsLoaded: false,
  senderFavicons: false,
  senderFaviconsSaving: false,
  // Monotonic counter bumped on every toggle. loadPreferences captures it before
  // its GET so a stale hydration response can't clobber a toggle the user made
  // while the fetch was in flight. Never reset — the user-id guard covers account
  // switches, and monotonicity avoids ABA.
  senderFaviconsEpoch: 0,
  setSenderFavicons: async (enabled) => {
    if (get().senderFaviconsSaving) return;
    const userId = get().user?.id;
    set(state => ({ senderFaviconsSaving: true, senderFaviconsEpoch: state.senderFaviconsEpoch + 1 }));
    if (!enabled) {
      set({ senderFavicons: false });
      try { await api.savePreferences({ senderFavicons: false }); }
      finally {
        if (get().user?.id === userId) set({ senderFaviconsSaving: false });
      }
      return;
    }
    try {
      await api.savePreferences({ senderFavicons: true });
      if (get().user?.id === userId) {
        set({ senderFaviconsLoaded: true, senderFavicons: true });
      }
    } finally {
      if (get().user?.id === userId) set({ senderFaviconsSaving: false });
    }
  },
  setBlockRemoteImages: (val) => {
    set({ blockRemoteImages: val });
    return api.savePreferences({ blockRemoteImages: val });
  },
  setImageWhitelist: (whitelist) => {
    const prev = get().imageWhitelist;
    set({ imageWhitelist: whitelist });
    return api.savePreferences({ imageWhitelist: whitelist }).catch(err => {
      set({ imageWhitelist: prev });
      throw err;
    });
  },
  addToImageWhitelist: ({ type, value }) => {
    const prev = get().imageWhitelist;
    const key = type === 'address' ? 'addresses' : 'domains';
    const normalized = value.toLowerCase();
    set({
      imageWhitelist: {
        ...prev,
        [key]: [...new Set([...(prev[key] || []), normalized])],
      },
    });
    return api.addToImageWhitelist({ type, value: normalized }).catch(err => {
      set({ imageWhitelist: prev });
      throw err;
    });
  },

  // Keyboard shortcuts — stores only user overrides (action → key).
  // Merged with defaults at use-time via getEffectiveShortcuts().
  shortcuts: {},
  setShortcuts: (overrides) => {
    set({ shortcuts: overrides });
    return api.savePreferences({ shortcuts: overrides }).catch(() => {});
  },

  // User-defined AI actions (#202), synced across devices. Each: { id, label, prompt }.
  // null = not yet loaded; loadPreferences seeds defaults on first run.
  aiActions: null,
  setAiActions: (actions) => {
    set({ aiActions: actions });
    return api.savePreferences({ aiActions: actions }).catch(() => {});
  },

  // Hidden folders — { [accountId]: [path, ...] }
  hiddenFolders: {},
  setHiddenFolders: (hf) => {
    set({ hiddenFolders: hf });
    return api.savePreferences({ hiddenFolders: hf }).catch(() => {});
  },

  // Custom per-account folder display order — { [accountId]: [path, ...] }
  folderOrder: readFolderOrder(),
  setFolderOrder: (accountId, paths) => {
    const next = mergeFolderOrder(get().folderOrder, accountId, paths);
    set({ folderOrder: next });
    schedulePrefSave({ folderOrder: next });
  },

  // Sidebar account list order (utils/accountOrder.js). Pinned mailboxes stay on top in the order
  // they were pinned; the others rise by their latest received mail unless that is switched off.
  // Both are per-user preferences, saved with the others so they follow the user across devices.
  pinnedAccounts: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('mailexpert_pinned_accounts') || '[]');
      return Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : [];
    } catch { return []; }
  })(),
  // Local only: the server is told by pinAccount / unpinAccount (what changed) or
  // reorderPinnedAccounts (the whole new order), never by a blind write of this list.
  setPinnedAccounts: (ids) => {
    const next = Array.isArray(ids) ? ids : [];
    localStorage.setItem('mailexpert_pinned_accounts', JSON.stringify(next));
    set({ pinnedAccounts: next });
  },
  // A pin or unpin is sent at once as the one change it is (not queued with the other preferences,
  // whose queue keeps only the last value of a key), and the server applies it to ITS list: a tab
  // holding a stale list cannot overwrite a pin made on another device. Pins of mailboxes that are
  // gone are dropped from the local list on the way, never while the account list is still loading
  // (an empty list would wipe every pin).
  pinAccount: (accountId) => {
    const { pinnedAccounts, accounts, accountsReady, setPinnedAccounts } = get();
    const current = accountsReady && accounts.length ? prunePinnedIds(pinnedAccounts, accounts) : pinnedAccounts;
    setPinnedAccounts(pinAccountIds(current, accountId));
    api.savePreferences({ pinAccount: accountId }).catch(err => console.error('Failed to save the pin:', err?.message || err));
  },
  unpinAccount: (accountId) => {
    const { pinnedAccounts, accounts, accountsReady, setPinnedAccounts } = get();
    const current = accountsReady && accounts.length ? prunePinnedIds(pinnedAccounts, accounts) : pinnedAccounts;
    setPinnedAccounts(unpinAccountIds(current, accountId));
    api.savePreferences({ unpinAccount: accountId }).catch(err => console.error('Failed to save the unpin:', err?.message || err));
  },
  // Move up / down among the pinned mailboxes: the whole new order is the change.
  reorderPinnedAccounts: (ids) => {
    get().setPinnedAccounts(ids);
    schedulePrefSave({ pinnedAccounts: get().pinnedAccounts });
  },
  sortAccountsByLatest: localStorage.getItem('mailexpert_sort_accounts_by_latest') !== 'false',
  setSortAccountsByLatest: (val) => {
    localStorage.setItem('mailexpert_sort_accounts_by_latest', String(val));
    set({ sortAccountsByLatest: val });
    schedulePrefSave({ sortAccountsByLatest: val });
  },
  // A new_messages event for the inbox: that mailbox just received mail, which is newer than what
  // the last account list said. Only ever moves the date forward; nothing is saved or refetched.
  noteAccountReceived: (accountId, receivedAt) => set(state => {
    const account = state.accounts.find(a => a.id === accountId);
    const incoming = Date.parse(receivedAt);
    if (!account || Number.isNaN(incoming)) return {};
    const current = Date.parse(account.last_received_at);
    if (!Number.isNaN(current) && current >= incoming) return {};
    return { accounts: state.accounts.map(a => (a.id === accountId ? { ...a, last_received_at: receivedAt } : a)) };
  }),

  // Sidebar tree state — persisted so the tree looks the same after reload/re-login
  expandedAccounts: (() => {
    try { return JSON.parse(localStorage.getItem('mailexpert_expanded_accounts') || '{}'); }
    catch { return {}; }
  })(),
  setExpandedAccounts: (updater) => {
    const next = typeof updater === 'function' ? updater(get().expandedAccounts) : updater;
    localStorage.setItem('mailexpert_expanded_accounts', JSON.stringify(next));
    set({ expandedAccounts: next });
    schedulePrefSave({ expandedAccounts: next });
  },

  // collapsedFolders stored as array of "accountId:path" keys (Set can't be JSON-serialised)
  collapsedFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailexpert_collapsed_folders') || '[]'); }
    catch { return []; }
  })(),
  toggleCollapsedFolder: (accountId, path) => {
    const key = `${accountId}:${path}`;
    const prev = get().collapsedFolders;
    const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
    localStorage.setItem('mailexpert_collapsed_folders', JSON.stringify(next));
    set({ collapsedFolders: next });
    schedulePrefSave({ collapsedFolders: next });
  },

  // Favorite folders — [{ accountId, path }, ...] ordered by insertion
  favoriteFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailexpert_favorite_folders') || '[]'); }
    catch { return []; }
  })(),
  addFavoriteFolder: ({ accountId, path }) => {
    const prev = get().favoriteFolders;
    if (prev.some(f => f.accountId === accountId && f.path === path)) return;
    const next = [...prev, { accountId, path }];
    localStorage.setItem('mailexpert_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  removeFavoriteFolder: ({ accountId, path }) => {
    const next = get().favoriteFolders.filter(f => !(f.accountId === accountId && f.path === path));
    localStorage.setItem('mailexpert_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  renameFavoriteFolder: ({ accountId, path, label }) => {
    const next = get().favoriteFolders.map(f => {
      if (f.accountId !== accountId || f.path !== path) return f;
      // eslint-disable-next-line no-unused-vars
      const { label: _old, ...base } = f;
      return label ? { ...base, label } : base;
    });
    localStorage.setItem('mailexpert_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  reorderFavoriteFolders: (next) => {
    localStorage.setItem('mailexpert_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },

  // Recent move-to folders — [{ accountId, path }, ...] most-recent first, capped at 5
  recentFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailexpert_recent_folders') || '[]'); }
    catch { return []; }
  })(),
  recordRecentFolder: ({ accountId, path }) => {
    const prev = get().recentFolders;
    const deduped = prev.filter(f => !(f.accountId === accountId && f.path === path));
    const next = [{ accountId, path }, ...deduped].slice(0, 5);
    localStorage.setItem('mailexpert_recent_folders', JSON.stringify(next));
    set({ recentFolders: next });
    schedulePrefSave({ recentFolders: next });
  },

  // Fetch server preferences and apply them — call after any successful login.
  // Sets localStorage so subsequent page loads apply the right values instantly.
  loadPreferences: async () => {
    const userId = get().user?.id;
    const faviconEpoch = get().senderFaviconsEpoch;
    // The panel-wide plugin switches load alongside the personal preferences.
    const pluginsLoaded = get().loadEnabledPlugins();
    try {
      const prefs = await api.getPreferences();
      if (get().user?.id !== userId) return;
      if (prefs.theme) {
        localStorage.setItem('mailexpert_theme', prefs.theme);
        set({ theme: prefs.theme });
      }
      if (typeof prefs.themeFollowsSystem === 'boolean') {
        writeThemeFollowsSystem(prefs.themeFollowsSystem);
        set({ themeFollowsSystem: prefs.themeFollowsSystem });
      }
      watchSystemTheme(get().themeFollowsSystem);
      if (prefs.font) {
        localStorage.setItem('mailexpert_font', prefs.font);
        set({ fontSet: prefs.font });
      }
      // Apply whichever theme is actually in effect — the system-resolved theme while
      // following it, otherwise the (possibly just-updated) hand-picked one — plus the
      // effective font, now that theme + font + themeFollowsSystem are all known, so a retro
      // theme's paired font overrides the saved font on load.
      applyThemeAndFont(get, set, get().themeFollowsSystem ? resolveSystemTheme() : get().theme);
      if (prefs.fontSize) {
        const n = parseInt(prefs.fontSize) || DEFAULT_FONT_SIZE;
        localStorage.setItem('mailexpert_font_size', String(n));
        set({ fontSize: n });
        applyFontSize(n);
      }
      if (prefs.layout) {
        const clean = normalizeLayout(prefs.layout);
        const prevLayout = get().layout;
        localStorage.setItem('mailexpert_layout', clean);
        set({ layout: clean });
        if (clean !== prevLayout) localStorage.removeItem('mailexpert_list_width');
        const savedListWidth = clean !== prevLayout
          ? undefined
          : (Number(localStorage.getItem('mailexpert_list_width')) || undefined);
        applyLayout(clean, savedListWidth);
      }
      if (prefs.notificationSound) {
        localStorage.setItem('mailexpert_notification_sound', prefs.notificationSound);
        set({ notificationSound: prefs.notificationSound });
      }
      if (prefs.pageSize) {
        const n = parseInt(prefs.pageSize) || 50;
        localStorage.setItem('mailexpert_page_size', String(n));
        set({ pageSize: n });
      }
      if (prefs.scrollMode) {
        localStorage.setItem('mailexpert_scroll_mode', prefs.scrollMode);
        set({ scrollMode: prefs.scrollMode });
      }
      if (prefs.swipeActions) {
        const swipeActions = {
          left: prefs.swipeActions.left || 'archive',
          right: prefs.swipeActions.right || 'markRead',
        };
        localStorage.setItem('mailexpert_swipe_actions', JSON.stringify(swipeActions));
        set({ swipeActions });
      }
      if (prefs.syncInterval) set({ syncInterval: parseInt(prefs.syncInterval) || 60 });
      // blockRemoteImages: explicit true turns blocking on, explicit false off; anything else keeps the default (off)
      if (prefs.blockRemoteImages === false) set({ blockRemoteImages: false });
      else if (prefs.blockRemoteImages === true) set({ blockRemoteImages: true });
      if (prefs.autoLockMinutes != null) {
        const n = Number(prefs.autoLockMinutes);
        set({ autoLockMinutes: [0, 1, 5, 15, 30].includes(n) ? n : 0 });
      }
      if (prefs.imageWhitelist) set({ imageWhitelist: prefs.imageWhitelist });
      // Hydration is done, but if the user toggled while this GET was in flight
      // (epoch bumped), the toggle owns senderFavicons — only mark it loaded.
      if (get().senderFaviconsEpoch === faviconEpoch) {
        set({ senderFaviconsLoaded: true, senderFavicons: prefs.senderFavicons === true });
      } else {
        set({ senderFaviconsLoaded: true });
      }
      if (prefs.shortcuts) set({ shortcuts: prefs.shortcuts });
      if (Array.isArray(prefs.aiActions)) {
        set({ aiActions: prefs.aiActions });
      } else {
        // First run — seed editable example actions and persist them once so the
        // seed doesn't reappear after the user deletes them.
        set({ aiActions: DEFAULT_AI_ACTIONS });
        api.savePreferences({ aiActions: DEFAULT_AI_ACTIONS }).catch(() => {});
      }
      if (prefs.hiddenFolders) set({ hiddenFolders: prefs.hiddenFolders });
      set({ folderOrder: cacheFolderOrderFromPreferences(prefs) });
      if (prefs.expandedAccounts && typeof prefs.expandedAccounts === 'object' && !Array.isArray(prefs.expandedAccounts)) {
        localStorage.setItem('mailexpert_expanded_accounts', JSON.stringify(prefs.expandedAccounts));
        set({ expandedAccounts: prefs.expandedAccounts });
      }
      // What the server says is the whole truth for this user: a key it does not have means no
      // pins and the default order, not whatever the previous user of this tab left behind.
      {
        const pinned = Array.isArray(prefs.pinnedAccounts) ? prefs.pinnedAccounts.filter(id => typeof id === 'string') : [];
        localStorage.setItem('mailexpert_pinned_accounts', JSON.stringify(pinned));
        set({ pinnedAccounts: pinned });
        const sortByLatest = typeof prefs.sortAccountsByLatest === 'boolean' ? prefs.sortAccountsByLatest : true;
        localStorage.setItem('mailexpert_sort_accounts_by_latest', String(sortByLatest));
        set({ sortAccountsByLatest: sortByLatest });
      }
      if (Array.isArray(prefs.collapsedFolders)) {
        localStorage.setItem('mailexpert_collapsed_folders', JSON.stringify(prefs.collapsedFolders));
        set({ collapsedFolders: prefs.collapsedFolders });
      }
      if (Array.isArray(prefs.favoriteFolders)) {
        localStorage.setItem('mailexpert_favorite_folders', JSON.stringify(prefs.favoriteFolders));
        set({ favoriteFolders: prefs.favoriteFolders });
      }
      if (Array.isArray(prefs.recentFolders)) {
        localStorage.setItem('mailexpert_recent_folders', JSON.stringify(prefs.recentFolders));
        set({ recentFolders: prefs.recentFolders });
      }
      if (prefs.language) {
        const language = normalizeLanguage(prefs.language);
        localStorage.setItem('mailexpert_language', language);
        set({ language });
        i18n.changeLanguage(language);
      } else if (needsLanguageChoice({ stored: localStorage.getItem('mailexpert_language'), synced: prefs.language })) {
        set({ languagePickerOpen: true });
      }
      if (typeof prefs.threadedView === 'boolean') {
        localStorage.setItem('mailexpert_threaded_view', String(prefs.threadedView));
        set({ threadedView: prefs.threadedView });
      }
      if (typeof prefs.plaintextEmail === 'boolean') {
        localStorage.setItem('mailexpert_plaintext_email', String(prefs.plaintextEmail));
        set({ plaintextEmail: prefs.plaintextEmail });
      }
      if (typeof prefs.defaultSender === 'string') {
        localStorage.setItem('mailexpert_default_sender', prefs.defaultSender);
        set({ defaultSender: prefs.defaultSender });
      }
      if (typeof prefs.hoverQuickActions === 'boolean') {
        localStorage.setItem('mailexpert_hover_quick_actions', String(prefs.hoverQuickActions));
        set({ hoverQuickActions: prefs.hoverQuickActions });
      }
      if (Array.isArray(prefs.hoverActionSet)) {
        const hoverSet = sanitizeHoverActionSet(prefs.hoverActionSet);
        localStorage.setItem('mailexpert_hover_action_set', JSON.stringify(hoverSet));
        set({ hoverActionSet: hoverSet });
      }
      if (typeof prefs.showMobileAvatars === 'boolean') {
        localStorage.setItem('mailexpert_show_mobile_avatars', String(prefs.showMobileAvatars));
        set({ showMobileAvatars: prefs.showMobileAvatars });
      }
      if (typeof prefs.gravatarAvatars === 'boolean') {
        localStorage.setItem('mailexpert_gravatar_avatars', String(prefs.gravatarAvatars));
        set({ gravatarAvatars: prefs.gravatarAvatars });
      }
      if (typeof prefs.showMessagePreviews === 'boolean') {
        localStorage.setItem('mailexpert_show_message_previews', String(prefs.showMessagePreviews));
        set({ showMessagePreviews: prefs.showMessagePreviews });
      }
      if (prefs.replyDefault === 'reply' || prefs.replyDefault === 'replyAll') {
        localStorage.setItem('mailexpert_reply_default', prefs.replyDefault);
        set({ replyDefault: prefs.replyDefault });
      }
      if (prefs.markReadBehavior === 'immediate' || prefs.markReadBehavior === 'delay' || prefs.markReadBehavior === 'manual') {
        localStorage.setItem('mailexpert_mark_read_behavior', prefs.markReadBehavior);
        set({ markReadBehavior: prefs.markReadBehavior });
      }
      if (prefs.markReadDelay) {
        const n = Math.max(1, Math.min(10, parseInt(prefs.markReadDelay) || 1));
        localStorage.setItem('mailexpert_mark_read_delay', String(n));
        set({ markReadDelay: n });
      }
      if (prefs.sidebarWidth) {
        const n = parseInt(prefs.sidebarWidth);
        if (n >= 160 && n <= 400) {
          localStorage.setItem('mailexpert_sidebar_width', String(n));
          set({ sidebarWidth: n });
        }
      }
      if (typeof prefs.showAppBadge === 'boolean') {
        localStorage.setItem('mailexpert_app_badge', String(prefs.showAppBadge));
        set({ showAppBadge: prefs.showAppBadge });
      }
      if (typeof prefs.showFaviconBadge === 'boolean') {
        localStorage.setItem('mailexpert_favicon_badge', String(prefs.showFaviconBadge));
        set({ showFaviconBadge: prefs.showFaviconBadge });
      }
      if (typeof prefs.categorizationEnabled === 'boolean') {
        set({ categorizationEnabled: prefs.categorizationEnabled });
      }
      if (prefs.rightSidebarWidth != null) {
        const n = clampRightSidebarWidth(prefs.rightSidebarWidth);
        localStorage.setItem('mailexpert_right_sidebar_width', String(n));
        set({ rightSidebarWidth: n });
      }
      if (prefs.gtdCollapsedSections && typeof prefs.gtdCollapsedSections === 'object' && !Array.isArray(prefs.gtdCollapsedSections)) {
        localStorage.setItem('mailexpert_gtd_collapsed_sections', JSON.stringify(prefs.gtdCollapsedSections));
        set({ gtdCollapsedSections: prefs.gtdCollapsedSections });
      }
      if (typeof prefs.gtdPetSlug === 'string') {
        set({ gtdPetSlug: prefs.gtdPetSlug || null });
      }
      if (typeof prefs.rightSidebarHidden === 'boolean') {
        localStorage.setItem('mailexpert_right_sidebar_hidden', String(prefs.rightSidebarHidden));
        set({ rightSidebarHidden: prefs.rightSidebarHidden });
      }
      if (prefs.customCss) {
        applyCustomCss(prefs.customCss);
      }
    } catch { /* intentional */ }
    await pluginsLoaded;
  },
}));

// Start following the OS setting immediately if that is the (default-on) state — before any
// sign-in, so the login screen tracks it too. loadPreferences re-syncs this once server prefs
// are known, in case a signed-in user's saved preference differs from this browser's default.
watchSystemTheme(useStore.getState().themeFollowsSystem);

// The RFC message_id of the currently selected message, resolved from the same pools the
// reading pane uses: the active folder/search list, then any stashed thread — including the
// Shared, frozen fallback for accounts without a folder list. zustand 5 compares
// selector results by reference (useSyncExternalStore), so a selector that returns
// a fresh `[]` on every call makes the subscribed component re-render forever.
const NO_FOLDERS = Object.freeze([]);

export function selectAccountFolders(s, accountId) {
  return s.folders[accountId] || NO_FOLDERS;
}

// The selected message's RFC message_id and account, read with parseSelectedIdentity. Lets the
// GTD sidebar and message list highlight every copy of the open message by identity (not just
// the exact DB row that was clicked, e.g. the __dl_ deep-link stash a GTD sidebar selection
// writes), scoped to its account so that two accounts' copies of one email (separate rows since
// #476) do not highlight together. Null when nothing is selected.
//
// A plain selector, not a state field, so it stays in sync with the list automatically. It runs
// on every store update in every subscribed component, so it scans the pools ONCE and returns
// both values as one primitive string: the subscription re-renders only when either changes.
export function selectSelectedMessageIdentity(s) {
  const msg = findSelectedMessage(s);
  return msg ? JSON.stringify([msg.message_id ?? null, msg.account_id ?? null]) : null;
}

// { mid, accountId } from a selectSelectedMessageIdentity value; both null for no selection.
export function parseSelectedIdentity(identity) {
  if (!identity) return { mid: null, accountId: null };
  const [mid, accountId] = JSON.parse(identity);
  return { mid, accountId };
}

function findSelectedMessage(s) {
  const id = s.selectedMessageId;
  if (id == null) return null;
  const pool = s.searchQuery?.trim() ? s.searchResults : s.messages;
  return pool.find(m => m.id === id)
    ?? Object.values(s.threadMessages).flat().find(m => m.id === id)
    ?? null;
}
