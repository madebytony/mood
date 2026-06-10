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
  return ranked.slice(0, 6);
})()`;

export interface Shot {
  bytes: ArrayBuffer;
  type: string;
  engine: "chromium" | "thum.io";
  fonts?: string[];
}

export async function chromiumShot(url: string): Promise<Shot> {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 35000 }).catch(() => {});
    await page.evaluate(LAZY_SCROLL).catch(() => {});
    await page.evaluate(CLEAN_PAGE).catch(() => {});
    const fonts = (await page.evaluate(FONT_SNIFF).catch(() => [])) as string[];
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
    return { bytes: Buffer.from(buf).buffer as ArrayBuffer, type: "image/jpeg", engine: "chromium", fonts };
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
