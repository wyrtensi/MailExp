// Delimiter and parent-path primitives are shared with the move-picker label
// and search helpers so the tree and the pickers can never disagree.
import { folderDelimiter, folderParentPath as folderParent } from './folderDisplay.js';

export function collapsedTooltip(label, collapsed) {
  if (!collapsed) return undefined;
  // An empty title suppresses the browser's own tooltip, so drop the attribute.
  return label?.trim() || undefined;
}

export function activateOnKey(activate) {
  return (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); // Space would otherwise scroll the page.
    activate();
  };
}

export function hasRenderedInbox(folders, {
  expanded = false,
  sidebarCollapsed = false,
  hiddenPaths = [],
  showingHidden = false,
} = {}) {
  if (sidebarCollapsed || !expanded) return false;
  if (!Array.isArray(folders) || !folders.some(folder => folder?.path === 'INBOX')) {
    return false;
  }
  const isHidden = Array.isArray(hiddenPaths) && hiddenPaths.includes('INBOX');
  return !isHidden || Boolean(showingHidden);
}

export const FOLDER_ORDER_DRAG_TYPE = 'application/x-mailexpert-folder-order';

function delimiterFor(folders) {
  return folderDelimiter(folders.find(folder => (
    typeof folder?.delimiter === 'string' && folder.delimiter
  )));
}

// Special-use folders sit at the root of the tree whatever their path, so Gmail's
// "[Gmail]/Sent Mail" or a Courier-style "INBOX.Trash" shows beside Inbox rather than inside
// another folder (ported from upstream mailflow ea1a9194). Listed in their default order: with
// no saved order they lead the root in this order, Inbox first, and the rest follow by path.
const ROOT_SPECIAL_USES = ['\\inbox', '\\drafts', '\\sent', '\\archive', '\\junk', '\\trash'];

function specialUseRank(folder) {
  const rank = ROOT_SPECIAL_USES.indexOf(String(folder?.special_use || '').toLowerCase());
  if (rank !== -1) return rank;
  // Not every server flags INBOX \Inbox; it leads either way.
  return String(folder?.path || '').toUpperCase() === 'INBOX' ? 0 : -1;
}

function isRootSpecialUse(folder) {
  return specialUseRank(folder) !== -1;
}

// The path a folder hangs under in the tree: null at the root. The tree and folder reordering
// both go through this, so a folder can only be dragged among the siblings it is shown with.
function treeParentPath(folder, delimiter) {
  return isRootSpecialUse(folder) ? null : folderParent(folder.path, delimiter);
}

function folderPathsWithAncestors(folders) {
  const delimiter = delimiterFor(folders);
  const paths = new Set();
  const rankOf = new Map();
  for (const folder of folders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    const parts = folder.path.split(delimiter);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      paths.add(parts.slice(0, depth).join(delimiter));
    }
    const rank = specialUseRank(folder);
    if (rank !== -1) rankOf.set(folder.path, rank);
  }
  const defaultRank = folderPath => rankOf.get(folderPath) ?? ROOT_SPECIAL_USES.length;
  return [...paths].sort((a, b) => defaultRank(a) - defaultRank(b) || a.localeCompare(b));
}

export function sanitizeFolderOrder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  for (const [accountId, paths] of Object.entries(value)) {
    if (!Array.isArray(paths)) continue;
    const seen = new Set();
    const valid = paths.filter(path => {
      if (typeof path !== 'string' || !path || seen.has(path)) return false;
      seen.add(path);
      return true;
    });
    clean[accountId] = valid;
  }
  return clean;
}

export function normalizeFolderOrder(folders, savedOrder = []) {
  const known = folderPathsWithAncestors(Array.isArray(folders) ? folders : []);
  const knownSet = new Set(known);
  const ranked = [];
  const seen = new Set();
  if (Array.isArray(savedOrder)) {
    for (const folderPath of savedOrder) {
      if (
        typeof folderPath !== 'string'
        || seen.has(folderPath)
        || !knownSet.has(folderPath)
      ) continue;
      seen.add(folderPath);
      ranked.push(folderPath);
    }
  }
  return [...ranked, ...known.filter(folderPath => !seen.has(folderPath))];
}

export function buildFolderTree(folders, savedOrder = []) {
  const safeFolders = Array.isArray(folders) ? folders : [];
  const delimiter = delimiterFor(safeFolders);
  const map = {};
  const synthetic = new Set();
  for (const folder of safeFolders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    map[folder.path] = { ...folder, children: [] };
  }

  for (const folder of safeFolders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    const parts = folder.path.split(delimiter);
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folderPath = parts.slice(0, depth).join(delimiter);
      if (!map[folderPath]) {
        synthetic.add(folderPath);
        map[folderPath] = {
          path: folderPath,
          name: parts[depth - 1],
          delimiter,
          special_use: null,
          account_id: folder.account_id,
          children: [],
        };
      }
    }
  }

  const roots = [];
  const nodes = Object.values(map).sort((a, b) => a.path.localeCompare(b.path));
  for (const node of nodes) {
    const parentPath = treeParentPath(node, delimiter);
    if (parentPath && map[parentPath] && parentPath !== node.path) {
      map[parentPath].children.push(node);
    } else {
      roots.push(node);
    }
  }

  const rank = new Map(
    normalizeFolderOrder(safeFolders, savedOrder)
      .map((folderPath, index) => [folderPath, index]),
  );
  const sortGroup = group => {
    group.sort((a, b) => {
      const aRank = rank.get(a.path);
      const bRank = rank.get(b.path);
      if (aRank != null && bRank != null) return aRank - bRank;
      if (aRank != null) return -1;
      if (bRank != null) return 1;
      return a.path.localeCompare(b.path);
    });
    group.forEach(node => sortGroup(node.children));
  };
  sortGroup(roots);
  return withoutEmptyContainers(roots, synthetic);
}

// A container that only held special-use folders ("[Gmail]" once Sent, Drafts, Spam and Trash
// moved to the root, with All Mail and the rest hidden from IMAP) is left with nothing to show
// and cannot be opened itself, so it is dropped rather than shown as an empty row.
function withoutEmptyContainers(group, synthetic) {
  return group.filter(node => {
    node.children = withoutEmptyContainers(node.children, synthetic);
    return node.children.length > 0 || !(node.no_select || synthetic.has(node.path));
  });
}

export function reorderFolderPaths(
  folders,
  savedOrder,
  draggedPath,
  targetPath,
  position,
) {
  if (position !== 'before' && position !== 'after') return null;
  const safeFolders = Array.isArray(folders) ? folders : [];
  const delimiter = delimiterFor(safeFolders);
  const current = normalizeFolderOrder(safeFolders, savedOrder);
  const known = new Set(current);
  const byPath = new Map(safeFolders.map(folder => [folder?.path, folder]));
  const parentOf = folderPath => treeParentPath(byPath.get(folderPath) ?? { path: folderPath }, delimiter);
  if (
    draggedPath === targetPath
    || !known.has(draggedPath)
    || !known.has(targetPath)
    || parentOf(draggedPath) !== parentOf(targetPath)
  ) return null;

  const next = current.filter(folderPath => folderPath !== draggedPath);
  const targetIndex = next.indexOf(targetPath);
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedPath);
  return next.every((folderPath, index) => folderPath === current[index])
    ? null
    : next;
}

export function folderDropPosition(clientY, rect) {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

export function resolveFolderOrderDrop(
  folders,
  savedOrder,
  dataTransfer,
  targetAccountId,
  targetPath,
  clientY,
  rect,
) {
  if (
    !Array.from(dataTransfer?.types || []).includes(FOLDER_ORDER_DRAG_TYPE)
    || typeof dataTransfer?.getData !== 'function'
  ) return null;

  let drag;
  try {
    drag = JSON.parse(dataTransfer.getData(FOLDER_ORDER_DRAG_TYPE));
  } catch {
    return null;
  }
  if (
    !drag
    || drag.accountId !== targetAccountId
    || typeof drag.path !== 'string'
  ) return null;

  return reorderFolderPaths(
    folders,
    savedOrder,
    drag.path,
    targetPath,
    folderDropPosition(clientY, rect),
  );
}
