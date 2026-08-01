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

let client = null;
let isConnected = false;
let connectedAt = 0; // Track connection time to ignore stale retained messages

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
    clientId: 'claude-browser-' + Date.now(),
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
    connectedAt = Date.now(); // Track connection time
    updateBadge(true);

    // Subscribe to command topic
    client.subscribe(TOPICS.command, (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err);
      else console.log('[MQTT] Subscribed to', TOPICS.command);
    });

    // Publish "online" status (retained) - overrides LWT "offline"
    client.publish(TOPICS.status, JSON.stringify({
      status: 'online',
      timestamp: Date.now(),
      version: VERSION
    }), { retain: true });
  });

  client.on('message', (topic, message) => {
    console.log('[MQTT] Received:', topic);
    try {
      const command = JSON.parse(message.toString());

      // Ignore stale retained messages (older than our connection)
      if (command.ts && command.ts < connectedAt) {
        console.log('[MQTT] Ignoring stale message (ts:', command.ts, '< connected:', connectedAt, ')');
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
    let tab;
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

      case 'select_mode':
        // Select Gemini mode (Deep Research, Canvas, etc)
        // Uses menuitemcheckbox with aria-checked to detect active state
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (modeName) => {
            const debug = {};
            const findTools = () => document.querySelector('button[aria-label="Upload & tools"]') || document.querySelector('button[aria-label*="tools" i]') || Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Tools');

            // Step 1: Open Tools menu
            let toolsBtn = findTools();
            if (!toolsBtn) return { error: 'Tools button not found' };

            toolsBtn.click();
            await new Promise(r => setTimeout(r, 800));

            // Step 2: Check if target is already active (toggle off) or deselect other mode
            const menuItems = document.querySelectorAll('[role="menuitemcheckbox"]');
            for (const item of menuItems) {
              if (item.getAttribute('aria-checked') === 'true') {
                const checkedName = item.textContent?.trim().split('\n')[0]?.trim();
                debug.deselected = checkedName;
                item.click();
                await new Promise(r => setTimeout(r, 1000));

                // If toggling off the same mode, we're done
                if (checkedName?.toLowerCase() === modeName?.toLowerCase()) {
                  console.log('[Claude Proxy] Toggled off mode:', modeName);
                  return { success: true, mode: modeName, toggled: 'off', debug };
                }

                // Otherwise, re-open Tools to select the new mode
                await new Promise(r => setTimeout(r, 500));
                toolsBtn = findTools();
                if (!toolsBtn) return { error: 'Tools button not found after deselect', debug };
                toolsBtn.click();
                await new Promise(r => setTimeout(r, 1000));
                break;
              }
            }

            // Step 3: Find and click the target mode by matching first line of text
            const items = document.querySelectorAll('[role="menuitemcheckbox"]');
            debug.menuItems = Array.from(items).map(i => i.textContent?.trim().split('\n')[0]?.trim());
            for (const item of items) {
              const text = item.textContent?.trim();
              const firstLine = text?.split('\n')[0]?.trim();
              if (firstLine?.toLowerCase() === modeName?.toLowerCase()) {
                item.click();
                debug.clicked = { tag: item.tagName, text: text.substring(0, 50) };
                console.log('[Claude Proxy] Selected mode:', modeName);
                return { success: true, mode: modeName, debug };
              }
            }

            return { error: modeName + ' not found in menu', debug };
          },
          args: [command.mode || 'Deep Research']
        });
        result = result[0]?.result;
        break;

      case 'get_response':
        // Get Gemini responses (same as sidebar button)
        if (!tab.url?.includes('gemini.google.com')) {
          result = { error: 'Not on Gemini page' };
          break;
        }
        result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const all = document.querySelectorAll('MESSAGE-CONTENT, message-content');
            if (all.length === 0) return { error: 'No responses found' };
            // Get latest response (last one)
            const latest = all[all.length - 1];
            const answer = (latest.innerText || '').trim();
            return {
              answer: answer,
              count: all.length,
              timestamp: Date.now()
            };
          }
        });
        result = result[0]?.result;
        // Also publish to answer topic for convenience
        if (result && result.answer) {
          publish(TOPICS.answer, result, true);
        }
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
      func: async (modeName) => {
        const debug = {};
        const findTools = () => document.querySelector('button[aria-label="Upload & tools"]') || document.querySelector('button[aria-label*="tools" i]') || Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Tools');

        // Step 1: Open Tools menu
        let toolsBtn = findTools();
        if (!toolsBtn) return { error: 'Tools button not found' };

        toolsBtn.click();
        await new Promise(r => setTimeout(r, 800));

        // Step 2: Check if target is already active (toggle off) or deselect other mode
        const menuItems = document.querySelectorAll('[role="menuitemcheckbox"]');
        for (const item of menuItems) {
          if (item.getAttribute('aria-checked') === 'true') {
            const checkedName = item.textContent?.trim().split('\n')[0]?.trim();
            debug.deselected = checkedName;
            item.click();
            await new Promise(r => setTimeout(r, 1000));

            // If toggling off the same mode, we're done
            if (checkedName?.toLowerCase() === modeName?.toLowerCase()) {
              return { success: true, mode: modeName, toggled: 'off', debug };
            }

            // Otherwise, re-open Tools to select the new mode
            // Wait for DOM to settle after deselection
            await new Promise(r => setTimeout(r, 500));
            toolsBtn = findTools();
            if (!toolsBtn) return { error: 'Tools button not found after deselect', debug };
            toolsBtn.click();
            await new Promise(r => setTimeout(r, 1000));
            break;
          }
        }

        // Step 3: Click target mode by matching first line of text
        const items = document.querySelectorAll('[role="menuitemcheckbox"]');
        debug.menuItems = Array.from(items).map(i => i.textContent?.trim().split('\n')[0]?.trim());
        for (const item of items) {
          const text = item.textContent?.trim();
          const firstLine = text?.split('\n')[0]?.trim();
          if (firstLine?.toLowerCase() === modeName?.toLowerCase()) {
            item.click();
            debug.clicked = { tag: item.tagName, text: text?.substring(0, 50) };
            return { success: true, mode: modeName, debug };
          }
        }

        return { error: modeName + ' not found in menu', debug };
      },
      args: [msg.mode || 'Deep Research']
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
    const onGemini = tab?.url?.includes('gemini.google.com');
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: onGemini
    });
  } catch (e) {}
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
