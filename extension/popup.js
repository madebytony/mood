const $ = (id) => document.getElementById(id);

async function cfg() {
  return chrome.storage.local.get({ appUrl: "http://localhost:3000", token: "", lastSpaceId: "" });
}

let currentTab = null;

async function init() {
  const { appUrl, token, lastSpaceId } = await cfg();
  if (!token) {
    $("status").textContent = "Not set up yet — add your app URL + token in Settings.";
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  $("sub").textContent = tab?.title || tab?.url || "";
  $("status").textContent = `Connected to ${appUrl.replace(/^https?:\/\//, "")}`;
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/clip`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      $("status").textContent = `Spaces failed (${res.status}): ${out?.error ?? "unknown"}`;
      return;
    }
    const spaces = out?.spaces;
    if (!Array.isArray(spaces)) throw new Error();
    renderSpaces(spaces, lastSpaceId);
  } catch {
    $("status").textContent = `Can't reach Mood at ${appUrl} — is it running on that port?`;
  }
}

function renderSpaces(spaces, lastSpaceId) {
  const list = $("spaces");
  list.innerHTML = "";
  const canCapture = !!currentTab?.url && /^https?:/.test(currentTab.url);
  if (!canCapture) $("status").textContent = "Can't capture this page.";
  for (const s of spaces) {
    const btn = document.createElement("button");
    btn.className = "space" + (s.id === lastSpaceId ? " last" : "");
    btn.disabled = !canCapture;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.kind === "inbox" ? `📥 ${s.name}` : s.name;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(s.count ?? 0);
    btn.append(name, count);
    btn.addEventListener("click", () => saveTo(s));
    list.appendChild(btn);
  }
}

async function saveTo(space) {
  const { appUrl, token } = await cfg();
  if (!currentTab?.url) return;
  chrome.storage.local.set({ lastSpaceId: space.id });
  for (const b of document.querySelectorAll(".space")) b.disabled = true;
  $("status").textContent = "Capturing… (can take ~15s)";
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/clip`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "page", url: currentTab.url, title: currentTab.title, space_id: space.id }),
    });
    const out = await res.json().catch(() => ({}));
    $("status").textContent = res.ok ? `Captured ✓ — saved to ${space.name}` : out.error || `Failed (${res.status})`;
  } catch {
    $("status").textContent = "Could not reach Mood — is it running?";
  }
  for (const b of document.querySelectorAll(".space")) b.disabled = false;
}

$("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
