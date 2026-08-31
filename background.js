// Claude Browser Proxy - Background Service Worker
// Uses MQTT.js library for WebSocket connection to Mosquitto broker

importScripts('mqtt.min.js');

const VERSION = chrome.runtime.getManifest().version;
const MQTT_URL = 'ws://localhost:9001';
const TOPICS = {
  command: 'claude/browser/command',
  response: 'claude/browser/response',
  page: 'claude/browser/page',
  answer: 'claude/browser/answer',
  status: 'claude/browser/status',
  state: 'claude/browser/state'  // Loading/tool state
};

// Stable across reconnects and across worker restarts, so the broker can resume
// our session and hold the command subscription while the MV3 worker is suspended.
const MQTT_CLIENT_ID = 'claude-browser-proxy';
// How old a command may be and still run. Long enough to cover a worker nap and
// the broker's redelivery, short enough that yesterday's queued command never
// fires at you. Only applies to commands that carry a `ts`.
const MAX_COMMAND_AGE_MS = 120000;

let client = null;
let isConnected = false;
// Whether the broker has confirmed our subscription to the command topic.
// Tracked separately from isConnected because the two failed apart on
// 2026-08-31: the extension kept publishing keepalive "online" for hours while
// nothing was subscribed, so every command was dropped and the status topic
// still said the bridge was healthy. Publishing is not the same as listening.
let isSubscribed = false;

// Subscribe at QoS 1 so the broker queues commands published while we are asleep.
// Re-callable: the keepalive alarm uses it to repair a lost subscription.
function subscribeToCommands() {
  if (!client) return;
  client.subscribe(TOPICS.command, { qos: 1 }, (err, granted) => {
    if (err) {
      isSubscribed = false;
      console.error('[MQTT] Subscribe error:', err);
    } else {
      // A granted qos of 128 means the broker refused the subscription.
      const ok = Array.isArray(granted) && granted.length > 0 && granted[0].qos !== 128;
      isSubscribed = ok;
      console.log('[MQTT]', ok ? 'Subscribed to' : 'Subscription REFUSED for', TOPICS.command);
    }
    publishStatus();
  });
}

// One place that builds the status payload, so `subscribed` can never be
// omitted by a caller that only cares about liveness.
function publishStatus(extra) {
  if (!client) return;
  try {
    client.publish(TOPICS.status, JSON.stringify({
      status: 'online',
      subscribed: isSubscribed,   // false here means commands are being dropped
      clientId: MQTT_CLIENT_ID,
      timestamp: Date.now(),
      version: VERSION,
      ...(extra || {})
    }), { retain: true });
  } catch (e) { /* next alarm retries */ }
}

// Injected into the Gemini page to turn a mode on or off. Defined once and used
// by both the MQTT `select_mode` action and the side panel's message handler,
// which were previously two near-copies of the same broken logic.
//
// WHAT WAS BROKEN. It clicked the Tools button once, waited 800ms, then read
// [role="menuitemcheckbox"]. Two things defeat that, both measured live on
// 2026-08-31:
//
//   1. The menu's content is lazily loaded. The first open renders an EMPTY
//      shell — 2 descendant elements and zero items — while a later open of the
//      same menu renders 88. So the first attempt after a page load always found
//      zero items and reported "not found in menu".
//   2. Canvas, Deep research and Guided learning are NOT at the top level. They
//      live behind a "More tools" submenu (data-test-id="more-tools-button").
//      Nothing here ever expanded it, so those three were unreachable by name
//      even when the menu did render.
//
// Note the spelling: Gemini writes "Deep research", lowercase r.
async function selectModeInPage(modeName) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const debug = { attempts: [] };
  const findTools = () =>
    document.querySelector('button[aria-label="Upload & tools"]') ||
    document.querySelector('button[aria-label*="tools" i]') ||
    Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Tools');
  const menuUp = () => document.querySelectorAll('[role="menu"]').length > 0;
  const items = () => Array.from(document.querySelectorAll('[role="menuitemcheckbox"]'));
  const firstLine = el => ((el.textContent || '').trim().split('\n')[0] || '').trim();

  const btn = findTools();
  if (!btn) return { error: 'Tools button not found' };

  // Open the menu and make sure it actually has items. An empty menu is the
  // lazy-load case, and closing and re-opening is what fills it, so retry rather
  // than reporting the mode missing.
  let opened = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
    if (!menuUp()) {
      btn.click();
      let waited = 0;
      while (!menuUp() && waited < 5000) { await sleep(250); waited += 250; }
    }
    // Give the lazily-loaded content a chance to appear.
    let waited = 0;
    while (items().length === 0 && waited < 3000) { await sleep(250); waited += 250; }
    debug.attempts.push({ attempt, menu: menuUp(), items: items().length });
    if (items().length > 0) { opened = true; break; }
    // Empty shell: close it, so the next pass re-opens a loaded menu.
    if (menuUp()) { btn.click(); await sleep(500); }
  }
  if (!opened) return { error: 'Tools menu opened but never rendered any items', debug };

  const wanted = (modeName || '').trim().toLowerCase();
  const find = () => items().find(i => firstLine(i).toLowerCase() === wanted);

  // Canvas / Deep research / Guided learning sit behind "More tools".
  if (!find()) {
    const more = document.querySelector('[data-test-id="more-tools-button"]') ||
      items().concat(Array.from(document.querySelectorAll('button')))
             .find(el => /^more tools$/i.test(firstLine(el)));
    if (more) {
      debug.expandedMoreTools = true;
      more.click();
      let waited = 0;
      while (!find() && waited < 3000) { await sleep(250); waited += 250; }
    }
  }

  debug.visible = items().map(firstLine);
  const target = find();
  if (!target) return { error: modeName + ' not found in menu', debug };

  const wasChecked = target.getAttribute('aria-checked') === 'true';
  target.click();
  await sleep(800);

  // Read the state back rather than assuming the click took. Selecting an item
  // CLOSES the menu, so the item we just clicked is usually gone from the DOM by
  // now and aria-checked cannot be re-read. Gemini puts the authoritative signal
  // in the composer instead: while a mode is on, a button labelled
  // "Deselect <mode>" is present, and it disappears when the mode goes off.
  // Measured both ways on 2026-08-31 for Deep research.
  const deselectFor = () => Array.from(document.querySelectorAll('button[aria-label]'))
    .find(b => /^deselect /i.test(b.getAttribute('aria-label') || '') &&
               (b.getAttribute('aria-label') || '').toLowerCase().includes(wanted));

  const after = items().find(i => firstLine(i).toLowerCase() === wanted);
  let nowChecked = null;
  let verifiedBy = null;
  if (after) {
    nowChecked = after.getAttribute('aria-checked') === 'true';
    verifiedBy = 'aria-checked';
  } else {
    // Wait briefly: the composer control appears as the menu animates away.
    let waited = 0;
    while (waited < 2000 && !deselectFor() && wasChecked === false) { await sleep(250); waited += 250; }
    nowChecked = !!deselectFor();
    verifiedBy = 'composer-deselect-button';
  }
  debug.wasChecked = wasChecked;
  debug.nowChecked = nowChecked;
  debug.verifiedBy = verifiedBy;

  if (menuUp()) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // Only claim success when the observed state actually changed. A dispatched
  // click is not evidence.
  const changed = nowChecked !== wasChecked;
  return {
    success: changed,
    verified: true,
    mode: modeName,
    toggled: nowChecked ? 'on' : 'off',
    ...(changed ? {} : { error: 'clicked ' + modeName + ' but its state did not change' }),
    debug
  };
}

// Actions routed to a Messenger tab instead of a Gemini tab
const MESSENGER_ACTIONS = new Set(['list_chats', 'index_chat', 'get_index_status', 'read_chat', 'send_chat_message']);

// Navigate a tab and wait for it to finish loading (no existing helper in this
// file does this — other actions either don't navigate or don't need to wait).
function navigateAndWait(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Navigation timed out: ' + url));
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

// Connect to MQTT broker with LWT
function connect() {
  console.log('[MQTT] Connecting to', MQTT_URL);

  client = mqtt.connect(MQTT_URL, {
    // A STABLE client id, deliberately. It used to be 'claude-browser-' + Date.now(),
    // which gave the broker a brand-new identity on every reconnect, so it could never
    // resume a session or hold a subscription on our behalf.
    clientId: MQTT_CLIENT_ID,
    // Persistent session. Chrome suspends an MV3 worker between alarms; with a clean
    // session the broker forgets our subscription the moment the socket drops and every
    // command sent in that window is lost with no trace. clean:false makes the broker
    // keep the subscription and queue QoS>=1 commands until we wake.
    // NOTE: the publisher must also send at QoS>=1 — QoS 0 messages are never queued.
    clean: false,
    keepalive: 15, // 15 seconds - LWT triggers after ~22 sec if no ping
    reconnectPeriod: 5000, // Reconnect every 5 seconds
    will: {
      topic: TOPICS.status,
      payload: JSON.stringify({ status: 'offline', timestamp: Date.now(), version: VERSION }),
      qos: 0,
      retain: true
    }
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected!');
    isConnected = true;
    updateBadge(true);
    subscribeToCommands();

    // Publish "online" status (retained) - overrides LWT "offline"
    publishStatus();

    // Push current mode/model state (retained) so consoles start in sync
    chrome.tabs.query({ url: 'https://gemini.google.com/*' }).then(ts => {
      const t = ts.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      if (t) publishModeState(t.id);
    }).catch(() => {});
  });

  client.on('message', (topic, message) => {
    console.log('[MQTT] Received:', topic);
    try {
      const command = JSON.parse(message.toString());

      // Drop stale commands — but by AGE, not by connection time.
      //
      // This used to be `command.ts < connectedAt`, which is wrong now that the
      // session is persistent: the broker deliberately holds commands while the
      // MV3 worker is suspended and delivers them on reconnect, so every rescued
      // command necessarily predates the new connection and would be thrown away
      // by that test — silently undoing the queuing it was paired with.
      // An age limit keeps the original intent (never replay an ancient retained
      // command) while letting a command queued during a worker nap through.
      if (command.ts && (Date.now() - command.ts) > MAX_COMMAND_AGE_MS) {
        console.log('[MQTT] Ignoring stale command, age', Date.now() - command.ts, 'ms >', MAX_COMMAND_AGE_MS);
        return;
      }

      handleCommand(topic, command);
    } catch (e) {
      handleCommand(topic, message.toString());
    }
  });

  client.on('close', () => {
    console.log('[MQTT] Disconnected');
    isConnected = false;
    // The subscription does not survive a dropped socket from our side either;
    // clearing it here is what lets the keepalive notice and repair it.
    isSubscribed = false;
    updateBadge(false);
  });

  client.on('error', (err) => {
    console.error('[MQTT] Error:', err);
  });
}

// Publish message (with optional retain)
function publish(topic, message, retain = false) {
  if (client && isConnected) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    client.publish(topic, payload, { retain });
    console.log('[MQTT] Published to', topic, retain ? '(retained)' : '');
  }
}

// Read the current Gemini model + active modes and publish them (RETAINED) so
// consoles/dashboards can show mode state without polling. Retained means a late
// subscriber gets the last value immediately, and it survives worker suspension.
// Called on every model/mode change (see handleCommand tail) + keepalive + connect.
async function publishModeState(tabId) {
  if (!tabId) return;
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const b = document.querySelector('button[data-test-id="bard-mode-menu-button"], .input-area-switch');
        let model = b ? (b.getAttribute('aria-label') || '') : '';
        const i = model.toLowerCase().indexOf('currently');
        model = (i >= 0 ? model.slice(i + 9) : model).replace(/\s+/g, ' ').trim();
        // This reads the composer's quick-pill row, NOT the Tools menu — the menu
        // is shut at this point and its items are not in the DOM. Two facts follow,
        // and both were mistaken for evidence about the menu on 2026-08-30:
        //   1. a mode that lives only inside the menu can never appear here;
        //   2. the pills are A/B tested, so two accounts legitimately differ.
        // The hardcoded name list below can also only ever return names we already
        // expected, so it cannot discover a renamed or new mode. Use the
        // `list_modes` action for a real answer; this stays as a cheap hint.
        const N = ['deep research', 'canvas', 'create image', 'create video', 'create music', 'guided learning'];
        const modes = [...document.querySelectorAll('button')].filter(x =>
          x.offsetParent !== null && x.querySelector('mat-icon') &&
          N.indexOf((x.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()) >= 0
        ).map(x => (x.textContent || '').replace(/\s+/g, ' ').trim());
        // Label the provenance so an empty array cannot be read as "no modes exist".
        return { model, modes, modesSource: 'composer-quick-pills', modesComplete: false };
      }
    });
    const s = r && r[0] && r[0].result;
    if (s) publish('claude/browser/mode_state', { ...s, timestamp: Date.now() }, true);
  } catch (e) { /* tab isn't Gemini or scripting unavailable — ignore */ }
}

// Update extension badge and storage
async function updateBadge(connected) {
  chrome.storage.local.set({ mqttConnected: connected });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onGemini = tab && tab.url && tab.url.includes('gemini.google.com');
    chrome.action.setBadgeText({ text: VERSION }); // Always show full version "2.0.5"
    if (onGemini && connected) {
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // green
    } else {
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // red
    }
  } catch (e) {
    chrome.action.setBadgeText({ text: VERSION });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
}

// Broadcast to sidepanel via storage
async function broadcastLog(type, data) {
  try {
    const stored = await chrome.storage.local.get('logs');
    const logs = stored.logs || [];
    logs.push({ type, data, time: Date.now() });
    if (logs.length > 50) logs.shift();
    await chrome.storage.local.set({ logs });
  } catch (e) {
    console.error('[Log] Error:', e);
  }
}

// Handle commands from Claude Code
async function handleCommand(topic, command) {
  console.log('[Claude] Command:', command);
  await broadcastLog('cmd', command);

  let result;
  // Declared HERE, not inside the try, because the response object below reads
  // `tab` AFTER the catch. With `let tab` inside the try it is out of scope at
  // that point, so building the response threw ReferenceError and the publish on
  // the next line never ran — every command did its work and then answered
  // nothing. Proven 2026-08-31 by the extension logging each received command
  // while no response was ever published.
  let tab;

  try {
    // === TAB MANAGEMENT ACTIONS (don't require existing Gemini tab) ===
    switch (command.action) {
      case 'transcribe': {
        // All-in-one: create new tab + wait + send transcribe prompt
        const videoUrl = command.url || command.video;
        if (!videoUrl) {
          result = { error: 'url or video parameter required' };
          publish(TOPICS.response, { ...result, id: command.id, action: command.action });
          return;
        }

        // 1. Create new Gemini tab
        const transcribeTab = await chrome.tabs.create({
          url: 'https://gemini.google.com/app',
          active: true
        });

        // 2. Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 3. Send chat prompt
        const prompt = command.prompt || `Transcribe this YouTube video with timestamps:

${videoUrl}

Format:

[00:00]
Text spoken here.

[01:00]
Next section.

Use double newlines between timestamps!`;

        await chrome.scripting.executeScript({
          target: { tabId: transcribeTab.id },
          func: (text) => {
            const selectors = [
              'rich-textarea .ql-editor',
              'rich-textarea [contenteditable="true"]',
              '.ql-editor[contenteditable="true"]',
              '[contenteditable="true"]'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                el.focus();
                el.innerHTML = text.replace(/\n/g, '<br>');
                el.dispatchEvent(new Event('input', { bubbles: true }));
                setTimeout(() => {
                  const sendBtn = document.querySelector('button[aria-label="Send message"], button[aria-label*="Send"], button:has(mat-icon[fonticon="arrow_upward"]), button.send-button, button[class*="send"]');
                  if (sendBtn) sendBtn.click();
                }, 500);
                return { success: true };
              }
            }
            return { error: 'Input not found' };
          },
          args: [prompt]
        });

        result = { success: true, tabId: transcribeTab.id, video: videoUrl };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;
      }

      case 'create_tab': {
        // Create new Gemini tab and return its ID
        const createdTab = await chrome.tabs.create({
          url: command.url || 'https://gemini.google.com/app',
          active: command.active !== false  // default: make active
        });
        result = {
          tabId: createdTab.id,
          url: createdTab.pendingUrl || createdTab.url,
          success: true
        };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;
      }

      case 'list_tabs':
        // List all Gemini tabs
        const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
        result = {
          tabs: geminiTabs.map(t => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
            windowId: t.windowId
          })),
          count: geminiTabs.length,
          success: true
        };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'new_tab': {
        // Create a new Gemini tab
        const url = command.url || 'https://gemini.google.com/app';
        const tab = await chrome.tabs.create({ url, active: true });
        result = {
          success: true,
          tabId: tab.id,
          url,
          message: 'New tab created'
        };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;
      }

      case 'focus_tab':
        // Focus a specific tab
        if (!command.tabId) throw new Error('tabId required for focus_tab');
        await chrome.tabs.update(command.tabId, { active: true });
        const focusedTab = await chrome.tabs.get(command.tabId);
        await chrome.windows.update(focusedTab.windowId, { focused: true });
        result = { success: true, tabId: command.tabId };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'inject_badge':
        // DEBUG: Inject badge into specific tab
        if (!command.tabId) throw new Error('tabId required');
        await chrome.scripting.executeScript({
          target: { tabId: command.tabId },
          func: (id, msg) => {
            let badge = document.getElementById('claude-tab-badge');
            if (!badge) {
              badge = document.createElement('div');
              badge.id = 'claude-tab-badge';
              badge.style.cssText = 'position:fixed;top:10px;right:10px;background:#22c55e;color:white;padding:12px 20px;border-radius:8px;font-family:monospace;font-size:16px;font-weight:bold;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
              document.body.appendChild(badge);
            }
            badge.textContent = 'TAB ' + id + (msg ? ': ' + msg : '');
          },
          args: [command.tabId, command.text || '']
        });
        result = { success: true, tabId: command.tabId, injected: true };
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'inject_response_actions':
        // Inject custom buttons after the last button in each response
        if (!command.tabId) throw new Error('tabId required');
        result = await chrome.scripting.executeScript({
          target: { tabId: command.tabId },
          func: (actions) => {
            let injected = 0;
            const debug = [];

            // Find all model-response elements
            const modelResponses = document.querySelectorAll('model-response');
            debug.push('Found ' + modelResponses.length + ' model-responses');

            modelResponses.forEach((modelResponse, index) => {
              // Skip if already injected
              if (modelResponse.querySelector('.claude-response-actions')) return;

              // Find ALL buttons, get the last few (action bar is at bottom)
              const allButtons = Array.from(modelResponse.querySelectorAll('button'));
              debug.push('Response ' + index + ': ' + allButtons.length + ' buttons');

              if (allButtons.length < 3) return;

              // Last button should be the ⋮ menu
              const lastBtn = allButtons[allButtons.length - 1];
              const actionBar = lastBtn.parentElement;

              // Create custom buttons container
              const customContainer = document.createElement('div');
              customContainer.className = 'claude-response-actions';
              customContainer.style.cssText = 'display:inline-flex;gap:8px;margin-left:12px;align-items:center;';

              actions.forEach(action => {
                const btn = document.createElement('button');
                btn.textContent = action.label;
                btn.title = action.title || action.label;
                btn.style.cssText = 'background:transparent;border:none;color:#9aa0a6;cursor:pointer;font-size:16px;padding:4px;opacity:0.7;transition:opacity 0.2s;';
                btn.onmouseenter = () => btn.style.opacity = '1';
                btn.onmouseleave = () => btn.style.opacity = '0.7';
                btn.onclick = () => {
                  const msgContent = modelResponse.querySelector('MESSAGE-CONTENT, message-content');
                  window.postMessage({
                    type: 'claude-response-action',
                    action: action.id,
                    responseIndex: index,
                    text: msgContent?.innerText?.substring(0, 500) || ''
                  }, '*');
                };
                customContainer.appendChild(btn);
              });

              // Insert after the last button
              lastBtn.after(customContainer);
              injected++;
              debug.push('Response ' + index + ': injected');
            });

            return { success: true, injected, total: modelResponses.length, debug };
          },
          args: [command.actions || [
            { id: 'save', label: '💾', title: 'Save response' },
            { id: 'copy', label: '📋', title: 'Copy to clipboard' }
          ]]
        });
        result = result[0]?.result;
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'auto_inject_start':
        // Start auto-injection loop using MutationObserver
        if (!command.tabId) throw new Error('tabId required');
        result = await chrome.scripting.executeScript({
          target: { tabId: command.tabId },
          func: (actions) => {
            // Don't start twice
            if (window._claudeAutoInject) return { already: true };

            const injectButtons = () => {
              const modelResponses = document.querySelectorAll('model-response');
              let injected = 0;

              modelResponses.forEach((modelResponse, index) => {
                if (modelResponse.querySelector('.claude-response-actions')) return;

                const allButtons = Array.from(modelResponse.querySelectorAll('button'));
                if (allButtons.length < 3) return;

                const lastBtn = allButtons[allButtons.length - 1];

                const container = document.createElement('div');
                container.className = 'claude-response-actions';
                container.style.cssText = 'display:inline-flex;gap:8px;margin-left:12px;align-items:center;';

                actions.forEach(action => {
                  const btn = document.createElement('button');
                  btn.textContent = action.label;
                  btn.title = action.title || action.label;
                  btn.style.cssText = 'background:transparent;border:none;color:#9aa0a6;cursor:pointer;font-size:16px;padding:4px;opacity:0.7;transition:opacity 0.2s;';
                  btn.onmouseenter = () => btn.style.opacity = '1';
                  btn.onmouseleave = () => btn.style.opacity = '0.7';
                  btn.onclick = () => {
                    const msgContent = modelResponse.querySelector('MESSAGE-CONTENT, message-content');
                    window.postMessage({
                      type: 'claude-response-action',
                      action: action.id,
                      responseIndex: index,
                      text: msgContent?.innerText?.substring(0, 500) || ''
                    }, '*');
                  };
                  container.appendChild(btn);
                });

                lastBtn.after(container);
                injected++;
              });

              return injected;
            };

            // Initial inject
            const initial = injectButtons();

            // Watch for new responses
            const observer = new MutationObserver(() => {
              injectButtons();
            });

            observer.observe(document.body, {
              childList: true,
              subtree: true
            });

            window._claudeAutoInject = { observer, actions };
            return { started: true, initial };
          },
          args: [command.actions || [
            { id: 'save', label: '💾', title: 'Save' },
            { id: 'learn', label: '📚', title: 'Learn' }
          ]]
        });
        result = result[0]?.result;
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;

      case 'auto_inject_stop':
        // Stop auto-injection
        if (!command.tabId) throw new Error('tabId required');
        result = await chrome.scripting.executeScript({
          target: { tabId: command.tabId },
          func: () => {
            if (window._claudeAutoInject) {
              window._claudeAutoInject.observer.disconnect();
              delete window._claudeAutoInject;
              return { stopped: true };
            }
            return { notRunning: true };
          }
        });
        result = result[0]?.result;
        publish(TOPICS.response, { ...result, id: command.id, action: command.action });
        return;
    }

    // === RESOLVE TARGET TAB ===
    if (command.tabId) {
      // Use specific tab if provided - simple and direct
      tab = await chrome.tabs.get(command.tabId);
      if (!tab) throw new Error('Tab not found: ' + command.tabId);
      console.log('[Tab] Using specific tab:', command.tabId, tab.url);
      // INJECT TABID INTO PAGE FOR DEBUGGING
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (id) => {
          let badge = document.getElementById('claude-tab-badge');
          if (!badge) {
            badge = document.createElement('div');
            badge.id = 'claude-tab-badge';
            badge.style.cssText = 'position:fixed;top:10px;right:10px;background:#22c55e;color:white;padding:8px 16px;border-radius:8px;font-family:monospace;font-size:14px;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
            document.body.appendChild(badge);
          }
          badge.textContent = 'TAB: ' + id;
          badge.style.animation = 'none';
          badge.offsetHeight; // Trigger reflow
          badge.style.animation = 'pulse 0.5s';
        },
        args: [tab.id]
      });
    } else if (MESSENGER_ACTIONS.has(command.action)) {
      // Find most recently active Messenger tab
      const messengerTabs = await chrome.tabs.query({
        url: ['https://www.facebook.com/messages/*', 'https://www.messenger.com/*']
      });
      if (messengerTabs.length > 0) {
        messengerTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        tab = messengerTabs[0];
      }
      if (!tab) {
        [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
    } else {
      // Find most recently active Gemini tab
      const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      if (geminiTabs.length > 0) {
        // Sort by lastAccessed (most recent first)
        geminiTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        tab = geminiTabs[0];
      }
      if (!tab) {
        [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
    }

    if (!tab) throw new Error('No tab found');

    if (MESSENGER_ACTIONS.has(command.action)) {
      if (!tab.url?.includes('facebook.com/messages') && !tab.url?.includes('messenger.com')) {
        throw new Error('Tab is not Messenger. Please open facebook.com/messages or messenger.com');
      }
    } else if (!tab.url?.includes('gemini.google.com')) {
      throw new Error('Tab is not Gemini. Please open gemini.google.com or use create_tab');
    }

    // === GEMINI TAB ACTIONS ===
    switch (command.action) {
      case 'get_html':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.documentElement.outerHTML
        });
        result = { html: result[0]?.result?.substring(0, 50000) };
        break;

      case 'get_text':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.body.innerText
        });
        result = { text: result[0]?.result };
        break;

      case 'get_url':
        result = { url: tab.url, title: tab.title };
        break;

      case 'get_state':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Gemini State Detector
            const isLoading = () => {
              // Only check actual progress spinner, NOT avatar animation (always visible)
              const spinner = document.querySelector('mat-mdc-progress-spinner.mdc-circular-progress--indeterminate');
              if (spinner) {
                const rect = spinner.getBoundingClientRect();
                // Must be in response area (not in sidebar/header)
                if (rect.top > 100 && rect.top < window.innerHeight && rect.bottom > 0) return true;
              }
              // Also check for streaming indicator (text being typed)
              const streaming = document.querySelector('.streaming-indicator, [data-streaming="true"]');
              if (streaming) return true;
              return false;
            };

            const getActiveTool = () => {
              if (document.querySelector('img.youtube-icon')) return 'youtube';
              if (document.querySelector('img.tool-logo[src*="youtube"]')) return 'youtube';
              if (document.querySelector('img.tool-logo[src*="search"]')) return 'search';
              if (document.querySelector('img.tool-logo[src*="maps"]')) return 'maps';
              return null;
            };

            return {
              loading: isLoading(),
              tool: getActiveTool(),
              responseCount: document.querySelectorAll('MESSAGE-CONTENT, message-content').length,
              timestamp: Date.now()
            };
          }
        });
        result = result[0]?.result;
        // Auto-publish state to dedicated topic
        publish(TOPICS.state, result, false);
        break;

      case 'get_videos':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const videos = Array.from(document.querySelectorAll('video'));
            return videos.map(v => ({
              src: v.src || v.currentSrc,
              sources: Array.from(v.querySelectorAll('source')).map(s => s.src)
            }));
          }
        });
        result = { videos: result[0]?.result };
        break;

      case 'click':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const el = document.querySelector(sel);
            if (el) { el.click(); return { success: true }; }
            return { error: 'Not found' };
          },
          args: [command.selector]
        });
        result = result[0]?.result;
        break;

      case 'clickText':
        // Click element by text content (case-insensitive, partial match)
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (searchText, exactMatch) => {
            const text = searchText.toLowerCase();
            const clickable = document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a, [onclick], [tabindex]');
            for (const el of clickable) {
              const elText = el.textContent?.trim().toLowerCase() || '';
              const matches = exactMatch ? elText === text : elText.includes(text);
              if (matches) {
                el.click();
                return { success: true, text: el.textContent?.trim().substring(0, 50), tag: el.tagName };
              }
            }
            return { error: 'No element with text: ' + searchText };
          },
          args: [command.text, command.exact || false]
        });
        result = result[0]?.result;
        break;

      case 'type':
        // Smart default selector for Gemini input
        const typeSelector = command.selector || '[contenteditable="true"], textarea, input[type="text"]';
        const typeText = command.text || '';
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, text) => {
            const el = document.querySelector(sel);
            if (el) {
              el.focus();
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              } else if (el.isContentEditable || el.getAttribute('contenteditable')) {
                // Clear existing content and use execCommand for rich editors
                el.innerHTML = '';
                document.execCommand('insertText', false, text);
                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
              } else {
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
              return { success: true, selector: sel };
            }
            return { error: 'Element not found', selector: sel };
          },
          args: [typeSelector, typeText]
        });
        result = result[0]?.result;
        break;

      case 'find':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const els = document.querySelectorAll(sel);
            return { count: els.length, found: els.length > 0 };
          },
          args: [command.selector]
        });
        result = result[0]?.result;
        break;

      case 'key':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (key) => {
            const event = new KeyboardEvent('keydown', { key: key, bubbles: true });
            document.activeElement.dispatchEvent(event);
            return { success: true };
          },
          args: [command.key]
        });
        result = result[0]?.result;
        break;

      case 'wait_response':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (timeout) => {
            return new Promise((resolve) => {
              const startTime = Date.now();
              const getResponses = () => document.querySelectorAll('MESSAGE-CONTENT, message-content, [data-message-id], .model-response-text');
              const initialCount = getResponses().length;
              let lastText = '';
              let stableCount = 0;

              const checkResponse = () => {
                const responses = getResponses();
                if (responses.length > initialCount) {
                  const lastResponse = responses[responses.length - 1];
                  const text = (lastResponse.textContent || lastResponse.innerText || '').trim();

                  if (text === lastText && text.length > 5) {
                    stableCount++;
                    if (stableCount >= 3) {
                      resolve({ answer: text, success: true });
                      return true;
                    }
                  } else {
                    lastText = text;
                    stableCount = 0;
                  }
                }

                if (Date.now() - startTime > timeout) {
                  if (lastText.length > 5) {
                    resolve({ answer: lastText, success: true });
                  } else {
                    resolve({ error: 'Timeout waiting for response' });
                  }
                  return true;
                }
                return false;
              };

              const interval = setInterval(() => {
                if (checkResponse()) clearInterval(interval);
              }, 500);
            });
          },
          args: [command.timeout || 15000]
        });
        result = result[0]?.result;
        if (result?.answer) {
          publish(TOPICS.answer, { answer: result.answer, timestamp: Date.now() }, true);
          await broadcastLog('answer', { answer: result.answer });
          // Store directly for sidebar
          await chrome.storage.local.set({ lastAnswer: result.answer, lastAnswerTime: Date.now() });
        }
        break;

      case 'get_response':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const selectors = [
              'MESSAGE-CONTENT',     // Gemini uses uppercase custom element
              'message-content',     // fallback lowercase
              '[data-message-id]',
              '.model-response-text',
              '.response-container',
              '.markdown-main-panel'
            ];

            let responses = [];
            for (const sel of selectors) {
              const els = document.querySelectorAll(sel);
              if (els.length > 0) {
                responses = els;
                break;
              }
            }

            if (responses.length === 0) {
              return { error: 'No Gemini responses found on page' };
            }

            const lastResponse = responses[responses.length - 1];
            const text = (lastResponse.textContent || lastResponse.innerText || '').trim();

            if (!text || text.length < 5) {
              return { error: 'Response is empty or too short' };
            }

            return { answer: text, success: true, count: responses.length };
          }
        });
        result = result[0]?.result;
        if (result?.answer) {
          publish(TOPICS.answer, { answer: result.answer, timestamp: Date.now() }, true);
          await broadcastLog('answer', { answer: result.answer });
          // Store directly for sidebar
          await chrome.storage.local.set({ lastAnswer: result.answer, lastAnswerTime: Date.now() });
        }
        break;

      case 'screenshot':
        const dataUrl = await chrome.tabs.captureVisibleTab();
        result = { screenshot: dataUrl };
        break;

      case 'download':
        const dlId = await chrome.downloads.download({
          url: command.url,
          filename: command.filename
        });
        result = { downloadId: dlId };
        break;

      case 'describe': {
        // Selector -> what each matching element actually IS: its label, role and
        // visibility. Reconnaissance only, no clicks, no state change.
        //
        // This exists because the two ways to ask that question are both dead on
        // gemini.google.com: `execute` runs eval() and the page CSP forbids it
        // ("'unsafe-eval' is not an allowed source of script"), and `get_html`
        // truncates at 50000 characters, which on this page ends inside <head>
        // before any composer markup. The composer's mode pills are icon-only, so
        // their names live in aria-label and nowhere in innerText.
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, max) => {
            const els = Array.from(document.querySelectorAll(sel));
            return {
              total: els.length,
              elements: els.slice(0, max).map(el => ({
                tag: el.tagName.toLowerCase(),
                label: el.getAttribute('aria-label'),
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
                role: el.getAttribute('role'),
                testId: el.getAttribute('data-test-id'),
                checked: el.getAttribute('aria-checked'),
                haspopup: el.getAttribute('aria-haspopup'),
                visible: el.offsetParent !== null
              }))
            };
          },
          args: [command.selector, command.max || 40]
        });
        result = result[0]?.result;
        break;
      }

      case 'execute':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (code) => {
            try {
              return eval(code);
            } catch (e) {
              return { error: e.message };
            }
          },
          args: [command.code]
        });
        result = result[0]?.result;
        break;

      case 'select_model':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (modelName) => {
            const allBtns = Array.from(document.querySelectorAll('button'));
            const debug = { totalButtons: allBtns.length, candidates: [] };

            let dropdownBtn = null;
            // PRIMARY (current Gemini UI 2026-08): stable test-id on the mode picker button
            dropdownBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
            if (dropdownBtn) debug.foundBy = 'bard-mode-menu-button-testid';

            // FALLBACK: legacy class (button.input-area-switch is the same element today, kept for A/B)
            if (!dropdownBtn) {
              dropdownBtn = allBtns.find(b => b.className.includes('input-area-switch'));
              if (dropdownBtn) debug.foundBy = 'input-area-switch';
            }

            if (!dropdownBtn) {
              dropdownBtn = allBtns.find(b => b.textContent.trim().match(/^(Pro|Fast|Thinking)$/i));
              if (dropdownBtn) debug.foundBy = 'text-match';
            }

            if (!dropdownBtn) {
              dropdownBtn = allBtns.find(b => b.parentElement?.className?.includes('pill-ui'));
              if (dropdownBtn) debug.foundBy = 'pill-ui-parent';
            }

            if (!dropdownBtn) {
              return { error: 'Model dropdown not found', debug, request: modelName };
            }

            debug.clickedButton = { class: dropdownBtn.className.substring(0, 50), text: dropdownBtn.textContent.trim() };
            dropdownBtn.click();
            await new Promise(r => setTimeout(r, 600));

            const modelMap = { 'fast': 'Fast', 'thinking': 'Thinking', 'pro': 'Pro' };
            const targetModel = modelMap[modelName.toLowerCase()] || modelName;

            // Current Gemini model menu (verified live 2026-08): role="menuitem" items titled
            // "3.5 Flash-Lite", "3.6 Flash", "3.1 Pro", "Extended thinking", each with a second
            // description line. Match the TITLE (first line) not the whole textContent, else
            // 'pro' would also hit "Complex problem solving" under Extended thinking. Case-
            // insensitive because Gemini re-cases labels (e.g. "Extended thinking").
            const options = document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="listbox"] button, .mat-mdc-menu-item');
            const wantLc = targetModel.toLowerCase();
            const titleOf = (el) => ((el.textContent || '').trim().split('\n').map(s => s.trim()).filter(Boolean)[0] || '');
            let chosen = [...options].find(o => titleOf(o).toLowerCase().includes(wantLc));
            if (!chosen) chosen = [...options].find(o => (o.textContent || '').toLowerCase().includes(wantLc));
            if (chosen) {
              chosen.click();
              return { success: true, model: targetModel, debug, request: modelName };
            }

            const allClickables = document.querySelectorAll('button, div[role="option"], .mdc-list-item');
            for (const el of allClickables) {
              if (el.textContent.trim().startsWith(targetModel) && el !== dropdownBtn) {
                el.click();
                return { success: true, model: targetModel, debug, request: modelName };
              }
            }

            return { error: 'Model option not found: ' + targetModel, debug, request: modelName };
          },
          args: [command.model || 'pro']
        });
        result = result[0]?.result;
        break;

      case 'list_modes':
      case 'dump_menu': {
        // Read-only reconnaissance of the Tools menu.
        //
        // Why this exists: the mode list in `mode_state` is built by filtering
        // visible buttons against a HARDCODED list of six known names, with the
        // menu shut. That reports the composer's quick-pill row, not the menu —
        // which is why two accounts produced two different "mode lists" on
        // 2026-08-30 and neither contained Deep research. Enumerating what you
        // expect to find can only ever confirm what you already believed.
        //
        // This opens the real menu, expands anything collapsed, and reports what
        // is actually in it, matching against nothing.
        const wantDump = command.action === 'dump_menu';
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (dump) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const firstLine = el => ((el.textContent || '').trim().split('\n')[0] || '').trim();
            const visible = el => el && el.offsetParent !== null;

            // Same fallback chain the selector doc records. Never delete one.
            const findTools = () =>
              document.querySelector('button[aria-label="Upload & tools"]') ||
              document.querySelector('button[aria-label*="tools" i]') ||
              Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Tools');

            // Gemini has moved modes between roles before, so accept all of them.
            const ITEM_SEL = '[role="menuitemcheckbox"],[role="menuitem"],[role="menuitemradio"],[role="option"]';
            const collect = () => Array.from(document.querySelectorAll(ITEM_SEL))
              .filter(visible)
              .map(el => ({
                label: firstLine(el),
                role: el.getAttribute('role'),
                checked: el.getAttribute('aria-checked'),
                expanded: el.getAttribute('aria-expanded'),
                haspopup: el.getAttribute('aria-haspopup'),
                disabled: el.getAttribute('aria-disabled')
              }))
              .filter(m => m.label);

            const btn = findTools();
            if (!btn) return { ok: false, error: 'Tools button not found' };

            // The menu is a toggle, so clicking while it is already open closes it.
            // Only click when it is shut, otherwise this action turns the menu off
            // and then reports that no menu appeared.
            const menuUp = () => document.querySelectorAll('[role="menu"]').length > 0;
            const wasOpen = menuUp();
            if (!wasOpen) btn.click();

            // Poll rather than sampling once. The single 900ms sample this replaces
            // missed a menu that was measurably present at 2-3s on 2026-08-31.
            let waited = 0;
            while (!menuUp() && waited < 5000) { await sleep(250); waited += 250; }

            // The menu's content is lazily loaded: the first open renders an empty
            // shell (2 descendants, zero items) while a later open renders 88.
            // Close and re-open rather than reporting an empty menu as a finding.
            const anyItems = () => document.querySelectorAll(ITEM_SEL).length > 0;
            for (let retry = 0; retry < 2 && menuUp() && !anyItems(); retry++) {
              btn.click(); await sleep(500);
              btn.click();
              let w = 0;
              while (!anyItems() && w < 4000) { await sleep(250); w += 250; }
              waited += w + 500;
            }

            // Did the menu actually open? A synthetic click is untrusted, and Angular
            // may ignore it. Without this check an ignored click yields count:0, which
            // reads exactly like "the menu is empty" — the same confusion between a
            // silent instrument and a real absence that this action exists to end.
            const menuOpened = menuUp();
            if (!menuOpened) {
              return { ok: false, menuOpened: false,
                       error: 'Tools button found but no [role=menu] appeared after the click — ' +
                              'treat this as NO MEASUREMENT, not as an empty menu' };
            }

            const passes = [collect()];
            const expanders = [];
            for (let pass = 0; pass < 2; pass++) {
              const collapsed = Array.from(document.querySelectorAll('[role="menu"] [aria-expanded="false"]'));
              const more = Array.from(document.querySelectorAll(ITEM_SEL)).filter(el => /more/i.test(firstLine(el)))
                .concat(Array.from(document.querySelectorAll('[data-test-id="more-tools-button"]')));
              const targets = collapsed.concat(more).filter(visible)
                .filter(t => expanders.indexOf(firstLine(t) || t.getAttribute('aria-label') || '?') === -1);
              if (!targets.length) break;
              for (const t of targets) {
                expanders.push(firstLine(t) || t.getAttribute('aria-label') || '?');
                t.click();
                await sleep(600);
              }
              passes.push(collect());
            }

            // Capture the raw menu BEFORE closing it — after Escape the nodes are gone.
            const menuHtml = dump
              ? Array.from(document.querySelectorAll('[role="menu"]')).map(m => m.outerHTML.substring(0, 6000))
              : undefined;

            const seen = new Map();
            passes.forEach(list => list.forEach(m => {
              if (!seen.has(m.label.toLowerCase())) seen.set(m.label.toLowerCase(), m);
            }));
            const items = Array.from(seen.values());

            // Leave no UI state behind — this action is meant to be side-effect free.
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(200);

            const res = {
              ok: true,
              menuOpened: true,
              waitedMs: waited,
              alreadyOpen: wasOpen,
              count: items.length,
              modes: items.map(i => i.label),
              expanders,
              passCounts: passes.map(p => p.length)
            };
            if (dump) { res.items = items; res.menuHtml = menuHtml; }
            return res;
          },
          args: [wantDump]
        });
        result = result[0]?.result;
        break;
      }

      case 'select_mode':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: selectModeInPage,
          args: [command.mode || 'Deep research']
        });
        result = result[0]?.result;
        break;

      case 'chat':
        // SMOOTH: Fast chat - direct text insert + Enter
        if (!tab.url?.includes('gemini.google.com')) {
          result = { error: 'Not on Gemini page' };
          break;
        }
        const chatText = command.text || '';
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (text) => {
            try {
              // Try multiple selectors for Gemini input
              const selectors = [
                'rich-textarea .ql-editor',
                'rich-textarea [contenteditable="true"]',
                '.ql-editor[contenteditable="true"]',
                'div[aria-label="Enter a prompt for Gemini"]',
                'div[aria-label="Enter a prompt here"]',
                '[data-placeholder*="prompt"]',
                '[contenteditable="true"]'
              ];

              let input = null;
              for (const sel of selectors) {
                input = document.querySelector(sel);
                if (input) break;
              }

              if (!input) {
                return { error: 'Input not found', selectors: selectors.length };
              }

              // Focus and clear
              input.focus();

              // Set text directly (works better than execCommand)
              if (input.innerHTML !== undefined) {
                input.innerHTML = '<p>' + text + '</p>';
              } else {
                input.textContent = text;
              }

              // Dispatch input event to trigger Gemini's handlers
              input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));

              // Small delay then press Enter
              setTimeout(() => {
                // Find and click send button as backup
                const sendBtn = document.querySelector('button[aria-label="Send message"], button[aria-label*="Send"], button:has(mat-icon[fonticon="arrow_upward"]), button[data-test-id="send-button"], .send-button');
                if (sendBtn) {
                  sendBtn.click();
                } else {
                  // Try Enter key
                  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                }
              }, 100);

              return { success: true, sent: text.substring(0, 50) };
            } catch (e) {
              return { error: e.message };
            }
          },
          args: [chatText]
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;

      // === MESSENGER TAB ACTIONS ===
      case 'list_chats':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const grid = document.querySelector('[role="grid"][aria-label="Chats"]');
            if (!grid) return { chats: [] };
            const rows = grid.querySelectorAll('[role="row"]');
            const chats = [];
            rows.forEach(row => {
              const link = row.querySelector('[role="gridcell"] a');
              if (!link) return;
              const href = link.getAttribute('href') || '';
              const match = href.match(/\/messages\/(?:e2ee\/)?t\/([0-9]+)\//);
              const threadId = match ? match[1] : null;
              if (!threadId) return;

              const leaves = Array.from(link.querySelectorAll('*'))
                .filter(el => el.children.length === 0 && el.textContent && el.textContent.trim().length > 0)
                .map(el => el.textContent.trim());

              let name = link.getAttribute('aria-label') || '';
              const timeRegex = /^\d+\s?(s|m|h|d|w|min|hr|hrs)$|^Yesterday$|^\d{1,2}:\d{2}/;
              const timeAgo = leaves.find(t => timeRegex.test(t)) || '';
              if (!name) {
                name = leaves.find(t => t !== timeAgo) || '';
              }
              const preview = leaves.find(t => t !== name && t !== timeAgo) || '';

              chats.push({ threadId, name, href, preview, timeAgo });
            });
            return { chats };
          }
        });
        result = result[0]?.result;
        break;

      case 'index_chat':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (paramThreadId) => {
            async function hashMessage(threadId, sender, text) {
              const enc = new TextEncoder().encode(threadId + '|' + sender + '|' + text);
              const digest = await crypto.subtle.digest('SHA-256', enc);
              return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
            }

            let threadId = paramThreadId;
            if (!threadId) {
              const m = location.href.match(/\/messages\/(?:e2ee\/)?t\/([0-9]+)\//);
              threadId = m ? m[1] : null;
            }
            if (!threadId) throw new Error('Could not determine threadId');

            const log = document.querySelector('[role="log"][aria-label^="Messages in conversation"]');
            if (!log) throw new Error('No open conversation found');

            const articles = Array.from(log.querySelectorAll('[role="article"]'));
            const parsed = [];
            articles.forEach(article => {
              const labeled = article.querySelector('[aria-label^="At "]') ||
                (article.getAttribute('aria-label')?.startsWith('At ') ? article : null);
              let sender = '';
              let text = '';
              if (labeled) {
                const label = labeled.getAttribute('aria-label') || '';
                const m = label.match(/^At .*?\d{1,2}:\d{2}(?:\s*[AP]M)?,\s*([^:]*?)(?::\s*(.*))?$/si);
                if (m) {
                  sender = m[1].trim();
                  text = (m[2] || '').trim();
                }
              }
              if (!sender) {
                sender = 'unknown';
                text = article.textContent ? article.textContent.trim() : '';
              }
              parsed.push({ sender, text });
            });

            const key = 'msgIndex:' + threadId;
            const stored = await chrome.storage.local.get(key);
            const entry = stored[key] || { hashes: {}, lastIndexedAt: 0 };

            let newlyIndexed = 0;
            for (const { sender, text } of parsed) {
              const hash = await hashMessage(threadId, sender, text);
              if (!entry.hashes[hash]) {
                entry.hashes[hash] = {
                  sender,
                  textPreview: text.slice(0, 200),
                  indexedAt: Date.now()
                };
                newlyIndexed++;
              }
            }
            entry.lastIndexedAt = Date.now();

            await chrome.storage.local.set({ [key]: entry });

            return {
              threadId,
              newlyIndexed,
              totalIndexed: Object.keys(entry.hashes).length
            };
          },
          args: [command.threadId || null]
        });
        result = result[0]?.result;
        break;

      case 'get_index_status':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (paramThreadId) => {
            async function hashMessage(threadId, sender, text) {
              const enc = new TextEncoder().encode(threadId + '|' + sender + '|' + text);
              const digest = await crypto.subtle.digest('SHA-256', enc);
              return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
            }

            let threadId = paramThreadId;
            if (!threadId) {
              const m = location.href.match(/\/messages\/(?:e2ee\/)?t\/([0-9]+)\//);
              threadId = m ? m[1] : null;
            }

            const key = threadId ? 'msgIndex:' + threadId : null;
            const stored = key ? await chrome.storage.local.get(key) : {};
            const entry = (key && stored[key]) || { hashes: {}, lastIndexedAt: 0 };

            let latestMessageHash = null;
            let latestMessageIndexed = false;

            const log = document.querySelector('[role="log"][aria-label^="Messages in conversation"]');
            if (log && threadId) {
              const articles = log.querySelectorAll('[role="article"]');
              const lastArticle = articles[articles.length - 1];
              if (lastArticle) {
                const labeled = lastArticle.querySelector('[aria-label^="At "]') ||
                  (lastArticle.getAttribute('aria-label')?.startsWith('At ') ? lastArticle : null);
                let sender = '';
                let text = '';
                if (labeled) {
                  const label = labeled.getAttribute('aria-label') || '';
                  const m = label.match(/^At .*?\d{1,2}:\d{2}(?:\s*[AP]M)?,\s*([^:]*?)(?::\s*(.*))?$/si);
                  if (m) {
                    sender = m[1].trim();
                    text = (m[2] || '').trim();
                  }
                }
                if (!sender) {
                  sender = 'unknown';
                  text = lastArticle.textContent ? lastArticle.textContent.trim() : '';
                }
                latestMessageHash = await hashMessage(threadId, sender, text);
                latestMessageIndexed = !!entry.hashes[latestMessageHash];
              }
            }

            return {
              threadId: threadId || null,
              totalIndexed: Object.keys(entry.hashes).length,
              lastIndexedAt: entry.lastIndexedAt || 0,
              latestMessageHash,
              latestMessageIndexed
            };
          },
          args: [command.threadId || null]
        });
        result = result[0]?.result;
        break;

      case 'read_chat':
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (paramThreadId, limit) => {
            async function hashMessage(threadId, sender, text) {
              const enc = new TextEncoder().encode(threadId + '|' + sender + '|' + text);
              const digest = await crypto.subtle.digest('SHA-256', enc);
              return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
            }

            let threadId = paramThreadId;
            if (!threadId) {
              const m = location.href.match(/\/messages\/(?:e2ee\/)?t\/([0-9]+)\//);
              threadId = m ? m[1] : null;
            }
            if (!threadId) throw new Error('Could not determine threadId');

            const key = 'msgIndex:' + threadId;
            const stored = await chrome.storage.local.get(key);
            const entry = stored[key] || { hashes: {} };

            const log = document.querySelector('[role="log"][aria-label^="Messages in conversation"]');
            const articles = log ? Array.from(log.querySelectorAll('[role="article"]')) : [];
            const recentArticles = articles.slice(-limit);

            const messages = [];
            for (const article of recentArticles) {
              const labeled = article.querySelector('[aria-label^="At "]') ||
                (article.getAttribute('aria-label')?.startsWith('At ') ? article : null);
              let sender = '';
              let text = '';
              let approxTime = null;
              if (labeled) {
                const label = labeled.getAttribute('aria-label') || '';
                const m = label.match(/^At (.*?\d{1,2}:\d{2}(?:\s*[AP]M)?),\s*([^:]*?)(?::\s*(.*))?$/si);
                if (m) {
                  approxTime = m[1].trim();
                  sender = m[2].trim();
                  text = (m[3] || '').trim();
                }
              }
              if (!sender) {
                sender = 'unknown';
                text = article.textContent ? article.textContent.trim() : '';
              }
              const hash = await hashMessage(threadId, sender, text);
              messages.push({
                hash,
                sender,
                text,
                indexed: !!entry.hashes[hash],
                approxTime
              });
            }

            return { threadId, messages };
          },
          args: [command.threadId || null, command.limit || 20]
        });
        result = result[0]?.result;
        break;

      case 'send_chat_message': {
        if (!command.text) throw new Error('send_chat_message requires "text"');

        // Navigate to the target thread first if it's not already open —
        // Messenger's compose box only exists for the currently open conversation.
        if (command.threadId) {
          const currentMatch = tab.url?.match(/\/messages\/(?:e2ee\/)?t\/([0-9]+)\//);
          const currentThreadId = currentMatch ? currentMatch[1] : null;
          if (currentThreadId !== command.threadId) {
            await navigateAndWait(tab.id, 'https://www.facebook.com/messages/t/' + command.threadId + '/');
          }
        }

        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (text) => {
            const box = document.querySelector('[contenteditable="true"][role="textbox"]');
            if (!box) return { error: 'Message compose box not found' };

            box.focus();
            // contenteditable boxes need execCommand/insertText (matches the
            // approach already used for the Gemini 'chat' action in this file)
            // rather than setting .textContent, or React's controlled-input
            // state doesn't pick up the change.
            document.execCommand('insertText', false, text);
            box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));

            await new Promise(r => setTimeout(r, 300));

            box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

            return { success: true, sent: text.substring(0, 80) };
          },
          args: [command.text]
        });
        result = result[0]?.result || { error: 'Script returned null' };
        break;
      }

      default:
        result = { error: 'Unknown action: ' + command.action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  // Send response (retained) - include tabId for tracking
  const response = {
    id: command.id,
    action: command.action,
    ...result,  // Flatten result into response
    tabId: tab?.id,  // Include which tab was used
    timestamp: Date.now()
  };
  publish(TOPICS.response, response, true);
  await broadcastLog('res', response);
  // After any model/mode change, push fresh retained mode state so consoles update
  // even if the response itself is missed (worker was mid-reconnect).
  if (command.action === 'select_model' || command.action === 'select_mode') {
    publishModeState(tab && tab.id);
  }
}

// Listen for messages from popup/sidepanel/content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getTabId') {
    // Content script requesting its own tab ID
    sendResponse({ tabId: sender.tab?.id });
  } else if (msg.action === 'status') {
    sendResponse({ connected: isConnected });
  } else if (msg.action === 'reconnect') {
    if (client) client.end();
    connect();
    sendResponse({ ok: true });
  } else if (msg.action === 'publish_result') {
    // Direct publish from sidebar with debug info
    const data = msg.data;
    const payload = { action: data.action, result: data.result, timestamp: data.timestamp, source: 'sidebar' };
    const payloadStr = JSON.stringify(payload);
    publish(TOPICS.response, payload, true);
    sendResponse({
      ok: true,
      topic: TOPICS.response,
      qos: 0,
      retained: true,
      size: payloadStr.length,
      payload: payload
    });
  } else if (msg.action === 'command') {
    publish(TOPICS.command, msg.command);
    sendResponse({ ok: true });
  } else if (msg.action === 'select_model') {
    // Model selection from content script
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID' });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (modelName) => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        // PRIMARY (current Gemini UI 2026-08): stable test-id on the mode picker button
        let dropdownBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
        // FALLBACK: legacy class / text / pill parent (kept for A/B; same element today)
        if (!dropdownBtn) dropdownBtn = allBtns.find(b => b.className.includes('input-area-switch'));
        if (!dropdownBtn) dropdownBtn = allBtns.find(b => b.textContent.trim().match(/^(Pro|Fast|Thinking)$/i));
        if (!dropdownBtn) dropdownBtn = allBtns.find(b => b.parentElement?.className?.includes('pill-ui'));
        if (!dropdownBtn) return { error: 'Model dropdown not found' };

        dropdownBtn.click();
        await new Promise(r => setTimeout(r, 600));

        const modelMap = { 'fast': 'Fast', 'thinking': 'Thinking', 'pro': 'Pro' };
        const targetModel = modelMap[modelName.toLowerCase()] || modelName;

        // Look for clickable elements in the dropdown
        const options = document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] button, .mdc-list-item, [class*="option"]');
        for (const opt of options) {
          const text = opt.textContent?.trim();
          // Match if text starts with model name or first line matches
          if (text?.startsWith(targetModel) || text?.split('\n')[0]?.trim() === targetModel) {
            opt.click();
            return { success: true, model: targetModel };
          }
        }

        // Fallback: find any clickable with exact model name at start
        const allClickables = document.querySelectorAll('button, div[role="option"], div[tabindex], [class*="list-item"]');
        for (const el of allClickables) {
          const text = el.textContent?.trim();
          if (text?.startsWith(targetModel) && el !== dropdownBtn) {
            el.click();
            return { success: true, model: targetModel };
          }
        }
        return { error: 'Model option not found: ' + targetModel };
      },
      args: [msg.model || 'pro']
    }).then(results => {
      sendResponse(results[0]?.result || { error: 'Script failed' });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true; // Keep channel open for async response
  } else if (msg.action === 'select_mode') {
    // Mode selection from content script (Deep Research, etc)
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID' });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      func: selectModeInPage,
      args: [msg.mode || 'Deep research']
    }).then(results => {
      sendResponse(results[0]?.result || { error: 'Script failed' });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  } else if (msg.action === 'index_chat_request') {
    // Fired by messenger-content.js when the user clicks a chat's status badge.
    // Runs the same indexing logic as the 'index_chat' MQTT action, scoped to
    // the thread the badge was clicked for (not necessarily the open thread).
    const tabId = sender.tab?.id;
    const threadId = msg.threadId;
    if (!tabId || !threadId) {
      sendResponse({ error: 'Missing tabId or threadId' });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      func: async (targetThreadId) => {
        async function hashMessage(threadId, sender, text) {
          const enc = new TextEncoder().encode(threadId + '|' + sender + '|' + text);
          const digest = await crypto.subtle.digest('SHA-256', enc);
          return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
        }

        const currentThreadMatch = location.href.match(/\/messages\/(?:e2ee\/)?t\/([0-9]+)\//);
        const currentThreadId = currentThreadMatch ? currentThreadMatch[1] : null;
        if (currentThreadId !== targetThreadId) {
          return { error: 'Open conversation does not match clicked chat — open it first, then click again', threadId: targetThreadId };
        }

        const log = document.querySelector('[role="log"][aria-label^="Messages in conversation"]');
        if (!log) return { error: 'No open conversation found', threadId: targetThreadId };

        const articles = Array.from(log.querySelectorAll('[role="article"]'));
        const parsed = [];
        articles.forEach(article => {
          const labeled = article.querySelector('[aria-label^="At "]') ||
            (article.getAttribute('aria-label')?.startsWith('At ') ? article : null);
          let sender = '';
          let text = '';
          if (labeled) {
            const label = labeled.getAttribute('aria-label') || '';
            const m = label.match(/^At .*?\d{1,2}:\d{2}(?:\s*[AP]M)?,\s*([^:]*?)(?::\s*(.*))?$/si);
            if (m) {
              sender = m[1].trim();
              text = (m[2] || '').trim();
            }
          }
          if (!sender) {
            sender = 'unknown';
            text = article.textContent ? article.textContent.trim() : '';
          }
          parsed.push({ sender, text });
        });

        const key = 'msgIndex:' + targetThreadId;
        const stored = await chrome.storage.local.get(key);
        const entry = stored[key] || { hashes: {}, lastIndexedAt: 0 };

        let newlyIndexed = 0;
        for (const { sender, text } of parsed) {
          const hash = await hashMessage(targetThreadId, sender, text);
          if (!entry.hashes[hash]) {
            entry.hashes[hash] = { sender, textPreview: text.slice(0, 200), indexedAt: Date.now() };
            newlyIndexed++;
          }
        }
        entry.lastIndexedAt = Date.now();
        await chrome.storage.local.set({ [key]: entry });

        return { threadId: targetThreadId, newlyIndexed, totalIndexed: Object.keys(entry.hashes).length };
      },
      args: [threadId]
    }).then(results => {
      sendResponse(results[0]?.result || { error: 'Script failed' });
    }).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }
  return true;
});

// Enable side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Start
console.log('[Claude Browser Proxy] v' + VERSION + ' Starting with MQTT.js...');
updateBadge(false); // Show red initially until connected
try {
  connect();
} catch (e) {
  console.error('[Claude Browser Proxy] Failed to start:', e);
}

// --- MV3 service-worker keepalive ---------------------------------------
// Chrome evicts an idle MV3 worker after ~30s, which silently drops the MQTT
// socket so every command stops responding until the next Chrome event.
// A recurring alarm wakes the worker before that and reconnects if the socket
// is down (self-healing); when connected it touches the socket so Chrome sees
// activity. This is what keeps select_model / select_mode / chat responsive
// after the console has been idle.
try {
  chrome.alarms.create('mqtt-keepalive', { periodInMinutes: 0.4 }); // ~24s, under the eviction window
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'mqtt-keepalive') return;
    if (!client || !isConnected) {
      console.log('[MQTT] keepalive: reconnecting');
      try { connect(); } catch (e) { console.error('[MQTT] keepalive reconnect failed', e); }
    } else {
      try {
        // Connected but not subscribed is the exact state that made the bridge
        // look healthy while silently dropping every command. Repair it here
        // rather than waiting for a reconnect that may never come.
        if (!isSubscribed) {
          console.warn('[MQTT] keepalive: connected but NOT subscribed — resubscribing');
          subscribeToCommands();
        }
        publishStatus({ keepalive: true });
        // refresh retained mode state while we're awake
        chrome.tabs.query({ url: 'https://gemini.google.com/*' }).then(ts => {
          const t = ts.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
          if (t) publishModeState(t.id);
        }).catch(() => {});
      } catch (e) { /* next alarm will reconnect */ }
    }
  });
} catch (e) {
  console.error('[Claude Browser Proxy] alarms keepalive unavailable:', e);
}
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => { try { connect(); } catch (e) {} });
}
// ------------------------------------------------------------------------

// Publish current page info (retained) - only for Gemini
let lastPublishedUrl = '';
async function publishCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('gemini.google.com') && tab.url !== lastPublishedUrl) {
      lastPublishedUrl = tab.url;
      const pageInfo = {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now()
      };
      publish(TOPICS.page, pageInfo, true);
      await broadcastLog('page', pageInfo);
    }
  } catch (e) {
    console.error('[Page] Error:', e);
  }
}

// Enable/disable sidebar based on URL
async function updateSidebarState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // There may be no active tab at all — between closing the last tab in a
    // window, or while a window is losing focus. The line below used to read
    // `tab?.url` and then `tab.id`, guarding the same object twice and then
    // once not, so it threw exactly then. The empty catch swallowed it, which
    // is why nothing ever reported a side panel that had quietly stopped
    // updating.
    if (!tab) return;
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: !!tab.url?.includes('gemini.google.com')
    });
  } catch (e) {
    // Still non-fatal — a side panel that cannot be configured must not break
    // tab switching — but no longer invisible.
    console.warn('[Sidebar] setOptions failed:', e?.message || e);
  }
}

// Listen for tab changes
chrome.tabs.onActivated.addListener(() => {
  publishCurrentPage();
  updateBadge(isConnected);
  updateSidebarState();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title) {
    publishCurrentPage();
    updateBadge(isConnected);
    updateSidebarState();
  }
});

// Publish initial page after connection
setTimeout(publishCurrentPage, 2000);
