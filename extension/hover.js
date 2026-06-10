/* Pinterest-style hover-to-save button on every image (saves to your last-used space). */
(async () => {
  try {
    const { appUrl } = await chrome.storage.sync.get({ appUrl: "http://localhost:3000" });
    if (new URL(appUrl).origin === location.origin) return; // never overlay Mood itself
  } catch {}
  let btn = null;
  let current = null;

  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.textContent = "Save to Mood";
    Object.assign(btn.style, {
      position: "absolute",
      zIndex: "2147483647",
      padding: "6px 10px",
      borderRadius: "999px",
      border: "none",
      background: "#7c5cff",
      color: "#fff",
      font: "600 12px -apple-system, system-ui, sans-serif",
      cursor: "pointer",
      boxShadow: "0 2px 10px rgba(0,0,0,.35)",
      display: "none",
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (current?.src) {
        chrome.runtime.sendMessage({
          type: "mood-save-image",
          src: current.currentSrc || current.src,
          page: location.href,
          title: document.title,
        });
        btn.textContent = "Saved ✓";
        setTimeout(() => { btn.textContent = "Save to Mood"; hide(); }, 900);
      }
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  function show(img) {
    const r = img.getBoundingClientRect();
    if (r.width < 120 || r.height < 80) return; // ignore tiny images
    current = img;
    const b = ensureBtn();
    b.style.left = `${window.scrollX + r.left + 8}px`;
    b.style.top = `${window.scrollY + r.top + 8}px`;
    b.style.display = "block";
  }

  function hide() {
    if (btn) btn.style.display = "none";
    current = null;
  }

  document.addEventListener("mouseover", (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement) show(t);
    else if (t !== btn && current) {
      const r = current.getBoundingClientRect();
      const { clientX: x, clientY: y } = e;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) hide();
    }
  }, { passive: true });

  document.addEventListener("scroll", hide, { passive: true });
})();
