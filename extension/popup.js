const $ = (id) => document.getElementById(id);

async function cfg() {
  return chrome.storage.sync.get({ appUrl: "http://localhost:3000", token: "", lastSpaceId: "" });
}

async function init() {
  const { appUrl, token, lastSpaceId } = await cfg();
  if (!token) {
    $("status").textContent = "Not set up yet — add your app URL + token in Settings.";
    $("capture").disabled = true;
    $("space").disabled = true;
    return;
  }
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
    $("space").innerHTML = "";
    for (const s of spaces) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.kind === "inbox" ? `📥 ${s.name}` : s.name;
      if (s.id === lastSpaceId || (!lastSpaceId && s.kind === "inbox")) opt.selected = true;
      $("space").appendChild(opt);
    }
  } catch {
    $("status").textContent = `Can't reach Mood at ${appUrl} — is it running on that port?`;
  }
}

$("space").addEventListener("change", () => chrome.storage.sync.set({ lastSpaceId: $("space").value }));

$("capture").addEventListener("click", async () => {
  const { appUrl, token } = await cfg();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    $("status").textContent = "Can't capture this page.";
    return;
  }
  const space_id = $("space").value || undefined;
  if (space_id) chrome.storage.sync.set({ lastSpaceId: space_id });
  $("capture").disabled = true;
  $("status").textContent = "Capturing… (can take ~15s)";
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/clip`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "page", url: tab.url, title: tab.title, space_id }),
    });
    const out = await res.json().catch(() => ({}));
    $("status").textContent = res.ok
      ? `Captured ✓ — saved to ${$("space").selectedOptions[0]?.textContent ?? "Mood"}`
      : out.error || `Failed (${res.status})`;
  } catch {
    $("status").textContent = "Could not reach Mood — is it running?";
  }
  $("capture").disabled = false;
});

$("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
