// 7TV for YouTube (unofficial) — content script
// Runs inside the YouTube live_chat iframe.

const SEVEN_TV_API = "https://7tv.io/v3";

let emoteMap = null;   // name -> image url
let emoteRegex = null; // compiled once the map is ready

function buildEmoteUrl(host, files) {
  // Prefer a small static webp/png for inline chat rendering.
  const pick =
    files.find(f => f.name === "2x.webp") ||
    files.find(f => f.format === "WEBP") ||
    files[0];
  if (!pick) return null;
  const base = host.url.startsWith("//") ? "https:" + host.url : host.url;
  return `${base}/${pick.name}`;
}

async function loadEmoteSet(emoteSetId) {
  const res = await fetch(`${SEVEN_TV_API}/emote-sets/${emoteSetId}`);
  if (!res.ok) throw new Error(`7TV API error: ${res.status}`);
  const data = await res.json();

  const map = new Map();
  for (const emote of data.emotes || []) {
    const host = emote.data?.host;
    if (!host) continue;
    const url = buildEmoteUrl(host, host.files || []);
    if (url) map.set(emote.name, url);
  }
  return map;
}

function compileRegex(map) {
  // Longest names first so overlapping names don't shadow each other.
  const names = [...map.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // \w in JS only covers [A-Za-z0-9_] — it doesn't know Cyrillic, Greek,
  // etc. are "letters" too, so "ок" would wrongly match inside "роблокс".
  // \p{L}/\p{N} with the "u" flag make the boundary Unicode-aware.
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(${escaped.join("|")})(?![\\p{L}\\p{N}_])`,
    "gu"
  );
}

function replaceInMessageNode(node) {
  if (!emoteMap || !emoteRegex) return;

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    if (!text || !emoteRegex.test(text)) continue;
    emoteRegex.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    while ((match = emoteRegex.exec(text))) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      const img = document.createElement("img");
      img.src = emoteMap.get(match[1]);
      img.alt = match[1];
      img.title = match[1];
      img.className = "seventv-emote";
      frag.appendChild(img);
      lastIndex = match.index + match[1].length;
    }
    frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}

function scanExistingMessages() {
  document
    .querySelectorAll("yt-live-chat-text-message-renderer #message")
    .forEach(replaceInMessageNode);
}

function startSafetyNet() {
  // MutationObserver should catch every rewrite, but YouTube's chat
  // internals are undocumented — this fallback re-applies emotes to any
  // message that lost them, in case a mutation slips past the observer.
  setInterval(scanExistingMessages, 1000);
}

function closestMessage(node) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return el?.closest ? el.closest("#message") : null;
}

function observeChat() {
  const target = document.querySelector("#items") || document.body;
  const observer = new MutationObserver(mutations => {
    const toProcess = new Set();

    for (const m of mutations) {
      // Text inside a message was rewritten by YouTube — reprocess it.
      if (m.type === "characterData") {
        const msg = closestMessage(m.target);
        if (msg) toProcess.add(msg);
        continue;
      }
      // A whole message (or a chat item wrapping one) was added/rebuilt.
      for (const added of m.addedNodes) {
        if (!(added instanceof HTMLElement)) continue;
        const msg = added.matches?.("#message") ? added : added.querySelector?.("#message");
        if (msg) toProcess.add(msg);
      }
    }

    for (const msg of toProcess) replaceInMessageNode(msg);
  });
  observer.observe(target, { childList: true, subtree: true, characterData: true });
}

function showBadge(text, isError) {
  let badge = document.getElementById("seventv-debug-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "seventv-debug-badge";
    badge.style.cssText =
      "position:fixed;bottom:4px;right:4px;z-index:99999;" +
      "background:rgba(0,0,0,0.75);color:#fff;font:11px sans-serif;" +
      "padding:3px 6px;border-radius:4px;pointer-events:none;";
    document.body.appendChild(badge);
  }
  badge.textContent = "7TV: " + text;
  badge.style.color = isError ? "#ff8080" : "#a0ffa0";
}

function updateIconBadge(count, isError) {
  try {
    chrome.runtime.sendMessage({ type: "seventv-status", count, error: isError });
  } catch (err) {
    // Messaging can fail if the background worker hasn't started yet;
    // the on-page badge above still shows the same status either way.
    console.warn("[7TV for YouTube] icon badge update failed", err);
  }
}

const GLOBAL_EMOTE_SET_ID = "global";

async function init() {
  showBadge("script loaded, fetching…");
  console.log("[7TV for YouTube] content script running on", location.href);

  const { emoteSetIds } = await chrome.storage.sync.get("emoteSetIds");
  const extraIds = (emoteSetIds || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const merged = new Map();

  // Global set loads by default so the standard 7TV picks render.
  try {
    const globalMap = await loadEmoteSet(GLOBAL_EMOTE_SET_ID);
    for (const [name, url] of globalMap) merged.set(name, url);
  } catch (err) {
    console.warn("[7TV for YouTube] failed to load global set", err);
    showBadge("global set failed: " + err.message, true);
  }

  // Extra sets load in the order given, so a set added later (e.g. your
  // own personal one) can override a name from an earlier one.
  for (const id of extraIds) {
    try {
      const map = await loadEmoteSet(id);
      for (const [name, url] of map) merged.set(name, url);
    } catch (err) {
      console.warn(`[7TV for YouTube] failed to load set ${id}`, err);
    }
  }

  if (merged.size === 0) {
    showBadge("0 emotes loaded (see console)", true);
    updateIconBadge(0, true);
    return;
  }

  emoteMap = merged;
  emoteRegex = compileRegex(emoteMap);
  if (!emoteRegex) return;
  scanExistingMessages();
  observeChat();
  startSafetyNet();
  showBadge(`${merged.size} emotes ready`);
  updateIconBadge(merged.size, false);

  createPickerUI();
  initAutocomplete();
}

init();

// Re-init if the user changes the emote set IDs from the popup.
chrome.storage.onChanged.addListener(changes => {
  if (changes.emoteSetIds) location.reload();
});

// ################ ПАНЕЛЬ ВЫБОРА ЭМОДЗИ С ПОИСКОМ

function createPickerUI() {
  const inputContainer = document.querySelector(
    'yt-live-chat-message-input-renderer #input-container'
  );

  if (!inputContainer || document.getElementById('seventv-picker-btn')) return;

  inputContainer.style.position = 'relative';

  // Кнопка открытия панели
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'seventv-picker-btn';
  toggleBtn.textContent = '7TV';
  toggleBtn.title = 'Открыть панель 7TV';

  // Общий popup-контейнер
  const pickerContainer = document.createElement('div');
  pickerContainer.id = 'seventv-picker-container';

  // Поле поиска
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск эмодзи...';

  // Grid
  const pickerGrid = document.createElement('div');
  pickerGrid.id = 'seventv-picker-grid';

  // Поиск
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();

    const items = pickerGrid.querySelectorAll('.seventv-picker-item');

    items.forEach(img => {
      img.style.display =
        img.alt.toLowerCase().includes(query)
          ? 'block'
          : 'none';
    });
  });

  // Переключение popup
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pickerContainer.classList.toggle('seventv-active');
  });

  // Закрытие при клике вне панели
  document.addEventListener('click', (e) => {
    if (
      !pickerContainer.contains(e.target) &&
      e.target !== toggleBtn
    ) {
      pickerContainer.classList.remove('seventv-active');
    }
  });

  const titleThing = document.createElement('h1');
  titleThing.textContent = '7TV for YT (Unofficial)';
  titleThing.style.textAlign = 'center';
  titleThing.style.fontSize = '14px';
  titleThing.style.marginTop = '12px';
  titleThing.style.fontWeight = '400';

  pickerContainer.appendChild(titleThing);
  pickerContainer.appendChild(searchInput);
  pickerContainer.appendChild(pickerGrid);

  inputContainer.appendChild(toggleBtn);
  inputContainer.appendChild(pickerContainer);

  // Заполняем grid
  populatePickerGrid(pickerGrid);
}

function populatePickerGrid(gridContainer) {
  if (!emoteMap || emoteMap.size === 0) return;

  gridContainer.innerHTML = '';

  for (const [name, url] of emoteMap) {
    const img = document.createElement('img');

    img.src = url;
    img.alt = name;
    img.title = name;
    img.className = 'seventv-picker-item';

    img.addEventListener('click', () => {
      insertEmoteToInput(name);
    });

    gridContainer.appendChild(img);
  }
}

// YouTube использует реактивные фреймворки (Polymer/Lit), которые
// отслеживают события, а не просто читают DOM напрямую. Поэтому после
// любой ручной вставки текста нужно синхронизировать несколько
// элементов интерфейса, иначе кнопка отправки останется неактивной.
function syncChatInputState(editableInput) {
  const inputRenderer = document.querySelector('yt-live-chat-message-input-renderer');
  if (inputRenderer) {
    inputRenderer.setAttribute('input-expanded', '');
  }

  if (editableInput) {
    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
    editableInput.dispatchEvent(inputEvent);

    const keyupEvent = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter' });
    editableInput.dispatchEvent(keyupEvent);
  }

  const textInputRenderer = document.querySelector('yt-live-chat-text-input-field-renderer#input');
  if (textInputRenderer) {
    textInputRenderer.setAttribute('has-text', '');
    textInputRenderer.setAttribute('input-expanded', '');
  }

  const charCount = document.querySelector('div#count.style-scope.yt-live-chat-message-input-renderer');
  if (charCount && editableInput) {
    const remaining = 200 - editableInput.textContent.length;
    charCount.textContent = Math.max(0, remaining).toString();
  }

  const sendButtonContainer = document.querySelector('div#send-button.style-scope.yt-live-chat-message-input-renderer');
  if (sendButtonContainer) {
    sendButtonContainer.removeAttribute('hidden');
  }

  const sendButton = sendButtonContainer
    ? sendButtonContainer.querySelector('button')
    : document.querySelector('button[aria-label="Send"]');
  if (sendButton) {
    sendButton.removeAttribute('disabled');
    sendButton.setAttribute('aria-disabled', 'false');
  }
}

function getEditableChatInput() {
  return document.querySelector(
    'yt-live-chat-text-input-field-renderer#input div#input[contenteditable]'
  );
}

function insertEmoteToInput(emoteName) {
  const editableInput = getEditableChatInput();
  if (editableInput) {
    editableInput.focus();
    const currentText = editableInput.textContent.trim();
    editableInput.textContent = currentText ? currentText + ' ' + emoteName : emoteName;
  }
  syncChatInputState(editableInput);
}

// ################ АВТОДОПОЛНЕНИЕ ПО ":название"

let autocompleteBox = null;
let autocompleteMatches = [];
let autocompleteSelected = 0;
let autocompleteRange = null; // { start, end } character offsets in the input's text
let autocompleteAttached = false;

// Стандартный способ получить позицию каретки внутри contenteditable
// в виде смещения символов от начала текста.
function getCaretOffset(element) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return 0;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

function setCaretOffset(element, offset) {
  const range = document.createRange();
  const selection = window.getSelection();
  let remaining = offset;
  let node = null;

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while ((node = walker.nextNode())) {
    if (remaining <= node.nodeValue.length) {
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= node.nodeValue.length;
  }

  // Offset beyond the text — just place the caret at the very end.
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function closeAutocomplete() {
  if (autocompleteBox) autocompleteBox.remove();
  autocompleteBox = null;
  autocompleteMatches = [];
  autocompleteRange = null;
}

function renderAutocomplete(inputContainer) {
  if (!autocompleteBox) {
    autocompleteBox = document.createElement("div");
    autocompleteBox.id = "seventv-autocomplete";
    inputContainer.appendChild(autocompleteBox);
  }
  autocompleteBox.innerHTML = "";

  autocompleteMatches.forEach((name, i) => {
    const item = document.createElement("div");
    item.className = "seventv-autocomplete-item";
    if (i === autocompleteSelected) item.classList.add("seventv-active");

    const img = document.createElement("img");
    img.src = emoteMap.get(name);
    const label = document.createElement("span");
    label.textContent = name;

    item.appendChild(img);
    item.appendChild(label);
    item.addEventListener("mousedown", e => {
      // mousedown (not click) so it fires before the input loses focus.
      e.preventDefault();
      applyAutocomplete(i);
    });

    autocompleteBox.appendChild(item);
  });
}

function applyAutocomplete(index) {
  const name = autocompleteMatches[index];
  const editableInput = getEditableChatInput();
  if (!name || !editableInput || !autocompleteRange) return;

  const text = editableInput.textContent;
  const newText =
    text.slice(0, autocompleteRange.start) + name + " " + text.slice(autocompleteRange.end);

  editableInput.textContent = newText;
  setCaretOffset(editableInput, autocompleteRange.start + name.length + 1);
  syncChatInputState(editableInput);
  closeAutocomplete();
}

function handleAutocompleteInput(e) {
  if (!emoteMap || emoteMap.size === 0) return;
  const editableInput = e.target;
  if (!editableInput.matches?.(
    'yt-live-chat-text-input-field-renderer#input div#input[contenteditable]'
  )) return;

  const caret = getCaretOffset(editableInput);
  const text = editableInput.textContent;
  const beforeCaret = text.slice(0, caret);

  // Match a ":partial" token right before the caret, with no spaces in it.
  const match = beforeCaret.match(/:([^\s:]{0,30})$/);
  if (!match) {
    closeAutocomplete();
    return;
  }

  const query = match[1].toLowerCase();
  autocompleteMatches = [...emoteMap.keys()]
    .filter(name => name.toLowerCase().startsWith(query))
    .slice(0, 8);

  if (autocompleteMatches.length === 0) {
    closeAutocomplete();
    return;
  }

  autocompleteRange = { start: caret - match[0].length, end: caret };
  autocompleteSelected = 0;

  const inputContainer = document.querySelector(
    'yt-live-chat-message-input-renderer #input-container'
  );
  if (inputContainer) renderAutocomplete(inputContainer);
}

function handleAutocompleteKeydown(e) {
  if (!autocompleteBox || autocompleteMatches.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    autocompleteSelected = (autocompleteSelected + 1) % autocompleteMatches.length;
    renderAutocomplete(autocompleteBox.parentElement);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    autocompleteSelected =
      (autocompleteSelected - 1 + autocompleteMatches.length) % autocompleteMatches.length;
    renderAutocomplete(autocompleteBox.parentElement);
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    applyAutocomplete(autocompleteSelected);
  } else if (e.key === "Escape") {
    closeAutocomplete();
  }
}

function initAutocomplete() {
  if (autocompleteAttached) return;
  autocompleteAttached = true;

  // Delegated on document since YouTube can recreate the input element.
  document.addEventListener("input", handleAutocompleteInput, true);
  document.addEventListener("keydown", handleAutocompleteKeydown, true);
  document.addEventListener("click", e => {
    if (autocompleteBox && !autocompleteBox.contains(e.target)) closeAutocomplete();
  });
}
