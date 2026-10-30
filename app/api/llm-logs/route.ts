import { NextResponse } from "next/server";
import { clearLLMRequestLogs, listLLMRequestLogs } from "@/lib/asset-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const chatId = new URL(request.url).searchParams.get("chatId") || undefined;
  const logs = listLLMRequestLogs(chatId).map((entry) => ({
    ...entry,
    request: JSON.parse(entry.request_json),
    response: entry.response_json ? JSON.parse(entry.response_json) : null,
    usage: entry.usage_json ? JSON.parse(entry.usage_json) : null,
    request_json: undefined,
    response_json: undefined,
    usage_json: undefined,
  }));
  return NextResponse.json({ logs });
}

export async function DELETE(request: Request) {
  const chatId = new URL(request.url).searchParams.get("chatId") || undefined;
  return NextResponse.json({ deleted: clearLLMRequestLogs(chatId) });
}
