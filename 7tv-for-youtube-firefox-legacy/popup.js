// Wrapped defensively: any thrown error here could leave the popup blank
// or stuck, which is the "sometimes doesn't open" symptom users see.
document.addEventListener("DOMContentLoaded", () => {
  try {
    initPopup();
  } catch (err) {
    console.error("[7TV for YouTube popup]", err);
    const status = document.getElementById("status");
    if (status) {
      status.textContent = "Popup error — see console (F12).";
      status.style.color = "#e8a0a0";
    }
  }
});

function extractId(token) {
  token = (token || "").trim();
  if (!token) return { ok: null };

  const setMatch = token.match(/emote-sets\/([A-Za-z0-9]+)/);
  if (setMatch) return { ok: setMatch[1] };

  if (/7tv\.app\/(users|@)/i.test(token)) return { error: token };

  if (/^[A-Za-z0-9]{6,}$/.test(token)) return { ok: token };

  return { error: token };
}

function makeRow(value = "") {
  const row = document.createElement("div");
  row.className = "row";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "https://7tv.app/emote-sets/... or a bare ID";
  input.value = value;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.addEventListener("click", () => row.remove());

  row.appendChild(input);
  row.appendChild(remove);
  return row;
}

async function initPopup() {
  const rowsContainer = document.getElementById("rows");
  const status = document.getElementById("status");

  let stored = [];
  try {
    const data = await chrome.storage.sync.get("emoteSetIds");
    stored = (data.emoteSetIds || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  } catch (err) {
    console.warn("[7TV for YouTube popup] storage read failed", err);
  }

  if (stored.length === 0) stored = [""];
  stored.forEach(id => rowsContainer.appendChild(makeRow(id)));

  document.getElementById("add-row").addEventListener("click", () => {
    rowsContainer.appendChild(makeRow());
  });

  document.getElementById("save").addEventListener("click", async () => {
    const inputs = [...rowsContainer.querySelectorAll("input")];
    const ids = [];
    let hadBadLink = false;

    for (const input of inputs) {
      const result = extractId(input.value);
      if (result.ok) ids.push(result.ok);
      else if (result.error) hadBadLink = true;
    }

    try {
      await chrome.storage.sync.set({ emoteSetIds: ids.join(",") });
    } catch (err) {
      console.error("[7TV for YouTube popup] storage write failed", err);
      status.textContent = "Failed to save — see console (F12).";
      status.style.color = "#e8a0a0";
      return;
    }

    if (hadBadLink) {
      status.textContent =
        "Skipped a channel/profile link — it needs to be the set's own " +
        "page (URL containing /emote-sets/).";
      status.style.color = "#e8a0a0";
    } else {
      status.textContent = `Saved ${ids.length} set(s). Reload your YouTube chat tab.`;
      status.style.color = "#8fd18f";
    }
  });
}
