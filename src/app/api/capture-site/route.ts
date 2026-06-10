import { isAuthed } from "../_lib/auth";
import { captureScreenshot } from "../_lib/capture";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url).searchParams.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return Response.json({ error: "valid url required" }, { status: 400 });
  }
  try {
    // capped: this response travels back through Vercel's proxy (~4.5MB limit)
    const shot = await captureScreenshot(url, true);
    return new Response(shot.bytes, {
      headers: {
        "content-type": shot.type,
        "cache-control": "no-store",
        "x-capture-engine": shot.engine,
      },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
