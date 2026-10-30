import { NextResponse } from "next/server";
import { comfyServiceRequest } from "@/lib/comfy-service";

export const runtime = "nodejs";

export async function GET() {
  const { response, data } = await comfyServiceRequest("/v1/comfy/instance");
  return NextResponse.json(data, { status: response?.status || 502 });
}

export async function PUT(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ detail: "Request body must be valid JSON." }, { status: 400 }); }
  const { response, data } = await comfyServiceRequest("/v1/comfy/instance", { method: "PUT", body: JSON.stringify(body) });
  return NextResponse.json(data, { status: response?.status || 502 });
}

export async function DELETE() {
  const { response, data } = await comfyServiceRequest("/v1/comfy/instance", { method: "DELETE" });
  return NextResponse.json(data, { status: response?.status || 502 });
}
