import fs from "fs";
import sharp from "sharp";
import { assertPublicUrl, safeFetch } from "./ssrf";
import { gemini, geminiDisabled, geminiText, hasGeminiKey } from "./gemini";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const LOCAL_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

export async function launchBrowser() {
  const puppeteer = await import("puppeteer-core");
  if (process.env.VERCEL) {
    // Vercel hides AWS's Lambda env vars, so @sparticuz/chromium doesn't realise it's on
    // Lambda and skips extracting its bundled shared libs (-> libnss3.so not found).
    // Faking the vars makes it extract the libs and set LD_LIBRARY_PATH properly.
    process.env.AWS_LAMBDA_FUNCTION_NAME ||= "mood-capture";
    process.env.AWS_EXECUTION_ENV ||= "AWS_Lambda_nodejs20.x";
    process.env.AWS_LAMBDA_JS_RUNTIME ||= "nodejs20.x";
    // Full package: ships the binary + shared libs inside node_modules (no remote pack download).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromium: any = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  const exe = LOCAL_CHROME.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("No Chrome/Chromium found on this machine");
  return puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
}

const CLEAN_PAGE = `(() => {
  const clickTexts = ["accept all","accept","agree","allow all","got it","i understand","ok"];
  const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=submit]"));
  for (const b of buttons) {
    const t = (b.textContent || b.value || "").trim().toLowerCase();
    if (t && t.length < 30 && clickTexts.some((c) => t === c || t.startsWith(c + " "))) {
      try { b.click(); } catch {}
    }
  }
  const sus = document.querySelectorAll(
    "[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [id*='gdpr' i], [class*='gdpr' i], [aria-label*='cookie' i]"
  );
  for (const el of Array.from(sus)) {
    try {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.height < window.innerHeight * 0.6 && r.width > window.innerWidth * 0.3) el.remove();
    } catch {}
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    try {
      const cs = getComputedStyle(el);
      if (cs.position === "fixed") {
        const r = el.getBoundingClientRect();
        const cover = (r.width * r.height) / (vw * vh);
        const z = parseInt(cs.zIndex) || 0;
        if (cover > 0.5 && z > 10) el.remove();
      }
    } catch {}
  }
  document.documentElement.style.overflow = "visible";
})()`;

/** Kill animation libraries and snap all CSS transitions to their end state.
 *  Must run BEFORE LAZY_SCROLL so scroll-triggered content is visible when we scroll through. */
const FLUSH_MOTION = `(() => {
  // Instant CSS: reduce all animation/transition durations so triggered elements appear immediately
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{animation-duration:0.001ms!important;animation-delay:0ms!important;transition-duration:0.001ms!important;transition-delay:0ms!important}';
  document.head.appendChild(s);
  // Destroy Lenis — it intercepts window.scrollTo(), preventing scroll triggers from firing
  try { if (window.lenis) { window.lenis.destroy(); window.lenis = null; } } catch {}
  try { if (window.__lenis) { window.__lenis.destroy(); window.__lenis = null; } } catch {}
  document.documentElement.className = document.documentElement.className.replace(/\\blenis[\\w-]*\\b/g, '').trim();
  // Fast-forward GSAP global timeline so all queued tweens snap to end
  try { if (window.gsap) window.gsap.globalTimeline.progress(1, false); } catch {}
  // Snap all ScrollTrigger instances to their triggered state
  try { if (window.ScrollTrigger) window.ScrollTrigger.getAll().forEach((t) => t.progress(1, false)); } catch {}
  // Reveal anything hidden by AOS / ScrollReveal / sal.js
  for (const el of document.querySelectorAll('[data-aos],[data-sal],[data-sr],[data-scroll]')) {
    try { const cs = window.getComputedStyle(el); if (parseFloat(cs.opacity) < 0.1) el.style.opacity = '1'; } catch {}
    try { el.style.visibility = 'visible'; el.style.transform = 'none'; } catch {}
  }
  // Webflow IX2 — its own animation engine doesn't use GSAP so globalTimeline.progress() won't snap it.
  // Elements start at opacity:0/transform and IX2 drives them to their end state on scroll.
  for (const el of document.querySelectorAll('[data-w-id]')) {
    try {
      const cs = window.getComputedStyle(el);
      if (parseFloat(cs.opacity) < 0.9 || cs.visibility === 'hidden') {
        el.style.opacity = '1';
        el.style.transform = 'none';
        el.style.visibility = 'visible';
      }
    } catch {}
  }
})()`;

/** Is a preloader/splash overlay still blocking the viewport? Catches full-viewport
 *  fixed/absolute elements that are opaque and either named like a loader or sat at a
 *  high z-index with almost no content (heroes have headlines; preloaders don't). */
const PRELOADER_CHECK = `(() => {
  const vw = innerWidth, vh = innerHeight;
  let i = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (++i > 1500) break;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.4) continue;
      if (cs.position !== "fixed" && cs.position !== "absolute") continue;
      const r = el.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (ix * iy < vw * vh * 0.85) continue;
      const name = (typeof el.className === "string" ? el.className : "") + " " + el.id;
      const named = /(pre)?-?load(er|ing)|splash|curtain|page-transition|site-intro|spinner/i.test(name);
      const bg = cs.backgroundColor || "";
      const m = /rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*(?:,\\s*([\\d.]+))?\\s*\\)/.exec(bg);
      const opaque = !!m && (m[1] === undefined || parseFloat(m[1]) >= 0.5);
      const z = parseInt(cs.zIndex) || 0;
      if (named && opaque) return true;
      if (opaque && cs.position === "fixed" && z >= 50) {
        const text = (el.innerText || "").trim();
        if (text.length < 120 && el.querySelectorAll("img,picture,video").length <= 1) return true;
      }
    } catch {}
  }
  return false;
})()`;

/** Last resort before the retry shot: tear out anything loader-shaped that refused to leave.
 *  Only runs after the viewport probed flat, so a visible hero can't be here to lose. */
const NUKE_OVERLAY = `(() => {
  const vw = innerWidth, vh = innerHeight;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    try {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (ix * iy < vw * vh * 0.6) continue;
      const name = (typeof el.className === "string" ? el.className : "") + " " + el.id;
      const named = /(pre)?-?load(er|ing)|splash|curtain|page-transition|site-intro/i.test(name);
      const positioned = (cs.position === "fixed" || cs.position === "absolute") && (parseInt(cs.zIndex) || 0) > 5;
      if (!named && !positioned) continue;
      // never tear out a wrapper that holds the actual page
      if (el.querySelectorAll("img, picture, section, h1, h2").length > 3) continue;
      el.remove();
    } catch {}
  }
  document.documentElement.style.overflow = "visible";
  if (document.body) document.body.style.overflow = "visible";
})()`;

async function waitForOverlayGone(page: { evaluate: (s: string) => Promise<unknown> }, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const blocking = await page.evaluate(PRELOADER_CHECK).catch(() => false);
    if (!blocking || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 600));
  }
}

const LAZY_SCROLL = `(async () => {
  const step = window.innerHeight;
  const max = Math.min(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), 12000);
  for (let y = 0; y < max; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 180));
  }
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event("scroll"));
  await new Promise((r) => setTimeout(r, 900));
})()`;

/** Rank the typefaces actually painted on the page (weighted by visible text length). */
const FONT_SNIFF = `(() => {
  const generic = new Set(["serif","sans-serif","monospace","cursive","fantasy","system-ui","ui-sans-serif","ui-serif","ui-monospace",
    "-apple-system","blinkmacsystemfont","segoe ui","arial","helvetica","helvetica neue","times new roman","times","georgia","verdana","tahoma","inherit","initial"]);
  const clean = (f) => f.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  const score = new Map();
  let n = 0;
  for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,p,a,li,span,blockquote,button,figcaption,div")) {
    if (++n > 2500) break;
    const t = (el.childNodes.length && el.textContent || "").trim();
    if (t.length < 2) continue;
    const fam = clean(getComputedStyle(el).fontFamily || "");
    if (!fam || generic.has(fam.toLowerCase()) || /icon|glyph|symbol|emoji|awesome/i.test(fam)) continue;
    const weight = /^h[1-4]$/i.test(el.tagName) ? 120 : Math.min(t.length, 60);
    score.set(fam, (score.get(fam) || 0) + weight);
  }
  const loaded = new Set();
  try { document.fonts.forEach((f) => { if (f.status === "loaded") loaded.add(clean(f.family)); }); } catch {}
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  for (const f of loaded) if (!ranked.includes(f) && !generic.has(f.toLowerCase()) && !/icon|glyph|symbol|emoji|awesome/i.test(f)) ranked.push(f);

  // Which library served them? (Google lists families in its CSS URL; others by loader domain.)
  let res = [];
  try { res = performance.getEntriesByType("resource").map((r) => r.name); } catch {}
  const googleFams = new Set();
  for (const u of res) {
    const m = /fonts\\.googleapis\\.com\\/css2?\\?(.+)/.exec(u);
    if (!m) continue;
    for (const part of decodeURIComponent(m[1]).split("&")) {
      const f = /^family=([^:;@&]+)/.exec(part.trim());
      if (f) for (const fam of f[1].split("|")) googleFams.add(fam.replace(/\\+/g, " ").trim().toLowerCase());
    }
  }
  const hasTypekit = res.some((u) => /typekit\\.net|typekit\\.com/.test(u));
  const hasFontshare = res.some((u) => /fontshare\\.com/.test(u));
  const hasMyFonts = res.some((u) => /myfonts\\.net|fast\\.fonts\\.net/.test(u));
  const provider = (f) => {
    const k = f.toLowerCase();
    if (googleFams.has(k) || [...googleFams].some((g) => k.startsWith(g))) return "google";
    if (hasTypekit) return "adobe";
    if (hasFontshare) return "fontshare";
    if (hasMyFonts) return "myfonts";
    return "";
  };
  return ranked.slice(0, 6).map((f) => { const p = provider(f); return p ? f + "@" + p : f; });
})()`;

/** Fingerprint the frameworks / builders / motion libraries actually running on the page.
 *  Three layers: runtime globals & DOM markers, resource URLs, and the *contents* of the
 *  site's JS bundles (catches libraries compiled in with no global and no CDN URL). */
const TECH_SNIFF = `((extraBlob) => {
  const t = new Set();
  const w = window;
  const html = document.documentElement;
  let resources = [];
  try { resources = performance.getEntriesByType("resource").map((r) => r.name); } catch {}
  const scriptSrcs = Array.from(document.scripts).map((s) => s.src).filter(Boolean);
  const scripts = [...scriptSrcs, ...resources].join("\\n").toLowerCase();
  const gen = (document.querySelector('meta[name="generator" i]')?.getAttribute("content") || "").toLowerCase();
  const has = (re) => re.test(scripts);

  // Bundle contents: network-captured JS (handed in by the capture engine) + inline scripts.
  let blob = (extraBlob || "");
  for (const s of document.scripts) if (!s.src && s.textContent) blob += s.textContent.slice(0, 200000).toLowerCase();
  const inBundle = (re) => re.test(blob);

  // app frameworks
  if (w.__NEXT_DATA__ || w.__next_f || (w.next && w.next.version) || document.getElementById("__next")) t.add("Next.js");
  else if (w.__NUXT__ || document.getElementById("__nuxt")) t.add("Nuxt");
  else if (document.getElementById("___gatsby")) t.add("Gatsby");
  if (document.querySelector("astro-island") || gen.includes("astro")) t.add("Astro");
  if (!t.has("Next.js") && !t.has("Gatsby")) {
    let react = !!w.React;
    let i = 0;
    if (!react) outer: for (const e of document.querySelectorAll("body, body div, body main, body section")) {
      if (++i > 150) break;
      for (const k in e) if (k.indexOf("__reactFiber") === 0 || k.indexOf("__reactContainer") === 0) { react = true; break outer; }
    }
    if (react) t.add("React");
  }
  if (w.__VUE__ || w.Vue || document.querySelector("[data-v-app]")) t.add("Vue");
  if (html.hasAttribute("ng-version") || document.querySelector("[ng-version]")) t.add("Angular");
  if (document.querySelector('[class*="svelte-"]')) t.add("Svelte");
  if (w.Alpine) t.add("Alpine.js");
  if (w.htmx) t.add("htmx");
  if (w.jQuery && !gen.includes("wordpress")) t.add("jQuery");

  // builders / CMS
  if (w.Webflow || html.hasAttribute("data-wf-site") || gen.includes("webflow")) t.add("Webflow");
  if (gen.includes("framer") || document.getElementById("__framer") || has(/framerusercontent/)) t.add("Framer");
  if (gen.includes("wordpress") || has(/wp-content|wp-includes/)) t.add("WordPress");
  if (w.Shopify || has(/cdn\\.shopify/)) t.add("Shopify");
  if ((w.Static && w.Static.SQUARESPACE_CONTEXT) || gen.includes("squarespace") || has(/squarespace/)) t.add("Squarespace");
  if (gen.includes("wix") || w.wixBiSession) t.add("Wix");
  if (has(/cargo\\.site|cargocollective/)) t.add("Cargo");
  if (gen.includes("readymag") || has(/readymag/)) t.add("Readymag");
  if (gen.includes("ghost")) t.add("Ghost");

  // headless CMS by asset domain
  if (has(/ctfassets\\.net/)) t.add("Contentful");
  if (has(/cdn\\.sanity\\.io/)) t.add("Sanity");
  if (has(/images\\.prismic\\.io|prismic\\.io\\/api/)) t.add("Prismic");
  if (has(/storyblok\\.com/)) t.add("Storyblok");
  if (has(/datocms-assets\\.com/)) t.add("DatoCMS");

  // motion / interaction — globals, DOM side-effects, URLs, and bundle contents
  if (w.gsap || w.TweenMax || has(/gsap/) || inBundle(/gsap|greensock/)) t.add("GSAP");
  if ((t.has("GSAP") && document.querySelector(".pin-spacer")) || w.ScrollTrigger || inBundle(/scrolltrigger/)) t.add("GSAP ScrollTrigger");
  if (w.Lenis || html.classList.contains("lenis") || has(/lenis/) || inBundle(/@studio-freight\\/lenis|lenis\\b/)) t.add("Lenis");
  if (w.LocomotiveScroll || document.querySelector("[data-scroll-container]") || has(/locomotive/) || inBundle(/locomotive-scroll/)) t.add("Locomotive Scroll");
  if (w.barba || has(/barba/) || inBundle(/@barba\\/core|barba\\.init/)) t.add("Barba.js");
  if (w.THREE || has(/\\bthree(\\.min)?\\.js|three@/) || inBundle(/three\\.module|webglrenderer/)) t.add("Three.js");
  if (inBundle(/framer-motion/)) t.add("Framer Motion");
  if (document.querySelector("lottie-player") || has(/lottie/) || inBundle(/lottie/)) t.add("Lottie");
  if (document.querySelector("spline-viewer") || has(/spline\\.design|splinetool/) || inBundle(/splinetool/)) t.add("Spline");
  if (has(/rive\\.app|rive-canvas|rive\\.wasm/) || inBundle(/@rive-app|rive\\.wasm/)) t.add("Rive");
  if (w.anime || has(/animejs|anime\\.min/) || inBundle(/animejs/)) t.add("Anime.js");
  if (w.AOS || document.querySelector("[data-aos]")) t.add("AOS");
  if (w.pJSDom || has(/particles\\.js/)) t.add("Particles.js");
  if (w.Swiper || document.querySelector(".swiper, .swiper-container") || inBundle(/swiper/)) t.add("Swiper");
  if (document.querySelector(".splide") || has(/splide/)) t.add("Splide");
  if (w.Flickity || document.querySelector(".flickity-enabled")) t.add("Flickity");
  if (w.Plyr || has(/plyr/)) t.add("Plyr");
  if (has(/player\\.vimeo\\.com/)) t.add("Vimeo Player");
  if (has(/mux\\.com/) || document.querySelector("mux-player")) t.add("Mux");

  // styling: Tailwind always leaves --tw- custom properties in its compiled CSS
  let css = "";
  for (const st of document.querySelectorAll("style")) { css += (st.textContent || "").slice(0, 80000); if (css.length > 250000) break; }
  try {
    for (const sh of document.styleSheets) {
      if (css.length > 250000) break;
      try { for (const r of sh.cssRules) { css += r.cssText; if (css.length > 250000) break; } } catch {}
    }
  } catch {}
  let cls = "";
  let n = 0;
  for (const e of document.querySelectorAll("body [class]")) {
    if (++n > 300) break;
    if (typeof e.className === "string") cls += " " + e.className;
  }
  if (/--tw-/.test(css) || /(^|\\s)(sm:|md:|lg:|xl:)[a-z-]/.test(cls)) t.add("Tailwind CSS");

  return Array.from(t).slice(0, 16);
})`;

/** Hosting / CDN from the main document's response headers. */
function hostingFrom(headers: Record<string, string>): string[] {
  const out: string[] = [];
  const server = (headers["server"] ?? "").toLowerCase();
  if (headers["x-vercel-id"] || server.includes("vercel")) out.push("Vercel");
  if (headers["x-nf-request-id"] || server.includes("netlify")) out.push("Netlify");
  if (server.includes("cloudflare")) out.push("Cloudflare");
  if (server.includes("github.com")) out.push("GitHub Pages");
  if (headers["x-amz-cf-id"] && !out.length) out.push("AWS CloudFront");
  if ((headers["x-served-by"] ?? "").includes("cache") || server.includes("fastly")) out.push("Fastly");
  return out;
}

export interface Shot {
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
  engine: "chromium" | "thum.io";
  fonts?: string[];
  tech?: string[];
}

export interface FlatStats {
  /** Share of pixels in the single most common quantised colour (0..1). */
  top: number;
  /** Distinct quantised colours in the 64x64 sample. */
  distinct: number;
}

/** Histogram the top viewport-ish region of an image using the browser's own decoders
 *  (JPEG/PNG/WebP all work) — downscale to 64x64 on a canvas in a blank page, then count
 *  4-bit-per-channel colour buckets. Cheap, no native deps. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function imageFlatStats(browser: any, bytes: Uint8Array, type: string): Promise<FlatStats | null> {
  let page;
  try {
    page = await browser.newPage();
    const dataUrl = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    const out = await page.evaluate(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("decode")); img.src = ${JSON.stringify(dataUrl)}; });
      const w = 64, h = 64;
      // analyse only the top ~viewport of tall captures — that's what becomes the thumbnail
      const sh = Math.min(img.naturalHeight, Math.max(1, Math.round(img.naturalWidth * 0.67)));
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, img.naturalWidth, sh, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      const hist = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        hist.set(k, (hist.get(k) || 0) + 1);
      }
      let max = 0; for (const v of hist.values()) if (v > max) max = v;
      return { top: max / (w * h), distinct: hist.size };
    })()`);
    return out as FlatStats;
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** A preloader/blank screen is one overwhelming colour with almost no detail. A minimal
 *  real site also has a dominant colour, but its text/images spread across many buckets. */
export function looksFlat(s: FlatStats | null): boolean {
  if (!s) return false;
  return s.top >= 0.92 || (s.top >= 0.8 && s.distinct <= 24);
}

/** Same histogram as imageFlatStats but via sharp (no browser) — for routes that have the
 *  screenshot bytes but no Puppeteer instance to spare. Analyses only the top ~viewport of
 *  tall captures, which is what becomes the thumbnail. */
export async function flatStatsBytes(bytes: Uint8Array): Promise<FlatStats | null> {
  try {
    const buf = Buffer.from(bytes);
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return null;
    const cropH = Math.min(h, Math.max(1, Math.round(w * 0.67)));
    const { data } = await sharp(buf)
      .extract({ left: 0, top: 0, width: w, height: cropH })
      .resize(64, 64, { fit: "fill" })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hist = new Map<number, number>();
    for (let i = 0; i + 2 < data.length; i += 3) {
      const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
    let max = 0;
    for (const v of hist.values()) if (v > max) max = v;
    const total = data.length / 3 || 1;
    return { top: max / total, distinct: hist.size };
  } catch {
    return null;
  }
}

/** Vision gate: histograms catch flat preloaders, but a structured block page (Cloudflare
 *  "you have been blocked", styled 404s, cookie walls) isn't flat. Ask Gemini whether the shot
 *  shows real site content; returns the rejection kind (e.g. "block"/"error") or null when it's
 *  real or the check can't run (fail open so a missing key never blocks a capture). */
export async function screenshotRejected(bytes: Uint8Array, type: string): Promise<string | null> {
  if (!hasGeminiKey() || geminiDisabled()) return null;
  try {
    const res = await gemini({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: type, data: Buffer.from(bytes).toString("base64") } },
          { text: `This is an automated screenshot of a webpage. Reply with JSON only: {"ok": true|false, "kind": "site"|"block"|"error"|"loading"|"cookie"|"blank"}. ok is true only if it shows a real website's actual content. ok is false for: bot-check / access-denied / captcha / "verify you are human" pages, error pages (404, 500, "page not found"), loading or splash screens, a cookie-consent wall obscuring the page, or a mostly blank page.` },
        ],
      }],
      generationConfig: { maxOutputTokens: 60, responseMimeType: "application/json" },
    });
    const out = JSON.parse(geminiText(res));
    return out.ok === false ? String(out.kind ?? "rejected") : null;
  } catch {
    return null;
  }
}

export async function chromiumShot(url: string): Promise<Shot> {
  let browser;
  let fonts: string[] = [];
  let tech: string[] = [];
  try {
    browser = await launchBrowser();

    // Collect JS bundle contents off the wire (CORS-proof) for the tech sniffer.
    const jsBlobs: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collectJs = (r: any) => {
      (async () => {
        if (jsBlobs.length >= 8) return;
        const ct = r.headers()["content-type"] ?? "";
        if (!/javascript|ecmascript/i.test(ct)) return;
        if (/gtag|googletag|analytics|fbevents|hotjar|clarity|recaptcha|stripe|cookie|consent/i.test(r.url())) return;
        const text = await r.text();
        jsBlobs.push(text.slice(0, 600_000).toLowerCase());
      })().catch(() => {});
    };

    // SSRF guard for the browser itself. The route's assertPublicUrl() is only a pre-flight: once
    // Puppeteer navigates, *it* resolves DNS and follows redirects, so a public URL could 30x-bounce
    // or DNS-rebind into a private address (localhost services, cloud metadata, LAN) — the exact
    // thing safeFetch/pinnedLookup guard against on every other fetch path. Re-validate every
    // request (initial navigation, each redirect hop, and subresources) and abort anything that
    // doesn't resolve public. Per-host cache keeps the cost to one lookup per distinct hostname.
    // Residual: a sub-millisecond TTL-0 rebind between this lookup and Chrome's own resolve; closing
    // that fully needs a pinned-connect forward proxy, overkill for a single-owner app.
    const hostOk = new Map<string, boolean>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guardRequest = (r: any) => {
      (async () => {
        const reqUrl = r.url();
        if (/^(data|blob|about):/i.test(reqUrl)) return r.continue();
        let ok = false;
        try {
          const u = new URL(reqUrl);
          if (u.protocol === "http:" || u.protocol === "https:") {
            const host = u.hostname.replace(/^\[|\]$/g, "");
            const cached = hostOk.get(host);
            ok = cached ?? (await assertPublicUrl(reqUrl).then(() => true).catch(() => false));
            if (cached === undefined) hostOk.set(host, ok);
          }
        } catch { /* malformed → abort below */ }
        await (ok ? r.continue() : r.abort()).catch(() => {});
      })();
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setupPage = async (p: any) => {
      await p.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
      await p.setUserAgent(UA);
      // prefers-reduced-motion: reduce — well-coded animation libraries (GSAP, Lottie) will
      // skip their intro tweens and show final states, preventing blank gaps in the capture.
      await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await p.setRequestInterception(true);
      p.on("request", guardRequest);
      p.on("response", collectJs);
    };

    let page = await browser.newPage();
    await setupPage(page);

    let resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 35000 }).catch(() => null);

    // Page crashed (heavy WebGL under software rendering)? Reload once with WebGL stubbed —
    // the DOM, fonts and JS bundles are still all there to read.
    const alive = await page.evaluate("1").then(() => true).catch(() => false);
    if (!alive) {
      await page.close().catch(() => {});
      page = await browser.newPage();
      await setupPage(page);
      await page.evaluateOnNewDocument(`
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (/webgl|webgpu/i.test(String(type))) return null;
          return orig.call(this, type, ...args);
        };`);
      resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 2500));
    }

    // A 404/410/5xx main document means we'd immortalise an error page — and the thum.io
    // fallback would faithfully screenshot the same thing, so fail loudly instead.
    // 401/403 stay soft: bot walls often send those while still rendering real content.
    const status = resp?.status() ?? 0;
    if (status >= 400 && status !== 401 && status !== 403) {
      const httpErr = new Error(`page returned HTTP ${status}`) as Error & { permanent?: boolean };
      httpErr.permanent = true;
      throw httpErr;
    }

    // Preloaders/splash screens regularly outlive networkidle2 (animation-gated, not
    // network-gated) — give the overlay a few seconds to clear before reading the page.
    await waitForOverlayGone(page, 6000);

    // Sniff fonts + tech FIRST — scrolling can crash heavy WebGL pages under software
    // rendering, and we want the metadata even if the screenshot later falls back.
    fonts = (await page.evaluate(FONT_SNIFF).catch(() => [])) as string[];
    const bundleBlob = jsBlobs.join("\n").slice(0, 2_500_000);
    const pageTech = (await page
      .evaluate(`(${TECH_SNIFF})(${JSON.stringify(bundleBlob)})`)
      .catch(() => [])) as string[];
    tech = [...new Set([...pageTech, ...hostingFrom(resp?.headers() ?? {})])];

    await page.evaluate(FLUSH_MOTION).catch(() => {});
    await page.evaluate(LAZY_SCROLL).catch(() => {});
    await page.evaluate(CLEAN_PAGE).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    // Probe the viewport with a cheap small shot — if it's one flat colour we're staring at
    // a preloader (or content gated behind it). Wait once more, tear the overlay out, re-clean.
    const probe = await page
      .screenshot({ type: "jpeg", quality: 60, clip: { x: 0, y: 0, width: 1440, height: 960 } })
      .catch(() => null);
    if (probe && looksFlat(await imageFlatStats(browser, probe, "image/jpeg"))) {
      await waitForOverlayGone(page, 5000);
      await page.evaluate(NUKE_OVERLAY).catch(() => {});
      await page.evaluate(CLEAN_PAGE).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }

    const height = Math.min(
      await page.evaluate("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)").then((h) => Number(h) || 960),
      8000
    );
    // Heavy WebGL pages can fail tall captures under software rendering — step down before giving up.
    let buf: Uint8Array | undefined;
    for (const h of [...new Set([height, Math.min(height, 2800), 960])]) {
      try {
        buf = await page.screenshot({ type: "jpeg", quality: 82, clip: { x: 0, y: 0, width: 1440, height: h } });
        break;
      } catch {}
    }
    if (!buf) throw new Error("screenshot failed at all heights");
    await browser.close();
    // buf is a screenshot Buffer over a normal (non-shared) ArrayBuffer; assert the precise type
    return { bytes: buf as Uint8Array<ArrayBuffer>, type: "image/jpeg", engine: "chromium", fonts, tech };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    // Carry whatever we managed to sniff so the fallback image can still get fonts/tech.
    const err = e as Error & { fonts?: string[]; tech?: string[] };
    err.fonts = fonts;
    err.tech = tech;
    throw err;
  }
}

/** Browserless metadata sniff from raw HTML — for sites that crash headless Chrome. */
async function staticSniff(url: string): Promise<{ fonts: string[]; tech: string[] }> {
  try {
    const res = await safeFetch(url, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(10000),
    });
    const html = (await res.text()).slice(0, 900_000);
    const lower = html.toLowerCase();
    const has = (re: RegExp) => re.test(lower);
    const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]?.toLowerCase() ?? "";
    const tech: string[] = [];
    if (has(/__next_f|__next_data__|\/_next\//)) tech.push("Next.js");
    if (has(/__nuxt/)) tech.push("Nuxt");
    if (gen.includes("webflow") || has(/data-wf-site/)) tech.push("Webflow");
    if (gen.includes("framer") || has(/framerusercontent/)) tech.push("Framer");
    if (gen.includes("wordpress") || has(/wp-content/)) tech.push("WordPress");
    if (has(/cdn\.shopify/)) tech.push("Shopify");
    if (gen.includes("squarespace") || has(/squarespace/)) tech.push("Squarespace");
    if (has(/gsap|greensock/)) tech.push("GSAP");
    if (has(/scrolltrigger/)) tech.push("GSAP ScrollTrigger");
    if (has(/lenis/)) tech.push("Lenis");
    if (has(/locomotive-scroll/)) tech.push("Locomotive Scroll");
    if (has(/three(\.min)?\.js|three\.module|webglrenderer/)) tech.push("Three.js");
    if (has(/framer-motion/)) tech.push("Framer Motion");
    if (has(/lottie/)) tech.push("Lottie");
    if (has(/swiper/)) tech.push("Swiper");
    if (has(/--tw-/)) tech.push("Tailwind CSS");
    tech.push(...hostingFrom(Object.fromEntries(res.headers.entries())));
    const fonts: string[] = [];
    for (const u of lower.match(/fonts\.googleapis\.com\/css2?\?[^"'\\]+/g) ?? []) {
      for (const part of decodeURIComponent(u).split("&")) {
        const f = /family=([^:;@&]+)/.exec(part.trim());
        if (f)
          for (const fam of f[1].split("|")) {
            const name = fam.replace(/\+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
            if (name) fonts.push(name + "@google");
          }
      }
    }
    return { fonts: [...new Set(fonts)].slice(0, 6), tech: [...new Set(tech)].slice(0, 16) };
  } catch {
    return { fonts: [], tech: [] };
  }
}

/** Hosted fallback (no headless browser needed). `capped` keeps the response under proxy limits. */
export async function thumShot(url: string, capped: boolean): Promise<Shot> {
  const opts = capped ? "width/1100/crop/4500/fullpage" : "width/1440/fullpage";
  const res = await fetch(`https://image.thum.io/get/${opts}/${url}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`screenshot service ${res.status}`);
  const type = res.headers.get("content-type") ?? "image/png";
  return { bytes: new Uint8Array(await res.arrayBuffer()), type, engine: "thum.io" };
}

/** Thrown by captureVetted when the only capture obtainable is junk (loading/blank/blocked/
 *  error/cookie page). Callers turn this into a 422 so the user gets a clear message instead
 *  of a poisoned card silently entering the library. */
export class PoisonedCaptureError extends Error {
  kind: string;
  constructor(reason: string, kind: string) {
    super(reason);
    this.name = "PoisonedCaptureError";
    this.kind = kind;
  }
}

/** captureScreenshot + a quality gate: flat (loading/blank) shots try the thum.io renderer,
 *  then a vision pass rejects structured block/error/cookie pages. Returns a clean Shot or
 *  throws PoisonedCaptureError — so neither the in-app capture nor the extension clip can
 *  persist poison at the source (the audit route remains the backstop for older rows). */
export async function captureVetted(url: string, capped: boolean): Promise<Shot> {
  let shot = await captureScreenshot(url, capped);
  let stats = await flatStatsBytes(shot.bytes);
  if (looksFlat(stats) && shot.engine === "chromium") {
    // bot walls that block headless Chrome often wave thum.io's renderer through
    const alt = await thumShot(url, capped).catch(() => null);
    const altStats = alt ? await flatStatsBytes(alt.bytes) : null;
    if (alt && !looksFlat(altStats)) {
      alt.fonts = shot.fonts;
      alt.tech = shot.tech;
      shot = alt;
      stats = altStats;
    }
  }
  if (looksFlat(stats)) throw new PoisonedCaptureError("the page looks like a loading or blank screen", "loading");
  const rejected = await screenshotRejected(shot.bytes, shot.type);
  if (rejected) throw new PoisonedCaptureError(`looks like a ${rejected} page`, rejected);
  return shot;
}

/**
 * Extract actual post images from an Instagram embed page instead of screenshotting the UI.
 * For carousel posts, returns each slide as a separate image buffer.
 * Returns null if extraction fails (caller should fall back to a regular screenshot).
 */
export async function captureInstagram(shortcode: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string }[] | null> {
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
    await page.setUserAgent(UA);
    await page.goto(embedUrl, { waitUntil: "networkidle2", timeout: 30000 });
    // Wait for the embed's images to render
    await page.waitForSelector("img", { timeout: 8000 }).catch(() => {});

    // Extract all unique image URLs from the embed (carousel slides + main image)
    const imgUrls: string[] = await page.evaluate(() => {
      const urls = new Set<string>();
      document.querySelectorAll("img").forEach((img) => {
        const src = img.src || "";
        // Filter to actual content images (instagram CDN), skip avatars/icons/tiny images
        if (src.includes("cdn") && img.naturalWidth > 200 && img.naturalHeight > 200) {
          urls.add(src);
        }
      });
      return [...urls];
    });

    // For carousels: click through all slides to discover every image
    const nextBtn = await page.$("[aria-label='Next'], button[aria-label*='next' i], .coreSpriteRightChevron");
    if (nextBtn) {
      const seen = new Set(imgUrls);
      for (let i = 0; i < 10; i++) {
        try {
          await nextBtn.click();
          await new Promise((r) => setTimeout(r, 800));
          const newUrls = await page.evaluate(() => {
            const urls: string[] = [];
            document.querySelectorAll("img").forEach((img) => {
              if (img.src.includes("cdn") && img.naturalWidth > 200) urls.push(img.src);
            });
            return urls;
          });
          let added = false;
          for (const u of newUrls) {
            if (!seen.has(u)) { imgUrls.push(u); seen.add(u); added = true; }
          }
          if (!added) break; // looped back to start
        } catch { break; }
      }
    }

    await browser.close();
    browser = undefined;

    if (!imgUrls.length) return null;

    // Download all images
    const results: { bytes: Uint8Array<ArrayBuffer>; type: string }[] = [];
    for (const url of imgUrls) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": UA, "Referer": "https://www.instagram.com/" },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") ?? "image/jpeg";
        const buf = Buffer.from(await res.arrayBuffer());
        const out = await sharp(buf).jpeg({ quality: 88 }).toBuffer();
        results.push({
          bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) as Uint8Array<ArrayBuffer>,
          type: ct.startsWith("image/") ? "image/jpeg" : ct,
        });
      } catch { /* skip failed downloads */ }
    }

    return results.length ? results : null;
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function captureScreenshot(url: string, capped = false): Promise<Shot> {
  try {
    return await chromiumShot(url);
  } catch (e) {
    const carrier = e as { permanent?: boolean; fonts?: string[]; tech?: string[] };
    // Hard HTTP error page — thum.io would screenshot the very same 404, so don't fall back.
    if (carrier.permanent) throw e;
    const [shot, sniffed] = await Promise.all([
      thumShot(url, capped),
      carrier.fonts?.length && carrier.tech?.length
        ? Promise.resolve({ fonts: [], tech: [] })
        : staticSniff(url),
    ]);
    shot.fonts = carrier.fonts?.length ? carrier.fonts : sniffed.fonts;
    shot.tech = carrier.tech?.length ? carrier.tech : sniffed.tech;
    return shot;
  }
}
