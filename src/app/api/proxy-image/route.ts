import { isAuthed } from "../_lib/auth";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_BYTES = 20 * 1024 * 1024;

export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url).searchParams.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return Response.json({ error: "valid url required" }, { status: 400 });
  }
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "image/*,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return Response.json({ error: `upstream ${res.status}` }, { status: 502 });
    }
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return Response.json({ error: "image too large" }, { status: 413 });
    }
    return new Response(buf, {
      headers: { "content-type": type, "cache-control": "private, max-age=60" },
    });
  } catch {
    return Response.json({ error: "fetch failed" }, { status: 502 });
  }
}
