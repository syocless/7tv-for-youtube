// 7TV for YouTube (unofficial) — content script
// Runs inside the YouTube live_chat iframe.

const SEVEN_TV_API = "https://7tv.io/v3";

let emoteMap = null;   // name -> image url
let emoteRegex = null; // compiled once the map is ready
const emoteSets = [];  // { name, emotes } per loaded set, for the picker

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
  return { name: data.name || "Emotes", emotes: map };
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
      "position:fixed;top:4px;left:4px;z-index:99999;" +
      "background:rgba(0,0,0,0.75);color:#fff;font:11px sans-serif;" +
      "padding:3px 6px;border-radius:4px;pointer-events:none;";
    document.body.appendChild(badge);
  }
  badge.textContent = "7TV: " + text;
  badge.style.color = isError ? "#ff8080" : "#a0ffa0";

  // A success message is only worth a glance; errors stay until reload.
  clearTimeout(badge.hideTimer);
  if (!isError) badge.hideTimer = setTimeout(() => badge.remove(), 4000);
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

  // Global set first so the standard 7TV picks render, then the extra sets in
  // the order given — a set added later (e.g. your own personal one) can
  // override a name from an earlier one. Promise.all keeps that order while
  // fetching them all at once instead of one round trip after another.
  const loaded = await Promise.all(
    [GLOBAL_EMOTE_SET_ID, ...extraIds].map(id =>
      loadEmoteSet(id).catch(err => {
        console.warn(`[7TV for YouTube] failed to load set ${id}`, err);
        return null;
      })
    )
  );

  for (const set of loaded) {
    if (!set) continue;
    emoteSets.push(set);
    for (const [name, url] of set.emotes) merged.set(name, url);
  }

  if (merged.size === 0) {
    showBadge("0 emotes loaded (see console)", true);
    return;
  }

  emoteMap = merged;
  emoteRegex = compileRegex(emoteMap);
  if (!emoteRegex) return;
  scanExistingMessages();
  observeChat();
  startSafetyNet();
  mountPickerWhenReady();
  showBadge(`${merged.size} emotes ready`);
}

init();

// Re-init if the user changes the emote set IDs from the popup.
chrome.storage.onChanged.addListener(changes => {
  if (changes.emoteSetIds) location.reload();
});

// --- Emote picker -----------------------------------------------------------
// Layout and class names mirror 7TV's own emote menu: a provider row and
// search box in the header, sticky per-set headers that collapse, and a
// sidebar rail of set icons on the right.

function insertEmote(name) {
  const input =
    document.querySelector("yt-live-chat-text-input-field-renderer #input") ||
    document.querySelector("#input[contenteditable]");
  if (!input) return;

  input.focus();
  // execCommand fires the beforeinput/input events YouTube's own component
  // listens for, so the send button enables. Setting textContent doesn't.
  const pad = input.textContent && !/\s$/.test(input.textContent) ? " " : "";
  document.execCommand("insertText", false, pad + name + " ");
}

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

// A dropped or failed request retries just that one tile. Tiles that already
// arrived keep their image and are never refetched.
function loadTile(img, attempt) {
  img.onerror = () => {
    // Drop the failed src so the tile goes blank rather than showing a broken
    // image icon, and so re-setting it below counts as a real change.
    img.removeAttribute("src");
    if (attempt >= 3) return;
    // Back off, and stagger by a random slice: a batch of tiles that failed
    // together must not retry in lockstep and rebuild the pile-up that caused
    // the failures in the first place.
    setTimeout(() => loadTile(img, attempt + 1), 400 * 2 ** attempt + Math.random() * 400);
  };
  img.src = img.dataset.src;
}

function buildSetSection(set, scroller, rail, watcher) {
  const container = el("div", "seventv-emote-set-container", scroller);
  // 7TV uses the set owner's avatar here; the first emote is a good enough
  // stand-in and never needs another API call.
  const cover = set.emotes.values().next().value;

  const header = el("div", "seventv-set-header", container);
  if (cover) el("img", "seventv-set-header-icon", header).src = cover;
  else el("div", "seventv-set-header-icon", header);
  el("span", "seventv-set-name", header).textContent = set.name;
  el("div", "seventv-set-chevron", header).textContent = "▾";

  const grid = el("div", "seventv-emote-set", container);
  for (const [name, url] of set.emotes) {
    const cell = el("div", "seventv-emote-container", grid);
    cell.dataset.name = name.toLowerCase();
    cell.title = name;
    const img = el("img", null, cell);
    img.dataset.src = url;
    img.alt = name;
    watcher.observe(img);
    cell.addEventListener("click", () => insertEmote(name));
  }

  header.addEventListener("click", () => {
    container.setAttribute("collapsed", container.getAttribute("collapsed") !== "true");
  });

  const tab = el("div", "seventv-emote-menu-set-sidebar-icon-container", rail);
  const tabIcon = el("img", "seventv-emote-menu-set-sidebar-icon", tab);
  if (cover) tabIcon.src = cover;
  tabIcon.title = set.name;
  tab.addEventListener("click", () => {
    container.setAttribute("collapsed", "false");
    container.scrollIntoView({ block: "start" });
    for (const other of rail.children) other.setAttribute("selected", other === tab);
  });

  return { container, grid };
}

function applySearch(query, sections) {
  const q = query.trim().toLowerCase();
  for (const { container, grid } of sections) {
    let visible = 0;
    for (const cell of grid.children) {
      const hit = !q || cell.dataset.name.includes(q);
      cell.hidden = !hit;
      if (hit) visible++;
    }
    container.hidden = visible === 0;
  }
}

function buildPicker() {
  const menu = el("div", "seventv-emote-menu");
  menu.id = "seventv-picker";
  menu.hidden = true;

  const header = el("div", "seventv-emote-menu-header", menu);
  const providers = el("div", "seventv-emote-menu-providers", header);
  const provider = el("div", "seventv-emote-menu-provider-icon", providers);
  provider.setAttribute("selected", "true");
  el("span", null, provider).textContent = "7TV";

  const search = el("div", "seventv-emote-menu-search", header);
  el("div", "search-icon", search).textContent = "⌕";
  const input = el("input", "seventv-emote-menu-search-input", search);
  input.type = "text";
  input.placeholder = "Search for emotes";

  const body = el("div", "seventv-emote-menu-body", menu);
  const tabs = el("div", "seventv-emote-menu-tab-container", body);
  const scroller = el("div", "seventv-emote-menu-scroll", tabs);
  const rail = el("div", "seventv-emote-menu-tab-sidebar", tabs);
  const icons = el("div", "seventv-emote-menu-sidebar-icons", rail);

  // Native loading="lazy" doesn't hold these back: with ~900 emotes it still
  // puts every request in flight at once, so images crawl in or fail outright.
  // Fetch a tile only once it has actually scrolled into the menu.
  const watcher = new IntersectionObserver((entries, obs) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      loadTile(entry.target, 0);
      obs.unobserve(entry.target);
    }
  }, { root: scroller, rootMargin: "200px" });

  const sections = emoteSets.map(set => buildSetSection(set, scroller, icons, watcher));
  icons.firstElementChild?.setAttribute("selected", "true");

  input.addEventListener("input", () => applySearch(input.value, sections));
  menu.addEventListener("click", e => e.stopPropagation());

  document.body.appendChild(menu);
  return menu;
}

function findButtonRow() {
  const renderer = document.querySelector("yt-live-chat-message-input-renderer");
  if (!renderer) return null;
  // YouTube has renamed this row before, so try the known ids and then fall
  // back to whatever actually holds the emoji button.
  return (
    renderer.querySelector("#picker-buttons") ||
    renderer.querySelector("#buttons") ||
    renderer.querySelector("yt-live-chat-icon-toggle-button-renderer")?.parentElement ||
    null
  );
}

function mountPicker(floating) {
  if (document.getElementById("seventv-picker-toggle")) return true;

  const host = findButtonRow();
  if (!host && !floating) return false;

  const panel = buildPicker();

  const btn = document.createElement("button");
  btn.id = "seventv-picker-toggle";
  btn.type = "button";
  btn.title = "7TV emotes";
  btn.textContent = "7TV";
  btn.addEventListener("click", e => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden) panel.querySelector("input").focus();
  });

  if (host) {
    host.prepend(btn);
  } else {
    // Nothing recognisable to attach to. Float it instead — the debug badge
    // proves fixed positioning renders fine in this iframe.
    btn.classList.add("seventv-floating");
    document.body.appendChild(btn);
  }
  console.log("[7TV for YouTube] picker mounted:", host ? "#" + host.id : "floating");

  document.addEventListener("click", () => {
    panel.hidden = true;
  });
  return true;
}

function mountPickerWhenReady() {
  let tries = 0;
  const timer = setInterval(() => {
    // ponytail: after ~15s give up on YouTube's button row and float the
    // toggle, so a DOM rename can never leave the picker unreachable.
    if (mountPicker(tries >= 30) || ++tries > 30) clearInterval(timer);
  }, 500);
}
