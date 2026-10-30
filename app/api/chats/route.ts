import { NextResponse } from "next/server";
import { ensureChat, listChats } from "@/lib/asset-store";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ chats: listChats() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.id !== "string") return NextResponse.json({ error: "Chat ID is required." }, { status: 400 });
    return NextResponse.json({ id: ensureChat(body.id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create chat." }, { status: 500 });
  }
}
