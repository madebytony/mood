import { isIP } from "net";
import { lookup as dnsLookup } from "dns";
import { lookup as lookupAsync } from "dns/promises";
import http from "http";
import https from "https";
import zlib from "zlib";

/** Hostnames that should never be fetched server-side, regardless of DNS. */
const PRIVATE_HOSTS = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

function blockedV4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local — incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved (224–255)
  return false;
}

function blockedV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; // loopback, unspecified
  if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(v)) return true; // unique-local fc00::/7
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v); // IPv4-mapped ::ffff:a.b.c.d
  if (mapped) return blockedV4(mapped[1]);
  return false;
}

function blockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blockedV4(ip);
  if (kind === 6) return blockedV6(ip);
  return true; // unrecognisable → refuse
}

/**
 * Reject anything that isn't a public http(s) URL safe to fetch from the server.
 * Resolves the hostname and refuses if *any* address is loopback/private/link-local,
 * which blocks the obvious SSRF targets (localhost services, cloud metadata, LAN).
 * Throws `Error("blocked: …")` on refusal; returns the parsed URL otherwise.
 *
 * NOTE: this is a *pre-flight* check. The authoritative guard is `pinnedLookup`, which
 * re-validates and pins the IP at connect time (see `safeFetch`) so a TTL-0 record can't
 * rebind to a private address between this check and the actual socket connection.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("blocked: invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("blocked: protocol");
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (PRIVATE_HOSTS.test(host)) throw new Error("blocked: host");

  if (isIP(host)) {
    if (blockedIp(host)) throw new Error("blocked: address");
    return u;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookupAsync(host, { all: true });
  } catch {
    throw new Error("dns resolution failed"); // unreachable name, not a block — surface as a normal failure
  }
  if (!addrs.length || addrs.some((a) => blockedIp(a.address))) throw new Error("blocked: address");
  return u;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number
) => void;

/**
 * DNS lookup that validates every resolved address and hands the socket the *exact* IPs it
 * checked. Because resolution and validation happen in the same call that feeds connect(),
 * there is no window for a rebinding record to swap in a private IP (closes the classic
 * validate-then-fetch TOCTOU). Refuses the connection if any resolved address is private.
 */
function pinnedLookup(hostname: string, options: unknown, callback: LookupCb): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as { address: string; family: number }[];
    if (!list.length || list.some((a) => blockedIp(a.address))) {
      return callback(new Error("blocked: address") as NodeJS.ErrnoException, "", 0);
    }
    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      return callback(null, list);
    }
    callback(null, list[0].address, list[0].family);
  });
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export type SafeInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  /** Hard cap on the response body; the connection is torn down once exceeded. */
  maxBytes?: number;
  /** Following is always done by `safeFetch` with per-hop validation; this is ignored. */
  redirect?: RequestRedirect;
  maxRedirects?: number;
};

/** Single hop over node:http(s) with a connection pinned to a validated IP. No redirect following. */
function rawRequest(target: string, init: SafeInit): Promise<Response> {
  const u = new URL(target);
  const mod = u.protocol === "https:" ? https : http;
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method: init.method ?? "GET",
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: init.headers,
        lookup: pinnedLookup,
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          try {
            if (enc === "gzip" || enc === "x-gzip") buf = zlib.gunzipSync(buf);
            else if (enc === "deflate") buf = zlib.inflateSync(buf);
            else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
          } catch {
            /* couldn't decode — serve the raw bytes */
          }
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue;
            // these no longer match after decompression / are hop-specific
            if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding") continue;
            headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
          }
          const out = new Response(new Uint8Array(buf), {
            status: res.statusCode ?? 502,
            headers,
          });
          // Response.url is otherwise "" for a hand-built Response; consumers resolve relative
          // URLs against it (e.g. og:image), so expose the hop's final URL.
          Object.defineProperty(out, "url", { value: target });
          resolve(out);
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

/**
 * fetch()-shaped helper that validates the target — and every redirect hop — and pins each
 * connection to a validated IP via `pinnedLookup`, so a public URL can neither 30x-bounce nor
 * DNS-rebind into a private address. Caps redirects (default 4) and body size (default 25 MB).
 */
export async function safeFetch(raw: string, init: SafeInit = {}): Promise<Response> {
  const { maxRedirects = 4, redirect: _ignored, ...rest } = init;
  let target = (await assertPublicUrl(raw)).href;
  for (let hop = 0; ; hop++) {
    const res = await rawRequest(target, rest);
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    if (hop >= maxRedirects) throw new Error("blocked: too many redirects");
    target = (await assertPublicUrl(new URL(loc, target).href)).href;
  }
}
