import { NextResponse } from "next/server";
import { getImportedComfyOutput, recordImportedComfyOutput, saveAsset } from "@/lib/asset-store";

export const runtime = "nodejs";
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const chatId = typeof body.chatId === "string" ? body.chatId.trim().slice(0, 120) : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    if (!chatId || !runId || runId.length > 120) return NextResponse.json({ error: "Chat ID and run ID are required." }, { status: 400 });

    const base = (process.env.COMFY_SERVICE_URL || "http://127.0.0.1:8012").replace(/\/$/, "");
    const token = process.env.COMFY_SERVICE_TOKEN?.trim();
    const headers = token ? { "X-Service-Token": token } : undefined;
    const runResponse = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}`, { headers });
    if (!runResponse.ok) return NextResponse.json({ error: runResponse.status === 404 ? "ComfyUI run not found." : `Could not read ComfyUI run (${runResponse.status}).` }, { status: runResponse.status === 404 ? 404 : 502 });
    const responseBody = await runResponse.json() as { run?: { id?: string; status?: string; outputs?: Array<{ name?: string; content_type?: string; size_bytes?: number }> } };
    const run = responseBody.run;
    if (!run || run.status !== "completed" || !Array.isArray(run.outputs)) return NextResponse.json({ error: `This run is ${run?.status || "unavailable"}; only completed runs have importable outputs.` }, { status: 409 });

    const assets = [];
    for (const output of run.outputs) {
      const name = output.name;
      if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") continue;
      const existing = getImportedComfyOutput(chatId, run.id || runId, name);
      if (existing) {
        assets.push({ id: existing.id, original_name: existing.original_name, mime_type: existing.mime_type, size: existing.size, url: `/api/assets/${existing.id}` });
        continue;
      }
      if (typeof output.size_bytes === "number" && output.size_bytes > MAX_OUTPUT_BYTES) throw new Error(`Output ${name} exceeds the 100 MB import limit.`);
      const fileResponse = await fetch(`${base}/v1/runs/${encodeURIComponent(run.id || runId)}/outputs/${encodeURIComponent(name)}`, { headers });
      if (!fileResponse.ok) throw new Error(`Could not fetch ComfyUI output ${name} (${fileResponse.status}).`);
      const bytes = await fileResponse.arrayBuffer();
      if (bytes.byteLength > MAX_OUTPUT_BYTES) throw new Error(`Output ${name} exceeds the 100 MB import limit.`);
      const file = new File([bytes], name, { type: output.content_type || fileResponse.headers.get("content-type") || "application/octet-stream" });
      const asset = await saveAsset({ chatId, file });
      recordImportedComfyOutput(chatId, run.id || runId, name, asset.id);
      assets.push({ id: asset.id, original_name: asset.original_name, mime_type: asset.mime_type, size: asset.size, url: `/api/assets/${asset.id}` });
    }
    return NextResponse.json({ runId: run.id || runId, assets });
  } catch (error) {
    console.error("ComfyUI output import failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not import ComfyUI outputs." }, { status: 502 });
  }
}
