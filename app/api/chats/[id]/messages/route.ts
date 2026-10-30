import { NextResponse } from "next/server";
import { deleteChatMessages, loadChatHistory, saveChatMessage, type StoredChatMessage } from "@/lib/asset-store";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  return NextResponse.json(loadChatHistory(id));
}

export async function POST(request: Request, context: Context) {
  return save(request, context);
}

export async function PUT(request: Request, context: Context) {
  return save(request, context);
}

async function save(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const item = await request.json() as StoredChatMessage;
    saveChatMessage(id, item);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save chat history." }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    deleteChatMessages(id, body.items || []);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update chat history." }, { status: 400 });
  }
}
