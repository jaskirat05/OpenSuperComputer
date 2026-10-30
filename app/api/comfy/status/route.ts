import { NextResponse } from "next/server";
import { comfyServiceRequest } from "@/lib/comfy-service";

export const runtime = "nodejs";

export async function GET() {
  const { response, data } = await comfyServiceRequest("/v1/comfy/status");
  return NextResponse.json(data, { status: response?.status || 502 });
}
