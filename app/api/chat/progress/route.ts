import { NextResponse } from "next/server";
import { getChatProgress } from "@/lib/chat-progress";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = new URL(request.url).searchParams.get("requestId") || "";
  const progress = getChatProgress(requestId);
  return NextResponse.json({ text: progress?.text || null, activity: progress?.activity || null, checkpoints: progress?.checkpoints || [] });
}
