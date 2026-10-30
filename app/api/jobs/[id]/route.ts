import { NextResponse } from "next/server";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const endpoint = process.env.VFX_EXECUTION_URL;
  const token = process.env.VFX_EXECUTION_TOKEN;
  if (!endpoint) return NextResponse.json({ error: "No remote execution service is configured." }, { status: 503 });
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/${encodeURIComponent(id)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store", signal: AbortSignal.timeout(15000) });
    const result = await response.json().catch(() => ({}));
    return NextResponse.json(result, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to contact execution service." }, { status: 502 });
  }
}
