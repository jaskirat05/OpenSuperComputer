import { NextResponse } from "next/server";
import { getAssetCharacterProfiles, getAssetTags, listAssets, saveAsset, assetDataDir } from "@/lib/asset-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const chatId = new URL(request.url).searchParams.get("chatId") || undefined;
  return NextResponse.json({ assets: listAssets(chatId).map(({ scene_json, metadata_json, ...asset }) => ({ ...asset, hasScene: Boolean(scene_json), tags: getAssetTags(asset.id).tags, characters: getAssetCharacterProfiles(asset.id), url: `/api/assets/${asset.id}` })), dataDir: assetDataDir() });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const chatId = String(form.get("chatId") || "").trim();
    const file = form.get("file");
    if (!chatId) return NextResponse.json({ error: "Chat ID is required." }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "File is required." }, { status: 400 });
    if (file.size > 100 * 1024 * 1024) return NextResponse.json({ error: "Asset exceeds 100 MB." }, { status: 413 });
    let scene: unknown;
    const rawScene = form.get("scene");
    if (typeof rawScene === "string" && rawScene) scene = JSON.parse(rawScene);
    const asset = await saveAsset({ chatId, file, parentAssetId: String(form.get("parentAssetId") || "") || null, scene });
    const { scene_json, metadata_json, ...publicAsset } = asset;
    return NextResponse.json({ asset: { ...publicAsset, hasScene: Boolean(scene_json), tags: getAssetTags(asset.id).tags, characters: getAssetCharacterProfiles(asset.id), url: `/api/assets/${asset.id}` } }, { status: 201 });
  } catch (error) {
    console.error("Asset save failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save asset." }, { status: 500 });
  }
}
