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
    // Bit 0 of the set entry's flags marks a zero-width (overlay) emote: it
    // renders on top of the emote before it instead of beside it. A set owner
    // can set that per set, so this flag wins over the emote's own.
    if (url) map.set(emote.name, { url, zeroWidth: (emote.flags & 1) !== 0 });
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

function makeEmoteImg(name, info, overlay) {
  const img = document.createElement("img");
  img.src = info.url;
  img.alt = name;
  img.title = name;
  img.className = overlay ? "seventv-emote seventv-zero-width" : "seventv-emote";
  return img;
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
    let stack = null; // span holding the emote a zero-width one stacks onto

    while ((match = emoteRegex.exec(text))) {
      const between = text.slice(lastIndex, match.index);
      const info = emoteMap.get(match[1]);

      // A zero-width emote renders on top of the emote before it, and the
      // space between them is swallowed — but only if one actually precedes
      // it. On its own it falls back to rendering like any other emote.
      if (info.zeroWidth && stack && /^\s*$/.test(between)) {
        stack.appendChild(makeEmoteImg(match[1], info, true));
      } else {
        if (between) frag.appendChild(document.createTextNode(between));
        stack = document.createElement("span");
        stack.className = "seventv-emote-stack";
        stack.appendChild(makeEmoteImg(match[1], info, false));
        frag.appendChild(stack);
      }
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

// Status goes to the extension's toolbar icon instead of an overlay on the
// page: an on-page badge sits on top of the chat, and this one is visible
// even when the chat is scrolled or the menu is open.
function showBadge(text, isError, count) {
  console.log("[7TV for YouTube]", text);
  try {
    chrome.runtime.sendMessage({ type: "seventv-status", count, error: isError });
  } catch (err) {
    // The background worker may still be asleep; the console line above
    // records the same status either way.
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

  await loadCollected();
  for (const [name, info] of collected) merged.set(name, info);

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
  await loadRecent();
  mountPickerWhenReady();
  showBadge(merged.size + " emotes ready", false, merged.size);
}

init();

// Re-init if the user changes the emote set IDs from the popup.
chrome.storage.onChanged.addListener(changes => {
  if (changes.emoteSetIds) location.reload();
});

// --- 7TV library search -----------------------------------------------------
// The whole point of the emote-set IDs in the popup is to get emotes into
// chat. Searching 7TV directly removes that step: pick an emote from the
// full library and it is kept, rendered and suggested from then on.

const SEVEN_TV_GQL = "https://7tv.io/v3/gql";
const LIBRARY_QUERY =
  "query($query:String!,$limit:Int){emotes(query:$query,limit:$limit," +
  "sort:{value:\"popularity\",order:DESCENDING}){items{id name flags listed " +
  "host{url files{name format}}}}}";

let collected = new Map(); // name -> { url, zeroWidth }

async function loadCollected() {
  try {
    const { collectedEmotes } = await chrome.storage.local.get("collectedEmotes");
    for (const e of collectedEmotes || []) {
      collected.set(e.name, { url: e.url, zeroWidth: !!e.zeroWidth });
    }
  } catch (err) {
    console.warn("[7TV for YouTube] could not read collected emotes", err);
  }
}

function saveCollected() {
  const list = [...collected].map(([name, info]) => ({
    name,
    url: info.url,
    zeroWidth: info.zeroWidth
  }));
  try {
    chrome.storage.local.set({ collectedEmotes: list });
  } catch (err) {
    console.warn("[7TV for YouTube] could not save collected emotes", err);
  }
}

// Keeping an emote has to reach the chat renderer too, not just the menu:
// the name lookup and the match pattern are both rebuilt here.
function keepEmote(name, info) {
  if (collected.has(name) || (emoteMap && emoteMap.has(name))) return false;
  collected.set(name, info);
  saveCollected();
  emoteMap.set(name, info);
  emoteRegex = compileRegex(emoteMap);
  return true;
}

async function searchLibrary(query, limit) {
  const res = await fetch(SEVEN_TV_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: LIBRARY_QUERY, variables: { query, limit } })
  });
  if (!res.ok) throw new Error("7TV search error: " + res.status);

  const body = await res.json();
  if (body.errors) throw new Error("7TV search rejected the query");

  const items = body.data?.emotes?.items || [];
  const out = [];
  // 7TV holds thousands of separate uploads under the same name, and emotes
  // here are keyed by name, so only the first of each can ever be kept.
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.name)) continue;
    // "listed" is 7TV's own public-listing flag; unlisted emotes are hidden
    // from search on the site too.
    if (!item.listed) continue;
    const host = item.host;
    if (!host) continue;
    const url = buildEmoteUrl(host, host.files || []);
    if (!url) continue;
    // Bit 8 is the emote's own zero-width flag, the library equivalent of the
    // per-set flag used when loading a set.
    seen.add(item.name);
    out.push({ name: item.name, info: { url, zeroWidth: (item.flags & 256) !== 0 } });
  }
  return out;
}

// --- Recently used ----------------------------------------------------------

const RECENT_LIMIT = 36;
let recentNames = [];

async function loadRecent() {
  try {
    const { recentEmotes } = await chrome.storage.local.get("recentEmotes");
    recentNames = Array.isArray(recentEmotes) ? recentEmotes : [];
  } catch (err) {
    console.warn("[7TV for YouTube] could not read recent emotes", err);
  }
}

function rememberEmote(name) {
  recentNames = [name, ...recentNames.filter(n => n !== name)].slice(0, RECENT_LIMIT);
  try {
    chrome.storage.local.set({ recentEmotes: recentNames });
  } catch (err) {
    console.warn("[7TV for YouTube] could not save recent emotes", err);
  }
}

// --- Shared lookup and ranking ----------------------------------------------

function chatInput() {
  return (
    document.querySelector("yt-live-chat-text-input-field-renderer #input") ||
    document.querySelector("#input[contenteditable]")
  );
}

function insertEmote(name) {
  const input = chatInput();
  if (!input) return;

  input.focus();
  // execCommand fires the beforeinput/input events YouTube's own component
  // listens for, so the send button enables. Setting textContent doesn't.
  const pad = input.textContent && !/\s$/.test(input.textContent) ? " " : "";
  document.execCommand("insertText", false, pad + name + " ");
  rememberEmote(name);
}

// Prefix matches first, then the shortest name. A plain includes() filter put
// the obvious answer anywhere among hundreds of hits.
function rankedMatches(query, limit) {
  const q = query.trim().toLowerCase();
  if (!q || !emoteMap) return [];

  const hits = [];
  for (const [name, info] of emoteMap) {
    const at = name.toLowerCase().indexOf(q);
    if (at === -1) continue;
    hits.push({ name, info, prefix: at === 0 ? 0 : 1 });
  }
  hits.sort(
    (a, b) =>
      a.prefix - b.prefix ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name)
  );
  return limit ? hits.slice(0, limit) : hits;
}

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

// --- Emote picker -----------------------------------------------------------
// Layout and class names mirror 7TV's own emote menu: a provider row and
// search box in the header, sticky per-set headers that collapse, and a
// sidebar rail of set icons on the right.

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

function buildTile(name, info, ctx, onPick) {
  const cell = el("div", "seventv-emote-container");
  cell.dataset.name = name.toLowerCase();
  cell.dataset.emote = name;
  if (info.zeroWidth) cell.setAttribute("zero-width", "true");

  const img = el("img", null, cell);
  img.dataset.src = info.url;
  img.alt = name;
  ctx.watcher.observe(img);

  cell.addEventListener("click", () => (onPick ? onPick(name, info) : insertEmote(name)));
  cell.addEventListener("mouseenter", () => ctx.preview(name, info));
  return cell;
}

function buildSetSection(set, scroller, rail, ctx) {
  const container = el("div", "seventv-emote-set-container", scroller);
  // 7TV uses the set owner's avatar here; the first emote is a good enough
  // stand-in and never needs another API call.
  const cover = set.emotes.values().next().value;

  const header = el("div", "seventv-set-header", container);
  if (cover) el("img", "seventv-set-header-icon", header).src = cover.url;
  else el("div", "seventv-set-header-icon", header);
  el("span", "seventv-set-name", header).textContent = set.name;
  el("div", "seventv-set-chevron", header).textContent = "▾";

  const grid = el("div", "seventv-emote-set", container);
  for (const [name, info] of set.emotes) grid.appendChild(buildTile(name, info, ctx));

  header.addEventListener("click", () => {
    container.setAttribute("collapsed", container.getAttribute("collapsed") !== "true");
  });

  const tab = el("div", "seventv-emote-menu-set-sidebar-icon-container", rail);
  const tabIcon = el("img", "seventv-emote-menu-set-sidebar-icon", tab);
  if (cover) tabIcon.src = cover.url;
  tabIcon.title = set.name;
  tab.addEventListener("click", () => {
    container.setAttribute("collapsed", "false");
    // scrollIntoView() can walk up and nudge ancestor scroll containers
    // (even the page itself) if the browser decides the element isn't
    // fully visible somewhere up the chain. Scrolling the picker's own
    // list by the exact pixel delta keeps everything outside it still.
    const scroller = container.closest(".seventv-emote-menu-scroll");
    if (scroller) {
      const delta = container.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += delta;
    }
  });

  ctx.railFor.set(header, tab);
  ctx.spy.observe(header);
  return container;
}

function buildPicker() {
  const menu = el("div", "seventv-emote-menu");
  menu.id = "seventv-picker";
  menu.hidden = true;

  const header = el("div", "seventv-emote-menu-header", menu);
  const providers = el("div", "seventv-emote-menu-providers", header);

  const closeBtn = el("button", "seventv-emote-menu-close", header);
  closeBtn.type = "button";
  closeBtn.title = "Закрыть";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    menu.hidden = true;
  });

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

  const footer = el("div", "seventv-emote-menu-footer", menu);
  const previewImg = el("img", "seventv-preview-img", footer);
  const previewName = el("span", "seventv-preview-name", footer);

  function clearPreview() {
    previewImg.hidden = true;
    previewName.textContent = emoteMap.size + " emotes";
  }
  function showPreview(name, info) {
    previewImg.src = info.url;
    previewImg.hidden = false;
    previewName.textContent = info.zeroWidth ? name + " · overlay" : name;
  }

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

  // Highlight the rail icon of whichever set header sits at the top of the
  // scroll area, so the rail tracks scrolling and not just clicks.
  const railFor = new Map();
  const spy = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const tab = railFor.get(entry.target);
      if (!tab) continue;
      for (const other of icons.children) other.removeAttribute("selected");
      tab.setAttribute("selected", "true");
    }
  }, { root: scroller, rootMargin: "0px 0px -85% 0px" });

  const ctx = { watcher, spy, railFor, preview: showPreview };

  // Search results replace the set list rather than filtering it in place:
  // ranking only means something once the results are one flat list.
  const resultsContainer = el("div", "seventv-emote-set-container", scroller);
  resultsContainer.hidden = true;
  const resultsHeader = el("div", "seventv-set-header", resultsContainer);
  el("div", "seventv-set-header-icon", resultsHeader);
  const resultsName = el("span", "seventv-set-name", resultsHeader);
  const resultsGrid = el("div", "seventv-emote-set", resultsContainer);

  // Anything the local sets don't have is looked up in the full 7TV library.
  const libraryContainer = el("div", "seventv-emote-set-container", scroller);
  libraryContainer.hidden = true;
  const libraryHeader = el("div", "seventv-set-header", libraryContainer);
  el("div", "seventv-set-header-icon", libraryHeader);
  const libraryName = el("span", "seventv-set-name", libraryHeader);
  const libraryGrid = el("div", "seventv-emote-set", libraryContainer);

  const recentContainer = el("div", "seventv-emote-set-container", scroller);
  const recentHeader = el("div", "seventv-set-header", recentContainer);
  el("div", "seventv-set-header-icon", recentHeader);
  el("span", "seventv-set-name", recentHeader).textContent = "Recently used";
  const recentGrid = el("div", "seventv-emote-set", recentContainer);

  const collectedContainer = el("div", "seventv-emote-set-container", scroller);
  const collectedHeader = el("div", "seventv-set-header", collectedContainer);
  el("div", "seventv-set-header-icon", collectedHeader);
  el("span", "seventv-set-name", collectedHeader).textContent = "Kept from 7TV";
  const collectedGrid = el("div", "seventv-emote-set", collectedContainer);

  const setContainers = emoteSets.map(set => buildSetSection(set, scroller, icons, ctx));
  icons.firstElementChild?.setAttribute("selected", "true");

  function refreshCollected() {
    collectedGrid.textContent = "";
    for (const [name, info] of collected) {
      collectedGrid.appendChild(buildTile(name, info, ctx));
    }
    collectedContainer.hidden = collected.size === 0;
  }

  // Keeping an emote makes it render in chat and show up in suggestions, so
  // the menu and the kept section both have to catch up straight away.
  function pickFromLibrary(name, info) {
    keepEmote(name, info);
    insertEmote(name);
    refreshCollected();
    applyFilter();
  }

  let libraryTimer = null;
  let librarySeq = 0;

  function searchLibraryFor(query) {
    clearTimeout(libraryTimer);
    if (query.length < 3) {
      libraryContainer.hidden = true;
      return;
    }

    const seq = ++librarySeq;
    libraryContainer.hidden = false;
    libraryGrid.textContent = "";
    libraryName.textContent = "7TV library · searching…";

    // A search costs about half a second, so wait for a pause in typing
    // rather than firing one request per keystroke.
    libraryTimer = setTimeout(async () => {
      try {
        const hits = await searchLibrary(query, 60);
        if (seq !== librarySeq) return; // a newer query overtook this one
        const fresh = hits.filter(hit => !emoteMap.has(hit.name));
        libraryGrid.textContent = "";
        libraryName.textContent = fresh.length
          ? "7TV library · " + fresh.length
          : "7TV library · nothing new";
        for (const hit of fresh) {
          const tile = buildTile(hit.name, hit.info, ctx, pickFromLibrary);
          tile.setAttribute("library", "true");
          libraryGrid.appendChild(tile);
        }
      } catch (err) {
        if (seq !== librarySeq) return;
        libraryName.textContent = "7TV library · search failed";
        console.warn("[7TV for YouTube] library search failed", err);
      }
    }, 350);
  }

  function refreshRecent() {
    recentGrid.textContent = "";
    const live = recentNames.filter(n => emoteMap.has(n));
    for (const name of live) {
      recentGrid.appendChild(buildTile(name, emoteMap.get(name), ctx));
    }
    recentContainer.hidden = live.length === 0;
  }

  let activeIndex = -1;

  function visibleTiles() {
    return [...scroller.querySelectorAll(".seventv-emote-container")]
      .filter(tile => tile.offsetParent !== null);
  }

  function setActive(index) {
    const tiles = visibleTiles();
    for (const tile of tiles) tile.removeAttribute("active");
    if (!tiles.length) {
      activeIndex = -1;
      return;
    }
    activeIndex = Math.max(0, Math.min(index, tiles.length - 1));
    const tile = tiles[activeIndex];
    tile.setAttribute("active", "true");
    tile.scrollIntoView({ block: "nearest" });
    showPreview(tile.dataset.emote, emoteMap.get(tile.dataset.emote));
  }

  let mode = "all";

  function applyFilter() {
    const query = input.value.trim();
    const searching = query.length > 0;

    resultsContainer.hidden = !searching;
    for (const c of setContainers) c.hidden = searching || mode === "recent";

    collectedContainer.hidden = searching || mode === "recent" || collected.size === 0;
    searchLibraryFor(query);

    if (searching) {
      recentContainer.hidden = true;
      resultsGrid.textContent = "";
      const hits = rankedMatches(query, 120);
      resultsName.textContent = hits.length ? "Results · " + hits.length : "No matches";
      for (const hit of hits) resultsGrid.appendChild(buildTile(hit.name, hit.info, ctx));
    } else {
      refreshRecent();
      refreshCollected();
    }
    setActive(0);
  }

  for (const [label, value] of [["All", "all"], ["Recent", "recent"]]) {
    const chip = el("div", "seventv-emote-menu-provider-icon", providers);
    if (value === mode) chip.setAttribute("selected", "true");
    el("span", null, chip).textContent = label;
    chip.addEventListener("click", () => {
      mode = value;
      for (const other of providers.children) other.removeAttribute("selected");
      chip.setAttribute("selected", "true");
      applyFilter();
    });
  }

  input.addEventListener("input", applyFilter);

  input.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      e.preventDefault();
      menu.hidden = true;
      chatInput()?.focus();
      return;
    }

    const tiles = visibleTiles();
    if (!tiles.length) return;

    if (e.key === "Enter") {
      const tile = tiles[activeIndex];
      if (tile) {
        e.preventDefault();
        insertEmote(tile.dataset.emote);
      }
      return;
    }

    // Rows wrap, so a row is however many tiles share the first tile's top.
    const firstTop = tiles[0].offsetTop;
    const wrapAt = tiles.findIndex(tile => tile.offsetTop > firstTop);
    const perRow = wrapAt > 0 ? wrapAt : tiles.length;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[e.key];
    if (step === undefined) return;

    e.preventDefault();
    setActive((activeIndex < 0 ? 0 : activeIndex) + step);
  });

  scroller.addEventListener("mouseleave", clearPreview);

  document.body.appendChild(menu);

  menu.refresh = () => {
    input.value = "";
    applyFilter();
    clearPreview();
  };
  return menu;
}

function findButtonRow(renderer) {
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

  const renderer = document.querySelector("yt-live-chat-message-input-renderer");
  // Chat replay has no input to type into, so a picker there would be dead
  // UI: every click would insert into nothing.
  if (!renderer) return false;

  const host = findButtonRow(renderer);
  if (!host && !floating) return false;

  const panel = buildPicker();

  const btn = document.createElement("button");
  btn.id = "seventv-picker-toggle";
  btn.type = "button";
  btn.title = "7TV emotes";
  btn.textContent = "7TV";
  btn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    panel.refresh();
    panel.querySelector("input").focus();
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

  document.addEventListener("click", e => {
    if (panel.hidden) return;
    // Clicking the chat input must not close the menu — you often click into
    // the box to place the caret and then keep picking emotes.
    if (e.target.closest?.("#seventv-picker, #seventv-picker-toggle, yt-live-chat-message-input-renderer")) return;
    panel.hidden = true;
  });

  const input = chatInput();
  if (input) setupAutocomplete(input);
  return true;
}

function mountPickerWhenReady() {
  let tries = 0;
  const fastTimer = setInterval(() => {
    // ponytail: after ~15s give up on YouTube's button row and float the
    // toggle, so a DOM rename can never leave the picker unreachable.
    if (mountPicker(tries >= 30) || ++tries > 30) {
      clearInterval(fastTimer);
      startPickerWatchdog();
    }
  }, 500);
}

function startPickerWatchdog() {
  // YouTube periodically tears down and rebuilds the whole chat input
  // renderer (reconnects, switching "Top chat"/"Live chat", etc.), which
  // takes our injected button and panel down with it. Keep checking so the
  // button always comes back instead of vanishing for the rest of the
  // session — mountPicker() is a cheap no-op via the id check when the
  // button is already present.
  setInterval(() => {
    if (!document.getElementById("seventv-picker-toggle")) mountPicker(true);
  }, 3000);
}

// --- Autocomplete -----------------------------------------------------------
// Typing beats hunting through 900 tiles, so match what 7TV does on Twitch:
// type a couple of letters and pick from a short list without leaving the
// keyboard.

// Characters typed after the ":" before suggestions appear.
const AUTOCOMPLETE_MIN = 1;
const AUTOCOMPLETE_MAX = 8;

function caretToken() {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode) return null;

  const node = sel.anchorNode;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const before = node.nodeValue.slice(0, sel.anchorOffset);
  // Suggestions are opt-in behind a ":", the way emote autocomplete works on
  // Twitch. Matching any word popped a menu up mid-sentence. The ":" only
  // counts at the start of a word, so clock times and links stay quiet.
  const match = before.match(/(?:^|\s):([^\s:]*)$/);
  if (!match) return null;

  return {
    node,
    // Start on the ":" itself so accepting a suggestion replaces it too.
    start: sel.anchorOffset - match[1].length - 1,
    end: sel.anchorOffset,
    text: match[1]
  };
}

function replaceToken(token, name) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(token.node, token.start);
  range.setEnd(token.node, token.end);
  sel.removeAllRanges();
  sel.addRange(range);
  // Replacing the selection through execCommand keeps YouTube's own input
  // handling intact, same as inserting from the picker.
  document.execCommand("insertText", false, name + " ");
  rememberEmote(name);
}

function setupAutocomplete(input) {
  const box = el("div");
  box.id = "seventv-autocomplete";
  box.hidden = true;
  document.body.appendChild(box);

  let items = [];
  let active = 0;
  let token = null;

  function close() {
    box.hidden = true;
    items = [];
    token = null;
  }

  function render() {
    box.textContent = "";
    items.forEach((hit, i) => {
      const row = el("div", "seventv-autocomplete-row", box);
      if (i === active) row.setAttribute("active", "true");
      el("img", null, row).src = hit.info.url;
      el("span", null, row).textContent = hit.name;
      row.addEventListener("mousedown", e => {
        // mousedown, not click: clicking would blur the input and drop the
        // caret before the replacement could happen.
        e.preventDefault();
        replaceToken(token, hit.name);
        close();
      });
    });
    box.hidden = items.length === 0;
    // Both sit above the chat input, so they must not be open at once.
    const picker = document.getElementById("seventv-picker");
    if (picker && !box.hidden) picker.hidden = true;
  }

  input.addEventListener("input", () => {
    token = caretToken();
    if (!token || token.text.length < AUTOCOMPLETE_MIN) return close();

    // Kept open even on an exact name: the ":" still has to be replaced,
    // and only accepting a suggestion does that.
    items = rankedMatches(token.text, AUTOCOMPLETE_MAX);
    active = 0;
    render();
  });

  // Capture on the document: Enter has to be intercepted before YouTube sees
  // it, or picking a suggestion sends the half-typed message instead.
  document.addEventListener("keydown", e => {
    if (box.hidden || !items.length) return;

    if (e.key === "Escape") {
      close();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      render();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      replaceToken(token, items[active].name);
      close();
    }
  }, true);

  input.addEventListener("blur", () => setTimeout(close, 150));
}
