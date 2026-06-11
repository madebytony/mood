import { isIP } from "net";
import { lookup } from "dns/promises";

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
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("dns resolution failed"); // unreachable name, not a block — surface as a normal failure
  }
  if (!addrs.length || addrs.some((a) => blockedIp(a.address))) throw new Error("blocked: address");
  return u;
}

/**
 * fetch() that validates the target — and every redirect hop — with assertPublicUrl,
 * so a public URL can't 30x-bounce into a private address. Caps redirects (default 4).
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { maxRedirects?: number } = {}
): Promise<Response> {
  const { maxRedirects = 4, ...rest } = init;
  let target = (await assertPublicUrl(raw)).href;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...rest, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    if (hop >= maxRedirects) throw new Error("blocked: too many redirects");
    target = (await assertPublicUrl(new URL(loc, target).href)).href;
  }
}
