import { NextResponse } from "next/server";
import { getProviderSettings, saveProviderSettings } from "@/lib/provider-settings";

export const runtime = "nodejs";

export async function GET() {
  const settings = await getProviderSettings();
  return NextResponse.json({ baseURL: settings.baseURL, model: settings.model, keyConfigured: Boolean(settings.apiKey) });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const baseURL = typeof body.baseURL === "string" ? body.baseURL.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    const clearApiKey = body.clearApiKey === true;
    if (!baseURL || !model) return NextResponse.json({ error: "Base URL and model ID are required." }, { status: 400 });
    const parsed = new URL(baseURL);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) return NextResponse.json({ error: "Base URL must use HTTPS, except for localhost providers." }, { status: 400 });
    await saveProviderSettings({ baseURL, model, ...(apiKey !== undefined ? { apiKey } : {}), clearApiKey });
    const settings = await getProviderSettings();
    return NextResponse.json({ baseURL: settings.baseURL, model: settings.model, keyConfigured: Boolean(settings.apiKey) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save model settings." }, { status: 400 });
  }
}
