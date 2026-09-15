// Receives status updates from the content script and reflects them on
// the extension's toolbar icon, similar to how 7TV Anywhere shows load
// state without needing an on-page element.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "seventv-status") return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  const text = msg.error ? "!" : String(msg.count ?? "");
  const color = msg.error ? "#e05252" : "#4c8bf5";

  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
});
