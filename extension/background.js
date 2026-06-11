const DEFAULTS = { appUrl: "http://localhost:3000", token: "", lastSpaceId: "" };

async function cfg() {
  return chrome.storage.local.get(DEFAULTS);
}

/** One-time move of settings out of synced storage — a long-lived token shouldn't ride the
 *  Chrome/Google-account sync to every signed-in device. Runs on install/startup, then clears sync. */
async function migrateFromSync() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get(DEFAULTS),
  ]);
  if (!synced.token && !synced.lastSpaceId && synced.appUrl === DEFAULTS.appUrl) return;
  await chrome.storage.local.set({
    appUrl: local.appUrl !== DEFAULTS.appUrl ? local.appUrl : synced.appUrl,
    token: local.token || synced.token,
    lastSpaceId: local.lastSpaceId || synced.lastSpaceId,
  });
  await chrome.storage.sync.remove(["appUrl", "token", "lastSpaceId"]);
}

async function clip(payload) {
  const { appUrl, token, lastSpaceId } = await cfg();
  if (!token) {
    notify("Mood Clipper", "Set your app URL + token in the extension options first.");
    return;
  }
  if (!payload.space_id && lastSpaceId) payload.space_id = lastSpaceId;
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/clip`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok) notify("Saved to Mood", payload.kind === "page" ? "Page captured ✓" : "Image saved ✓");
    else notify("Mood Clipper", out.error || `Failed (${res.status})`);
  } catch {
    notify("Mood Clipper", "Could not reach Mood — is it running?");
  }
}

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icon128.png", title, message });
}

/* Context menus with a space submenu (refreshed when settings change). */
async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: "mood-image", title: "Save image to Mood", contexts: ["image"] });
  chrome.contextMenus.create({ id: "mood-page", title: "Capture this page in Mood", contexts: ["page"] });
  const { appUrl, token } = await cfg();
  if (!token) return;
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/clip`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const { spaces } = await res.json();
    if (!Array.isArray(spaces) || !spaces.length) return;
    for (const s of spaces) {
      const name = s.kind === "inbox" ? `📥 ${s.name}` : s.name;
      chrome.contextMenus.create({ id: `mood-image::${s.id}`, parentId: "mood-image", title: name, contexts: ["image"] });
      chrome.contextMenus.create({ id: `mood-page::${s.id}`, parentId: "mood-page", title: name, contexts: ["page"] });
    }
  } catch {
    /* menus stay flat; saves default to last-used space / Inbox */
  }
}

chrome.runtime.onInstalled.addListener(() => migrateFromSync().then(rebuildMenus));
chrome.runtime.onStartup.addListener(() => migrateFromSync().then(rebuildMenus));
chrome.storage.onChanged.addListener(rebuildMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  const [kind, spaceId] = id.split("::");
  if (spaceId) chrome.storage.local.set({ lastSpaceId: spaceId });
  if (kind === "mood-image" && info.srcUrl) {
    clip({ kind: "image", url: info.srcUrl, page_url: tab?.url, title: tab?.title, space_id: spaceId });
  } else if (kind === "mood-page" && tab?.url) {
    clip({ kind: "page", url: tab.url, title: tab.title, space_id: spaceId });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "mood-save-image") {
    clip({ kind: "image", url: msg.src, page_url: msg.page, title: msg.title, space_id: msg.space_id });
    return false;
  }
  if (msg?.type === "mood-get-spaces") {
    // Fetch spaces from the app and return them to the content script
    cfg().then(async ({ appUrl, token }) => {
      if (!token) { sendResponse({ spaces: [] }); return; }
      try {
        const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/clip`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const { spaces } = await res.json();
        sendResponse({ spaces: Array.isArray(spaces) ? spaces : [] });
      } catch {
        sendResponse({ spaces: [] });
      }
    });
    return true; // keeps the message channel open for the async sendResponse
  }
});
