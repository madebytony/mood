import fs from "fs";

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

async function launchBrowser() {
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

const LAZY_SCROLL = `(async () => {
  const step = window.innerHeight;
  const max = Math.min(document.body.scrollHeight, 12000);
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
const TECH_SNIFF = `(async () => {
  const t = new Set();
  const w = window;
  const html = document.documentElement;
  let resources = [];
  try { resources = performance.getEntriesByType("resource").map((r) => r.name); } catch {}
  const scriptSrcs = Array.from(document.scripts).map((s) => s.src).filter(Boolean);
  const scripts = [...scriptSrcs, ...resources].join("\\n").toLowerCase();
  const gen = (document.querySelector('meta[name="generator" i]')?.getAttribute("content") || "").toLowerCase();
  const has = (re) => re.test(scripts);

  // Bundle-content scan: fetch the site's biggest scripts and look for library signatures.
  let blob = "";
  try {
    const candidates = scriptSrcs
      .filter((s) => !/gtag|googletag|analytics|fbevents|hotjar|clarity|cookie|consent|recaptcha|stripe/i.test(s))
      .slice(0, 6);
    const texts = await Promise.race([
      Promise.allSettled(candidates.map(async (s) => (await fetch(s)).text())),
      new Promise((r) => setTimeout(() => r([]), 4500)),
    ]);
    for (const r of texts) if (r.status === "fulfilled") blob += r.value.slice(0, 700000).toLowerCase();
  } catch {}
  // inline scripts too
  for (const s of document.scripts) if (!s.src && s.textContent) blob += s.textContent.slice(0, 200000).toLowerCase();
  const inBundle = (re) => re.test(blob);

  // app frameworks
  if (w.__NEXT_DATA__ || document.getElementById("__next")) t.add("Next.js");
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

  // styling heuristic
  let cls = "";
  let n = 0;
  for (const e of document.querySelectorAll("body [class]")) {
    if (++n > 300) break;
    if (typeof e.className === "string") cls += " " + e.className;
  }
  if (/(^|\\s)(sm:|md:|lg:|xl:)[a-z-]/.test(cls)) t.add("Tailwind CSS");

  return Array.from(t).slice(0, 16);
})()`;

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
  bytes: ArrayBuffer;
  type: string;
  engine: "chromium" | "thum.io";
  fonts?: string[];
  tech?: string[];
}

export async function chromiumShot(url: string): Promise<Shot> {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    await page.setUserAgent(UA);
    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 35000 }).catch(() => null);
    await page.evaluate(LAZY_SCROLL).catch(() => {});
    await page.evaluate(CLEAN_PAGE).catch(() => {});
    const fonts = (await page.evaluate(FONT_SNIFF).catch(() => [])) as string[];
    const pageTech = (await page.evaluate(TECH_SNIFF).catch(() => [])) as string[];
    const tech = [...new Set([...pageTech, ...hostingFrom(resp?.headers() ?? {})])];
    await new Promise((r) => setTimeout(r, 350));
    const height = Math.min(
      await page.evaluate("document.body.scrollHeight").then((h) => Number(h) || 960),
      6000
    );
    const buf = await page.screenshot({
      type: "jpeg",
      quality: 82,
      clip: { x: 0, y: 0, width: 1440, height },
    });
    await browser.close();
    return { bytes: Buffer.from(buf).buffer as ArrayBuffer, type: "image/jpeg", engine: "chromium", fonts, tech };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

/** Hosted fallback (no headless browser needed). `capped` keeps the response under proxy limits. */
async function thumShot(url: string, capped: boolean): Promise<Shot> {
  const opts = capped ? "width/1100/crop/4500/fullpage" : "width/1440/fullpage";
  const res = await fetch(`https://image.thum.io/get/${opts}/${url}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`screenshot service ${res.status}`);
  const type = res.headers.get("content-type") ?? "image/png";
  return { bytes: await res.arrayBuffer(), type, engine: "thum.io" };
}

export async function captureScreenshot(url: string, capped = false): Promise<Shot> {
  try {
    return await chromiumShot(url);
  } catch {
    return await thumShot(url, capped);
  }
}
