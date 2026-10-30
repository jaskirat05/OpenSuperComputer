import { NextResponse } from "next/server";
import { getAsset, getAssetCharacterProfiles, getAssetTags, getScene, linkAssetToChat, readAsset, saveScene } from "@/lib/asset-store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const asset = getAsset(id);
  if (!asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  if (new URL(_request.url).searchParams.get("metadata") === "1") {
    const { scene_json, metadata_json, ...publicAsset } = asset;
    return NextResponse.json({ asset: { ...publicAsset, hasScene: Boolean(scene_json), scene: getScene(id), tags: getAssetTags(id).tags, characters: getAssetCharacterProfiles(id) } });
  }
  try {
    const bytes = await readAsset(asset);
    return new Response(bytes, { headers: { "Content-Type": asset.mime_type, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, max-age=3600", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.original_name)}` } });
  } catch {
    return NextResponse.json({ error: "Asset file is missing from local storage." }, { status: 410 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getAsset(id)) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  try {
    const body = await request.json();
    if (!body.scene || typeof body.scene !== "object") return NextResponse.json({ error: "Scene is required." }, { status: 400 });
    saveScene(id, body.scene);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save design scene." }, { status: 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getAsset(id)) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  try {
    const body = await request.json();
    const chatId = typeof body.chatId === "string" ? body.chatId.trim().slice(0, 120) : "";
    if (!chatId) return NextResponse.json({ error: "Chat ID is required." }, { status: 400 });
    linkAssetToChat(id, chatId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not link asset to chat." }, { status: 400 });
  }
}
