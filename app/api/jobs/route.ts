import { NextResponse } from "next/server";
export const runtime = "nodejs";

const allowedPipelines = new Set(["analyze-shot", "color-grade", "remove-background", "upscale", "composite"]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { pipeline?: string; prompt?: string; inputFiles?: string[] } | null;
  if (!body?.pipeline || !allowedPipelines.has(body.pipeline) || !body.prompt) return NextResponse.json({ error: "Invalid pipeline request." }, { status: 400 });
  const endpoint = process.env.VFX_EXECUTION_URL;
  const token = process.env.VFX_EXECUTION_TOKEN;
  if (!endpoint) return NextResponse.json({ error: "No remote execution service is configured. Set VFX_EXECUTION_URL to your job API." }, { status: 503 });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ pipeline: body.pipeline, prompt: body.prompt, inputFiles: body.inputFiles || [] }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => ({})) as { jobId?: string; status?: string; artifacts?: { name: string; type: string; url?: string }[]; logs?: string[]; message?: string };
    if (!response.ok) return NextResponse.json({ error: result.message || `Execution service returned ${response.status}.`, logs: result.logs || [] }, { status: 502 });
    return NextResponse.json({ jobId: result.jobId, status: result.status || "queued", artifacts: result.artifacts || [], logs: result.logs || [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to contact execution service.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
