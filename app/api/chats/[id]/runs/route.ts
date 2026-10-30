import { NextResponse } from "next/server";
import { listPinnedComfyRuns, unpinComfyRun } from "@/lib/asset-store";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: chatId } = await params;
  const pinned = listPinnedComfyRuns(chatId);
  const base = (process.env.COMFY_SERVICE_URL || "http://127.0.0.1:8012").replace(/\/$/, "");
  const token = process.env.COMFY_SERVICE_TOKEN?.trim();
  const runs = await Promise.all(pinned.map(async (entry) => {
    try {
      const response = await fetch(`${base}/v1/runs/${encodeURIComponent(entry.run_id)}`, {
        headers: token ? { "X-Service-Token": token } : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { ...entry, status: "unavailable", progress: 0, message: response.status === 404 ? "Run no longer exists in ComfyUI." : "Could not read ComfyUI status." };
      const data = await response.json();
      const run = data?.run && typeof data.run === "object" ? data.run : data;
      return { ...entry, ...run, id: entry.run_id };
    } catch {
      return { ...entry, id: entry.run_id, status: "unavailable", progress: 0, message: "ComfyUI status is unavailable." };
    }
  }));
  return NextResponse.json({ runs });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: chatId } = await params;
  const body = await request.json().catch(() => ({}));
  const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
  if (!runId || runId.length > 120) return NextResponse.json({ error: "A valid run_id is required." }, { status: 400 });
  return NextResponse.json({ removed: unpinComfyRun(chatId, runId) });
}
