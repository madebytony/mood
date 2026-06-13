import { isAuthed } from "../_lib/auth";
import { safeFetch } from "../_lib/ssrf";
import { clientIp, rateLimit, tooManyRequests } from "../_lib/ratelimit";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function pick(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function metaTag(prop: string): RegExp[] {
  return [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
  ];
}

/** Extract image URL from Instagram's embed HTML (the only public endpoint that
 *  serves post images without auth). Tries /embed/captioned/ and /embed/ variants. */
async function instagramEmbedImage(postUrl: string): Promise<string | null> {
  const m = postUrl.match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const embedUrl = `https://www.instagram.com/p/${m[1]}/embed/captioned/`;
  try {
    const res = await safeFetch(embedUrl, {
      headers: { "user-agent": UA, accept: "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(12000),
    });
    const html = (await res.text()).slice(0, 600_000);
    // Instagram embeds the image in <img class="EmbeddedMediaImage" src="...">
    const imgTag = /<img[^>]+class="[^"]*EmbeddedMediaImage[^"]*"[^>]+src="([^"]+)"/i.exec(html)
      ?? /<img[^>]+src="(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]*)"[^>]+>/i.exec(html);
    if (imgTag?.[1]) return decodeEntities(imgTag[1]);
    // Fallback: image URL in the JSON blob Instagram embeds in script tags
    const jsonBlob = /"display_url":"(https:[^"]+)"/i.exec(html);
    if (jsonBlob?.[1]) return jsonBlob[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  } catch { /* blocked or timeout */ }
  return null;
}

export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = rateLimit(`meta:${clientIp(req)}`, 100, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);
  const url = new URL(req.url).searchParams.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return Response.json({ error: "valid url required" }, { status: 400 });
  }
  try {
    const res = await safeFetch(url, {
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(10000),
    });
    const html = (await res.text()).slice(0, 400_000);
    const base = new URL(res.url || url);

    let image =
      pick(html, metaTag("og:image")) ??
      pick(html, metaTag("og:image:url")) ??
      pick(html, metaTag("twitter:image"));
    if (image) {
      try {
        image = new URL(image, base).href;
      } catch {
        image = null;
      }
    }

    // Instagram blocks server-side og:image — fall back to scraping the embed page
    if (!image && /instagram\.com\/(p|reel)\//.test(url)) {
      image = await instagramEmbedImage(url);
    }

    const title =
      pick(html, metaTag("og:title")) ??
      pick(html, [/<title[^>]*>([^<]+)<\/title>/i]);
    const description =
      pick(html, metaTag("og:description")) ?? pick(html, metaTag("description"));

    return Response.json({
      title,
      description,
      image,
      domain: base.hostname.replace(/^www\./, ""),
    });
  } catch (e) {
    if ((e as Error).message?.startsWith("blocked")) {
      return Response.json({ error: "url not allowed" }, { status: 400 });
    }
    return Response.json(
      { title: null, description: null, image: null, domain: new URL(url).hostname.replace(/^www\./, "") },
      { status: 200 }
    );
  }
}
