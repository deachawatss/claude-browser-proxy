// Claude Browser Proxy - Messenger Content Script
// Runs in the context of facebook.com/messages and messenger.com
// Injects a small status-dot badge on each chat row's avatar showing whether
// that chat has been indexed by our extension-owned hash-based indexing system.
// This is NOT Facebook's own read/unread state.

console.log('[Messenger Index] Content script loaded');

const STORAGE_PREFIX = 'msgIndex:';
const SCAN_DEBOUNCE_MS = 300;
const PENDING_RESET_MS = 1500;

// Same hashing algorithm used by background.js / the indexer, duplicated here
// so this file can compute message hashes if a future precise per-message
// sidebar check is added. Not currently used for the lightweight badge color
// decision (see scanAndInjectBadges / applyBadgeAppearance below) since the
// sidebar only exposes truncated preview text, not clean sender/text pairs.
async function hashMessage(threadId, sender, text) {
  const enc = new TextEncoder().encode(threadId + '|' + sender + '|' + text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// Find the chat list grid, preferring ARIA roles/attributes over class names
// since Facebook's DOM class names are unstable/obfuscated.
function findChatListContainer() {
  try {
    const directGrid = document.querySelector('[role="grid"][aria-label="Chats"]');
    if (directGrid) return directGrid;

    const chatsLabelEl = document.querySelector('[aria-label="Chats"]');
    if (chatsLabelEl) {
      if (chatsLabelEl.getAttribute('role') === 'grid') return chatsLabelEl;
      const gridAncestor = chatsLabelEl.closest('[role="grid"]');
      if (gridAncestor) return gridAncestor;
      return chatsLabelEl;
    }

    // Last resort: walk up from any row element on the page.
    const anyRow = document.querySelector('[role="row"]');
    if (anyRow) {
      return anyRow.closest('[role="grid"]') || anyRow.parentElement;
    }
  } catch (err) {
    console.error('[Messenger Index] findChatListContainer failed:', err);
  }
  return null;
}

function getChatRows() {
  try {
    const container = findChatListContainer();
    if (container) {
      const rows = container.querySelectorAll('[role="row"]');
      if (rows.length) return Array.from(rows);
    }
    // Fallback: any row on the page that looks like a chat row (has a thread link).
    return Array.from(document.querySelectorAll('[role="row"]'))
      .filter((row) => row.querySelector('a[href*="/t/"]'));
  } catch (err) {
    console.error('[Messenger Index] getChatRows failed:', err);
    return [];
  }
}

function extractThreadId(row) {
  try {
    const link = row.querySelector('[role="gridcell"] a[href*="/t/"]') || row.querySelector('a[href*="/t/"]');
    const href = link?.getAttribute('href');
    if (!href) return null;
    const match = href.match(/\/t\/([0-9]+)\//);
    return match ? match[1] : null;
  } catch (err) {
    console.error('[Messenger Index] extractThreadId failed:', err);
    return null;
  }
}

function findAvatarContainer(row) {
  try {
    const link = row.querySelector('[role="gridcell"] a[href*="/t/"]') || row.querySelector('a[href*="/t/"]');
    if (!link) return null;

    const img = link.querySelector('img');
    if (img) return img.parentElement && img.parentElement !== link ? img.parentElement : img;

    // Some avatars render as a fallback silhouette SVG instead of an <img>.
    const svg = link.querySelector('svg');
    if (svg) return svg.parentElement && svg.parentElement !== link ? svg.parentElement : svg;

    // Last resort: the first element inside the link, which is where the
    // avatar sits before the name text in the observed DOM structure.
    return link.firstElementChild || link;
  } catch (err) {
    console.error('[Messenger Index] findAvatarContainer failed:', err);
    return null;
  }
}

function ensurePositioned(el) {
  try {
    const position = window.getComputedStyle(el).position;
    if (!position || position === 'static') {
      el.style.position = 'relative';
    }
  } catch (err) {
    console.error('[Messenger Index] ensurePositioned failed:', err);
  }
}

function applyBadgeAppearance(badge, storageEntry) {
  try {
    const isIndexed = !!(storageEntry && storageEntry.lastIndexedAt);
    badge.style.backgroundColor = isIndexed ? '#22c55e' : '#6b7280';
    badge.style.opacity = isIndexed ? '1' : '0.6';
    badge.title = isIndexed ? 'Indexed' : 'Not indexed — click to index';
  } catch (err) {
    console.error('[Messenger Index] applyBadgeAppearance failed:', err);
  }
}

async function refreshBadgeState(badge, threadId) {
  try {
    const key = STORAGE_PREFIX + threadId;
    const result = await chrome.storage.local.get(key);
    applyBadgeAppearance(badge, result?.[key]);
  } catch (err) {
    console.error('[Messenger Index] refreshBadgeState failed:', err);
  }
}

function handleBadgeClick(event, badge, threadId) {
  event.stopPropagation();
  event.preventDefault();
  try {
    // Fire-and-forget: background.js does the actual indexing work.
    // NOTE: background.js does not yet have a matching
    // chrome.runtime.onMessage listener for action === 'index_chat_request' —
    // that listener needs to be added there; out of scope for this file.
    chrome.runtime.sendMessage({ action: 'index_chat_request', threadId });
  } catch (err) {
    console.error('[Messenger Index] sendMessage failed:', err);
  }

  try {
    badge.dataset.pending = '1';
    badge.textContent = '⏳';
    badge.style.backgroundColor = 'transparent';
    badge.style.display = 'flex';
    badge.style.alignItems = 'center';
    badge.style.justifyContent = 'center';
    badge.style.fontSize = '9px';
    badge.style.lineHeight = '1';

    setTimeout(() => {
      try {
        delete badge.dataset.pending;
        badge.textContent = '';
        refreshBadgeState(badge, threadId);
      } catch (err) {
        console.error('[Messenger Index] pending revert failed:', err);
      }
    }, PENDING_RESET_MS);
  } catch (err) {
    console.error('[Messenger Index] handleBadgeClick optimistic UI failed:', err);
  }
}

function createBadgeElement(threadId) {
  const badge = document.createElement('div');
  badge.className = 'msgidx-badge';
  badge.dataset.threadId = threadId;
  Object.assign(badge.style, {
    position: 'absolute',
    top: '-2px',
    right: '-2px',
    width: '11px',
    height: '11px',
    borderRadius: '50%',
    border: '2px solid white',
    boxSizing: 'border-box',
    zIndex: '999999',
    cursor: 'pointer',
    transition: 'background-color 0.2s ease'
  });
  badge.addEventListener('click', (event) => handleBadgeClick(event, badge, threadId));
  return badge;
}

async function processRow(row) {
  const threadId = extractThreadId(row);
  if (!threadId) return;

  let badge = row.querySelector('.msgidx-badge');
  if (!badge) {
    const avatarContainer = findAvatarContainer(row);
    if (!avatarContainer) return;
    ensurePositioned(avatarContainer);
    badge = createBadgeElement(threadId);
    avatarContainer.appendChild(badge);
    row.setAttribute('data-idx-badge', '1');
  } else if (badge.dataset.threadId !== threadId) {
    // Facebook's chat list is virtualized and reuses row DOM nodes on scroll —
    // the same row element can represent a different thread over time.
    badge.dataset.threadId = threadId;
    badge.addEventListener('click', (event) => handleBadgeClick(event, badge, threadId), { once: false });
  }

  if (badge.dataset.pending === '1') return; // don't clobber the optimistic ⏳ state

  await refreshBadgeState(badge, threadId);
}

async function scanAndInjectBadges() {
  const rows = getChatRows();
  for (const row of rows) {
    try {
      await processRow(row);
    } catch (err) {
      console.error('[Messenger Index] processRow failed:', err);
    }
  }
}

let scanTimeout = null;
function scheduleScan() {
  if (scanTimeout) clearTimeout(scanTimeout);
  scanTimeout = setTimeout(() => {
    scanAndInjectBadges();
  }, SCAN_DEBOUNCE_MS);
}

function initObserver() {
  try {
    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[Messenger Index] MutationObserver attached');
  } catch (err) {
    console.error('[Messenger Index] initObserver failed:', err);
  }
}

// React to indexing completing (written by background.js elsewhere) so
// badges update without waiting for the next DOM mutation.
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    try {
      if (areaName !== 'local') return;
      const changedThreadIds = Object.keys(changes)
        .filter((key) => key.startsWith(STORAGE_PREFIX))
        .map((key) => key.slice(STORAGE_PREFIX.length));
      if (!changedThreadIds.length) return;

      changedThreadIds.forEach((threadId) => {
        document.querySelectorAll(`.msgidx-badge[data-thread-id="${threadId}"]`).forEach((badge) => {
          if (badge.dataset.pending === '1') return;
          refreshBadgeState(badge, threadId);
        });
      });
    } catch (err) {
      console.error('[Messenger Index] storage.onChanged handler failed:', err);
    }
  });
} catch (err) {
  console.error('[Messenger Index] failed to attach storage.onChanged listener:', err);
}

scheduleScan();
initObserver();
