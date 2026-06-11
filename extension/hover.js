/* Pinterest-style hover-to-save button — shows a space picker inline. */
(async () => {
  try {
    const { appUrl } = await chrome.storage.local.get({ appUrl: "http://localhost:3000" });
    if (new URL(appUrl).origin === location.origin) return; // never overlay Mood itself
  } catch {}

  let btn = null;
  let popover = null;
  let current = null;
  let hideTimer = null;

  // ---- UI helpers -----------------------------------------------------------

  const style = (el, css) => Object.assign(el.style, css);

  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement("button");
    btn.textContent = "Save to Mood";
    style(btn, {
      position: "absolute",
      zIndex: "2147483647",
      padding: "5px 11px",
      borderRadius: "999px",
      border: "none",
      background: "#7c5cff",
      color: "#fff",
      font: "600 12px -apple-system, system-ui, sans-serif",
      cursor: "pointer",
      boxShadow: "0 2px 10px rgba(0,0,0,.4)",
      display: "none",
      transition: "opacity .12s",
    });
    btn.addEventListener("mouseenter", () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openPicker(); });
    document.documentElement.appendChild(btn);
    return btn;
  }

  function ensurePopover() {
    if (popover) return popover;
    popover = document.createElement("div");
    style(popover, {
      position: "absolute",
      zIndex: "2147483647",
      minWidth: "160px",
      maxWidth: "220px",
      background: "#1e1e28",
      border: "1px solid rgba(255,255,255,.12)",
      borderRadius: "12px",
      boxShadow: "0 8px 32px rgba(0,0,0,.55)",
      padding: "6px",
      display: "none",
      fontFamily: "-apple-system, system-ui, sans-serif",
    });
    popover.addEventListener("mouseenter", () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
    popover.addEventListener("click", (e) => e.stopPropagation());
    document.documentElement.appendChild(popover);
    return popover;
  }

  // ---- Positioning ----------------------------------------------------------

  function show(img) {
    const r = img.getBoundingClientRect();
    if (r.width < 120 || r.height < 80) return;
    current = img;
    const b = ensureBtn();
    b.style.left = `${window.scrollX + r.left + 8}px`;
    b.style.top  = `${window.scrollY + r.top  + 8}px`;
    b.style.display = "block";
    b.textContent = "Save to Mood";
  }

  function positionPopover() {
    if (!btn || !popover) return;
    const bLeft = parseFloat(btn.style.left);
    const bTop  = parseFloat(btn.style.top);
    const bH    = btn.offsetHeight + 4;
    popover.style.left = `${bLeft}px`;
    popover.style.top  = `${bTop + bH}px`;
  }

  function hide() {
    if (btn) btn.style.display = "none";
    if (popover) popover.style.display = "none";
    current = null;
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 220);
  }

  // ---- Space picker ---------------------------------------------------------

  async function openPicker() {
    if (!current) return;
    const p = ensurePopover();

    // Loading state
    p.innerHTML = `<div style="padding:8px 10px;font-size:11px;color:#777">Loading spaces…</div>`;
    p.style.display = "block";
    positionPopover();

    let spaces = [];
    try {
      const resp = await chrome.runtime.sendMessage({ type: "mood-get-spaces" });
      spaces = resp?.spaces ?? [];
    } catch {
      // Background unreachable — fall through with empty list
    }

    p.innerHTML = "";

    const header = document.createElement("div");
    style(header, { padding: "4px 10px 6px", fontSize: "10px", color: "#666", textTransform: "uppercase", letterSpacing: ".06em" });
    header.textContent = "Save to…";
    p.appendChild(header);

    function makeSpaceBtn(label, spaceId) {
      const b = document.createElement("button");
      style(b, {
        display: "block", width: "100%", textAlign: "left",
        padding: "7px 10px", borderRadius: "8px", border: "none",
        background: "transparent", color: "#e0e0e8",
        font: "500 12px -apple-system, system-ui, sans-serif",
        cursor: "pointer",
      });
      b.textContent = label;
      b.addEventListener("mouseenter", () => b.style.background = "rgba(255,255,255,.1)");
      b.addEventListener("mouseleave", () => b.style.background = "transparent");
      b.addEventListener("click", () => doSave(spaceId, b));
      return b;
    }

    if (spaces.length) {
      for (const s of spaces) {
        const label = s.kind === "inbox" ? `📥  ${s.name}` : s.name;
        p.appendChild(makeSpaceBtn(label, s.id));
      }
    } else {
      // No spaces loaded — offer a quick save to the last-used space
      p.appendChild(makeSpaceBtn("Quick save (Inbox)", null));
    }

    positionPopover();
  }

  function doSave(spaceId, buttonEl) {
    if (!current) return;
    chrome.runtime.sendMessage({
      type: "mood-save-image",
      src: current.currentSrc || current.src,
      page: location.href,
      title: document.title,
      space_id: spaceId,
    });
    if (buttonEl) {
      buttonEl.textContent = "Saved ✓";
      buttonEl.style.color = "#a78bfa";
    }
    setTimeout(hide, 900);
  }

  // ---- Mouse tracking -------------------------------------------------------

  document.addEventListener("mouseover", (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement) {
      show(t);
    } else if (t !== btn && t !== popover && !popover?.contains(t) && current) {
      const r = current.getBoundingClientRect();
      const { clientX: x, clientY: y } = e;
      // Give a generous zone around the button + popover before hiding
      const btnR = btn?.getBoundingClientRect();
      const popR = popover?.getBoundingClientRect();
      const inBtn = btnR && x >= btnR.left - 8 && x <= btnR.right + 8 && y >= btnR.top - 8 && y <= btnR.bottom + 8;
      const inPop = popR && popover?.style.display !== "none" && x >= popR.left - 8 && x <= popR.right + 8 && y >= popR.top - 8 && y <= popR.bottom + 8;
      if (!inBtn && !inPop && (x < r.left || x > r.right || y < r.top || y > r.bottom)) {
        scheduleHide();
      }
    }
  }, { passive: true });

  document.addEventListener("scroll", hide, { passive: true });
  document.addEventListener("click", (e) => {
    if (e.target !== btn && !popover?.contains(e.target)) hide();
  }, { passive: true });
})();
