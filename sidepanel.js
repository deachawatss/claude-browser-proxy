// Side panel JS
const $ = id => document.getElementById(id);

// Version
const version = 'v' + chrome.runtime.getManifest().version;
$('v').textContent = version;
$('vb').textContent = version;

// Format JSON nicely - show friendly action names + preview
function formatMsg(msg) {
  if (typeof msg !== 'object') return msg;

  // Action icons
  const actionIcons = {
    'get_url': '🔗', 'get_text': '📄', 'get_html': '🌐', 'get_videos': '🎬',
    'get_state': '📊', 'get_response': '📥', 'screenshot': '📸', 'click': '👆',
    'type': '⌨️', 'key': '⌨️', 'find': '🔍', 'execute': '⚡', 'download': '💾',
    'select_model': '🤖', 'wait_response': '⏳', 'publish': '📤'
  };

  // Check if this is a publish log (from sidebar button)
  if (msg.topic && msg.payload) {
    const action = msg.payload?.action || 'unknown';
    const summary = '📤 ' + action + ' → ' + msg.topic + ' (' + msg.size + 'b, qos:' + msg.qos + ', retained:' + msg.retained + ')';
    const str = JSON.stringify(msg, null, 2);
    return '<details><summary>' + summary + '</summary><pre>' + str + '</pre></details>';
  }

  const action = msg.action || msg.result?.action || '';
  const icon = actionIcons[action] || '📦';
  const r = msg.result || {};

  // Build preview based on action/result
  let preview = '';
  const isCommand = msg.id && !msg.result; // Command being sent (no result yet)

  if (r.error) preview = '❌ ' + r.error;
  else if (r.url) preview = '← ' + r.url.substring(0, 45);
  else if (msg.url) preview = '← ' + msg.url.substring(0, 45); // direct url
  else if (r.title) preview = '← ' + r.title.substring(0, 40);
  else if (r.text) preview = '← ' + r.text.substring(0, 45) + '...';
  else if (r.html) preview = '← ' + r.html.length + ' chars';
  else if (r.answer) preview = '← ' + r.answer.substring(0, 35) + '...';
  else if (r.success) preview = '← ✅';
  else if (msg.text) preview = '→ ' + msg.text.substring(0, 35); // type command
  else if (msg.selector) preview = '→ ' + msg.selector.substring(0, 30); // click
  else if (isCommand) preview = '→ sending...'; // outgoing command

  const summary = icon + ' ' + (action || 'data') + (preview ? ' — ' + preview : '');
  const str = JSON.stringify(msg, null, 2);
  return '<details><summary>' + summary + '</summary><pre>' + str + '</pre></details>';
}

// Log function
function log(type, msg) {
  const el = document.createElement('div');
  el.className = 'log ' + type;
  el.innerHTML = '<span class="t">' + new Date().toLocaleTimeString() + '</span>' + formatMsg(msg);
  $('l').appendChild(el);
  $('l').scrollTop = $('l').scrollHeight;

  // Show answer in dedicated box
  if (type === 'answer' || (msg?.result?.answer)) {
    const answer = msg?.result?.answer || msg?.answer || msg;
    if (answer && typeof answer === 'string') {
      showAnswer(answer);
    }
  }
}

// Show Gemini answer in box
function showAnswer(text) {
  $('ab').style.display = 'block';
  $('at').textContent = text;
}

// Status check
async function checkStatus() {
  try {
    const data = await chrome.storage.local.get('mqttConnected');
    const on = data.mqttConnected || false;
    $('d').className = 'dot' + (on ? ' on' : '');
    $('s').textContent = on ? 'Connected to MQTT' : 'Disconnected';
  } catch (e) {
    $('s').textContent = 'Error';
  }
}

// Resolve the SAME Gemini tab that background.js handleCommand targets — the
// most-recently-accessed gemini.google.com tab. The old {active:true,currentWindow:true}
// query could return a DIFFERENT tab than the chat commands wrote to (especially with
// several Gemini tabs open), so a chat submitted on tab X was read back on tab Y →
// "No responses found". Returns an array (most-recent first) so `const [tab] = ...` works.
async function getGeminiTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs;
}

// Auto-activate toggle: restore saved state + persist changes (default ON)
(async () => {
  const el = $('autoActivate');
  if (!el) return;
  const d = await chrome.storage.local.get('autoActivate');
  el.checked = d.autoActivate !== false;
  el.addEventListener('change', () => chrome.storage.local.set({ autoActivate: el.checked }));
})();

// Resolve the Gemini tab the user actually means: the active tab in the focused
// window first (what they're looking at), then most-recent Gemini as fallback.
// This beats plain "most-recent" when many Gemini tabs are open.
async function getTargetGeminiTab() {
  let list = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (list[0] && (list[0].url || '').includes('gemini.google.com')) return list[0];
  list = await chrome.tabs.query({ active: true, currentWindow: true });
  if (list[0] && (list[0].url || '').includes('gemini.google.com')) return list[0];
  const gs = await getGeminiTabs();
  return gs[0] || null;
}

// Resolve the target Gemini tab and (if the toggle is on) bring it to the front,
// so chat + response hit the same visible tab and the worker stays awake.
// Returns the target tab (so callers can pin its tabId), or null if none.
async function activateGeminiTab() {
  const target = await getTargetGeminiTab();
  if (!target) return null;
  const el = $('autoActivate');
  if (!el || el.checked) {
    try {
      await chrome.tabs.update(target.id, { active: true });
      if (target.windowId != null) await chrome.windows.update(target.windowId, { focused: true });
      await new Promise(r => setTimeout(r, 200));
    } catch (e) { /* ignore */ }
  }
  return target;
}

// Page info
async function updatePage() {
  try {
    const [tab] = await getGeminiTabs();
    if (tab) {
      $('pt').textContent = tab.title || 'Unknown';
      $('pu').textContent = tab.url || '';
    }
  } catch (e) {}
}

// Send command
async function cmd(action, extra = {}) {
  const id = 'p_' + Date.now();
  const command = { action, id, ...extra };
  log('cmd', command);
  try {
    await chrome.runtime.sendMessage({ action: 'command', command });
    log('res', 'Sent');
  } catch (e) {
    log('res', 'Error: ' + e.message);
  }
}

// Send chat to Gemini (clean UI)
async function sendChat(text) {
  log('cmd', '💬 You: ' + text);

  // Resolve + focus the target Gemini tab, then PIN its tabId to every command
  // so the whole exchange stays on one tab even with several Gemini tabs open.
  const target = await activateGeminiTab();
  if (!target) { log('res', '❌ No Gemini tab open'); return; }

  // Use the all-in-one 'chat' action (types into the composer + clicks Send /
  // Enter with a confirmation) — more reliable than separate click/type/key.
  log('res', '⏳ Sending to Gemini...');
  const sent = await chrome.runtime.sendMessage({ action: 'command', command: { action: 'chat', text, tabId: target.id, id: 'chat_send' } });
  if (sent && sent.error) { log('res', '❌ ' + sent.error); return; }

  // Wait for the reply. The answer box is filled by the state-based auto-fetch
  // (handleStateUpdate) once Gemini finishes generating — no explicit fetch here,
  // which used to fire too early and log a misleading "No responses found".
  log('res', '⏳ Waiting for Gemini...');
  await chrome.runtime.sendMessage({ action: 'command', command: { action: 'wait_response', timeout: 30000, tabId: target.id, id: 'chat_wait' } });
}

// Run input (chat, JS, or selector)
$('run').onclick = () => {
  const val = $('inp').value.trim();
  if (!val) return;
  $('inp').value = ''; // Clear input
  if (val.startsWith('js:')) {
    // Execute JS
    cmd('execute', { code: val.slice(3) });
  } else if (val.startsWith('type:')) {
    // Type text: "type:selector|text"
    const [sel, text] = val.slice(5).split('|');
    cmd('type', { selector: sel, text: text });
  } else if (val.startsWith('.') || val.startsWith('#') || val.startsWith('[')) {
    // Selector - click it
    cmd('click', { selector: val });
  } else {
    // Chat message - send to Gemini
    sendChat(val);
  }
};
$('inp').onkeydown = (e) => { if (e.key === 'Enter') $('run').click(); };

// Helper: publish result to MQTT (returns debug info)
async function publishResult(action, result) {
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'publish_result',
      data: { action, result, timestamp: Date.now() }
    });
    return resp; // { ok, topic, qos, retained, size }
  } catch (e) { return null; }
}

// Buttons - direct execution + MQTT publish with debug
$('b1').onclick = async () => {
  const [tab] = await getGeminiTabs();
  const result = { url: tab?.url || 'No URL', title: tab?.title || '' };
  log('res', '🔗 ' + result.url);
  const pub = await publishResult('get_url', result);
  if (pub?.ok) log('pub', pub);
};
$('b2').onclick = async () => {
  const [tab] = await getGeminiTabs();
  if (!tab) { log('res', '❌ No tab'); return; }
  const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body.innerText });
  const text = r[0]?.result || '';
  log('res', '📄 ' + text.substring(0, 200) + '...');
  const pub = await publishResult('get_text', { text });
  if (pub?.ok) log('pub', { ...pub, payload: { ...pub.payload, result: { text: text.substring(0, 200) + '...' } } });
};
$('b3').onclick = async () => {
  const [tab] = await getGeminiTabs();
  if (!tab) { log('res', '❌ No tab'); return; }
  const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.outerHTML });
  const html = r[0]?.result || '';
  log('res', '🌐 ' + html.length + ' chars');
  const pub = await publishResult('get_html', { html });
  if (pub?.ok) log('pub', { ...pub, payload: { ...pub.payload, result: { chars: html.length } } });
};
$('b4').onclick = () => cmd('get_videos');
$('b5').onclick = async () => {
  // This click is the only place the all-site permission can be asked for:
  // chrome.permissions.request needs a real user gesture, and the MQTT path has
  // none. Optional, so the extension does not carry all-site access from
  // install, and revocable in chrome://extensions.
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  if (!has) {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) {
      log('res', 'Screenshot needs all-site access. Not granted, so nothing was captured.');
      return;
    }
    log('res', 'All-site access granted — screenshots work from the CLI now too.');
  }
  cmd('screenshot');
};
$('b6').onclick = async () => {
  $('l').innerHTML = '';
  $('ab').style.display = 'none'; // Hide answer box
  $('at').textContent = 'Waiting for response...'; // Reset answer text
  lastLogCount = 0;
  await chrome.storage.local.set({ logs: [] });
  log('res', 'Cleared');
};

// Get Gemini Response button - directly from DOM
$('b7').onclick = async () => {
  log('cmd', '📥 Getting Gemini response...');
  try {
    const tab = await activateGeminiTab();
    if (!tab || !tab.url?.includes('gemini.google.com')) {
      log('res', '❌ Not on Gemini page');
      return;
    }
    // Get the newest MODEL answer (skip the user's own turns).
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // model responses live in <message-content>; the user's query is a separate
        // element. Prefer the last response inside a model-response container.
        let all = document.querySelectorAll('model-response message-content, model-response MESSAGE-CONTENT');
        if (all.length === 0) all = document.querySelectorAll('MESSAGE-CONTENT, message-content');
        if (all.length === 0) return { error: 'No responses found' };
        // Get all responses as array (full text)
        const responses = Array.from(all).map((el, i) => {
          const text = (el.innerText || '').trim();
          return `[${i + 1}] ${text}`;
        });
        return { answers: responses, count: all.length };
      }
    });
    const data = result[0]?.result;
    if (data?.answers) {
      showAnswer(data.answers.join('\n\n---\n\n'));
      log('res', '✅ Got ' + data.count + ' response(s)');
    } else {
      log('res', '❌ ' + (data?.error || 'No response'));
    }
  } catch (e) {
    log('res', '❌ Error: ' + e.message);
  }
};

// Model selection buttons
document.querySelectorAll('.model-btn').forEach(btn => {
  btn.onclick = async () => {
    const model = btn.dataset.model;
    log('cmd', '🔄 Switching to ' + model + '...');

    // Update UI immediately
    document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Send command
    try {
      await chrome.runtime.sendMessage({
        action: 'command',
        command: { action: 'select_model', model: model, id: 'model_' + Date.now() }
      });
    } catch (e) {
      log('res', '❌ Error: ' + e.message);
    }
  };
});

// Mode selection buttons (Deep Research, Canvas)
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.onclick = async () => {
    const mode = btn.dataset.mode;
    const wasActive = btn.classList.contains('active');

    // Toggle: if already active, deselect (turn off mode)
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    if (!wasActive) btn.classList.add('active');

    log('cmd', '🔄 ' + (wasActive ? 'Deselecting' : 'Selecting') + ' ' + mode + '...');

    try {
      await chrome.runtime.sendMessage({
        action: 'command',
        command: { action: 'select_mode', mode: mode, id: 'mode_' + Date.now() }
      });
    } catch (e) {
      log('res', '❌ Error: ' + e.message);
    }
  };
});

// New Chat button - deselect active mode + start new chat
$('newChat').onclick = async () => {
  log('cmd', '✨ Resetting...');
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  try {
    const [tab] = await getGeminiTabs();
    if (tab) {
      // Step 1: clear the active mode through the ONE shared menu helper in
      // background.js. This used to be a fourth private copy of the open-menu
      // logic here, and it had already drifted — it clicked once, slept 800ms and
      // read the menu, which is the lazy-render bug fixed everywhere else, so on a
      // cold menu it cleared nothing and said nothing.
      const cleared = await chrome.runtime.sendMessage({ action: 'deselect_active_mode' });

      // Step 2: start the new chat. Navigation is the side panel's own concern,
      // not menu logic, so it stays here.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          await new Promise(r => setTimeout(r, 300));
          const newBtn = document.querySelector('a[href="/app"]') ||
            Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('New chat'));
          if (newBtn) { newBtn.click(); return { success: true }; }
          window.location.href = 'https://gemini.google.com/app';
          return { success: true, method: 'navigate' };
        }
      });
      log('res', cleared?.cleared ? ('✨ Cleared ' + cleared.cleared + ' & new chat') : '✨ Reset & new chat');
    }
  } catch (e) {
    log('res', '❌ Error: ' + e.message);
  }
};

// Watch for MQTT logs from background (filter chat noise)
let lastLogCount = 0;
async function syncLogs() {
  const data = await chrome.storage.local.get('logs');
  const logs = data.logs || [];
  if (logs.length > lastLogCount) {
    // Show new logs (skip chat command noise)
    logs.slice(lastLogCount).forEach(l => {
      const id = l.data?.id || '';
      // Skip raw chat commands - we show clean status instead
      if (id.startsWith('chat_')) return;
      // Skip page updates (too noisy)
      if (l.type === 'page') return;
      // Show answers in the answer box
      if (l.type === 'answer') {
        showAnswer(l.data?.answer || JSON.stringify(l.data));
        log('res', '✅ Gemini responded!');
        return;
      }
      // Show other logs normally
      log(l.type, l.data);
    });
    lastLogCount = logs.length;
  }
}

// Listen for storage changes (real-time)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.logs) syncLogs();
  if (changes.mqttConnected) checkStatus();
  // Direct answer updates (bypass log sync issues)
  if (changes.lastAnswer?.newValue) {
    showAnswer(changes.lastAnswer.newValue);
    log('res', '✅ Gemini responded!');
  }
});

// Update Gemini state display
async function updateState() {
  try {
    // Send get_state command
    await chrome.runtime.sendMessage({
      action: 'command',
      command: { action: 'get_state', id: 'state_poll_' + Date.now() }
    });
  } catch (e) {
    // Ignore errors
  }
}

// Track previous state for auto-fetch
let prevLoading = null; // null = first run, don't auto-fetch on init
let prevResponseCount = 0;

// Handle state from logs
function handleStateUpdate(state) {
  if (!state || state.error) return; // Skip errors

  // Update loading indicator
  const loadingEl = $('sl');
  const count = state.responseCount || 0;
  if (state.loading) {
    loadingEl.textContent = '🔄';
    loadingEl.title = 'Loading...';
  } else {
    loadingEl.textContent = count > 0 ? '✅' : '⚪';
    loadingEl.title = count > 0 ? 'Done' : 'Ready';
  }

  // Auto-fetch response when: loading done AND new response appeared
  // Skip on first run (prevLoading === null)
  if (prevLoading === true && !state.loading && count > prevResponseCount) {
    log('res', '⏳ Auto-fetching response...');
    chrome.runtime.sendMessage({
      action: 'command',
      command: { action: 'get_response', id: 'auto_fetch_' + Date.now() }
    }).catch(() => {});
  }
  prevLoading = state.loading;
  prevResponseCount = count;

  // Update tool indicator
  const toolEl = $('st');
  toolEl.className = 'state-tool';
  if (state.tool) {
    toolEl.textContent = state.tool;
    toolEl.classList.add(state.tool);
  } else {
    toolEl.textContent = '-';
  }

  // Update response count
  $('sc').textContent = count + ' response' + (count !== 1 ? 's' : '');
}

// Hook into log sync to capture state updates
const origSyncLogs = syncLogs;
async function syncLogsWithState() {
  const data = await chrome.storage.local.get('logs');
  const logs = data.logs || [];
  if (logs.length > lastLogCount) {
    logs.slice(lastLogCount).forEach(l => {
      // Check for state response
      if (l.data?.action === 'get_state' && l.data?.result) {
        handleStateUpdate(l.data.result);
      }
      const id = l.data?.id || '';
      if (id.startsWith('chat_')) return;
      if (id.startsWith('state_poll_')) return; // Hide state polls
      if (l.type === 'page') return;

      // Handle answer - both direct type and via result.answer
      const answer = l.data?.answer || l.data?.result?.answer;
      if (l.type === 'answer' || answer) {
        if (answer && typeof answer === 'string') {
          showAnswer(answer);
          log('res', '✅ Gemini responded!');
        }
        return;
      }
      log(l.type, l.data);
    });
    lastLogCount = logs.length;
  }
}

// Replace sync function
syncLogs = syncLogsWithState;

// Auto-load responses from DOM on startup
async function autoLoadResponses() {
  try {
    const [tab] = await getGeminiTabs();
    if (!tab || !tab.url?.includes('gemini.google.com')) return;

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const all = document.querySelectorAll('MESSAGE-CONTENT, message-content');
        if (all.length === 0) return null;
        const responses = Array.from(all).map((el, i) => {
          const text = (el.innerText || '').trim();
          return `[${i + 1}] ${text}`;
        });
        return { answers: responses, count: all.length };
      }
    });
    const data = result[0]?.result;
    if (data?.answers) {
      showAnswer(data.answers.join('\n\n---\n\n'));
      log('res', '✅ Loaded ' + data.count + ' response(s)');
    }
  } catch (e) {
    // Ignore errors on startup
  }
}

// Init
checkStatus();
updatePage();
syncLogs();
autoLoadResponses(); // Auto-load from DOM on startup
updateState(); // Initial state check
setInterval(checkStatus, 2000);
setInterval(updatePage, 3000);
setInterval(syncLogs, 1000);
setInterval(updateState, 2000); // Poll state every 2s
log('res', 'Ready');
