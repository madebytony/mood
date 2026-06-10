const $ = (id) => document.getElementById(id);
chrome.storage.sync.get({ appUrl: "http://localhost:3000", token: "" }).then((d) => {
  $("appUrl").value = d.appUrl;
  $("token").value = d.token;
});
$("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({ appUrl: $("appUrl").value.trim(), token: $("token").value.trim() });
  $("ok").textContent = "Saved ✓";
  setTimeout(() => ($("ok").textContent = ""), 1500);
});
