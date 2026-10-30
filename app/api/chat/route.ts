import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp, { type OverlayOptions } from "sharp";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type Tool, type ToolSet } from "ai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getAssetCharacterProfiles, getAssetTags, getChatAsset, getImportedComfyOutput, getScene, listAssets, pinComfyRun, readAsset, recordImportedComfyOutput, saveAsset, saveAssetTags, saveLLMRequestLog } from "@/lib/asset-store";
import { getChatProgress, publishChatCheckpoint, setChatActivity, setChatProgress } from "@/lib/chat-progress";
import { getProviderSettings } from "@/lib/provider-settings";

export const runtime = "nodejs";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const imageMime = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const allowedMime = /^(image\/|video\/|audio\/|application\/pdf|text\/|application\/json|application\/zip)/;
const allowedExtension = /\.(exr|dpx|cin|tif|tiff|mov|mxf)$/i;
const MAX_LLM_ROUNDS = 100;
const exposedMcpTools = new Set(["search_workflows", "get_workflow", "get_comfy_status", "run_workflow", "get_run_status", "wait_for_run", "list_recent_runs", "import_run_outputs", "cancel_run"]);
const execFileAsync = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

function redactLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.startsWith("data:")) {
      const match = value.match(/^data:([^;,]+)[^,]*,([\s\S]*)$/);
      if (match) return `[media payload omitted: ${match[1]}, approximately ${Math.ceil(match[2].length * 0.75)} bytes]`;
    }
    return value;
  }
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, key === "apiKey" || key === "authorization" ? "[redacted]" : redactLogValue(item)]));
}

function writeExchangeLog(input: { chatId: string; round: number; model: string; baseURL: string; status: string; duration: number; request: unknown; response?: unknown; usage?: unknown; error?: unknown }) {
  try {
    saveLLMRequestLog({ chat_id: input.chatId, round: input.round, model: input.model, base_url: input.baseURL, status: input.status,
      duration_ms: input.duration, request_json: JSON.stringify(redactLogValue(input.request)),
      response_json: input.response === undefined ? null : JSON.stringify(redactLogValue(input.response)),
      usage_json: input.usage === undefined ? null : JSON.stringify(input.usage),
      error: input.error === undefined ? null : String(input.error).slice(0, 2000) });
  } catch (error) { console.warn("Could not write local LLM request log.", error); }
}

function terminalRunStatus(value: unknown): "failed" | "cancelled" | "interrupted" | undefined {
  const visit = (candidate: unknown, depth: number): "failed" | "cancelled" | "interrupted" | undefined => {
    if (depth > 8) return undefined;
    if (typeof candidate === "string") {
      try { return visit(JSON.parse(candidate), depth + 1); } catch { return undefined; }
    }
    if (!candidate || typeof candidate !== "object") return undefined;
    const record = candidate as Record<string, unknown>;
    if (typeof record.status === "string" && ["failed", "cancelled", "interrupted"].includes(record.status.toLowerCase())) {
      return record.status.toLowerCase() as "failed" | "cancelled" | "interrupted";
    }
    for (const nested of Object.values(record)) {
      const found = visit(nested, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value, 0);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function parseDsmlToolCalls(text: string): Array<{ name: string; input: Record<string, unknown> }> {
  const normalized = text.replace(/\\(?=<\/?｜)/g, "");
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const invocationPattern = /<｜{2}DSML｜{2}\s*invoke\b([^>]*)>([\s\S]*?)<\/｜{2}DSML｜{2}\s*invoke\s*>/g;
  for (const match of normalized.matchAll(invocationPattern)) {
    const name = match[1].match(/\bname\s*=\s*["']([^"']+)["']/)?.[1];
    if (!name) continue;
    const input: Record<string, unknown> = {};
    const parameterPattern = /<｜{2}DSML｜{2}\s*parameter\b([^>]*)>([\s\S]*?)<\/｜{2}DSML｜{2}\s*parameter\s*>/g;
    for (const parameter of match[2].matchAll(parameterPattern)) {
      const key = parameter[1].match(/\bname\s*=\s*["']([^"']+)["']/)?.[1];
      if (!key) continue;
      const value = parameter[2].trim();
      const isString = /\bstring\s*=\s*["']true["']/.test(parameter[1]);
      if (isString) input[key] = value;
      else {
        try { input[key] = JSON.parse(value); } catch { input[key] = value; }
      }
    }
    calls.push({ name, input });
  }
  return calls;
}

function formatRecentRuns(value: unknown): string {
  const record = value && typeof value === "object" ? value as { runs?: unknown } : {};
  const runs = Array.isArray(record.runs) ? record.runs as Array<Record<string, unknown>> : [];
  if (!runs.length) return "There are no recent ComfyUI runs.";
  return `Recent ComfyUI runs:\n${runs.slice(0, 12).map((run) => {
    const outputs = Array.isArray(run.outputs) ? run.outputs.map((output) => output && typeof output === "object" ? String((output as Record<string, unknown>).name || "output") : "output").join(", ") : "no outputs yet";
    return `• ${String(run.workflow_id || "Workflow")} · ${String(run.status || "unknown")} · run ID ${String(run.id || "unknown")} · ${outputs}`;
  }).join("\n")}`;
}

function unwrapMcpResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return parseJsonValue(value);
  const result = value as { structuredContent?: { result?: unknown }; content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const candidate = result.structuredContent?.result ?? result.content?.find((item) => item.type === "text")?.text;
  const parsed = parseJsonValue(candidate);
  return result.isError ? { error: parsed } : parsed;
}

function findRunRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 10) return null;
  const candidate = parseJsonValue(value);
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.status === "string" && Array.isArray(record.outputs)) return record;
  for (const nested of Object.values(record)) {
    const found = findRunRecord(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

async function importCompletedRunOutputs(runValue: unknown, chatId: string, importedByRun: Map<string, Array<Record<string, unknown>>>) {
  const run = findRunRecord(runValue);
  if (!run || !["completed", "succeeded", "success", "done"].includes(String(run.status).toLowerCase()) || typeof run.id !== "string" || !Array.isArray(run.outputs)) return [];
  if (importedByRun.has(run.id)) return importedByRun.get(run.id)!;
  const base = (process.env.COMFY_SERVICE_URL || "http://127.0.0.1:8012").replace(/\/$/, "");
  const token = process.env.COMFY_SERVICE_TOKEN?.trim();
  const assets: Array<Record<string, unknown>> = [];
  for (const output of run.outputs) {
    if (!output || typeof output !== "object") continue;
    const item = output as { name?: unknown; content_type?: unknown };
    if (typeof item.name !== "string" || !item.name || item.name.includes("/") || item.name.includes("\\")) continue;
    const existing = getImportedComfyOutput(chatId, run.id, item.name);
    if (existing) {
      assets.push({ id: existing.id, original_name: existing.original_name, mime_type: existing.mime_type, size: existing.size, url: `/api/assets/${existing.id}` });
      continue;
    }
    const response = await fetch(`${base}/v1/runs/${encodeURIComponent(run.id)}/outputs/${encodeURIComponent(item.name)}`, { headers: token ? { "X-Service-Token": token } : undefined });
    if (!response.ok) throw new Error(`Could not import ComfyUI output ${item.name} (${response.status}).`);
    const bytes = await response.arrayBuffer();
    const contentType = typeof item.content_type === "string" ? item.content_type : response.headers.get("content-type") || "application/octet-stream";
    const file = new File([bytes], item.name, { type: contentType });
    const asset = await saveAsset({ chatId, file });
    recordImportedComfyOutput(chatId, run.id, item.name, asset.id);
    assets.push({ id: asset.id, original_name: asset.original_name, mime_type: asset.mime_type, size: asset.size, url: `/api/assets/${asset.id}` });
  }
  importedByRun.set(run.id, assets);
  return assets;
}

const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveChatAsset(reference: string, refs: { mention: string; id: string }[], chatId: string) {
  const ref = reference.startsWith("@") ? refs.find((item) => item.mention === reference) : assetIdPattern.test(reference) ? { id: reference } : undefined;
  return ref ? getChatAsset(chatId, ref.id) : undefined;
}

async function uploadReferencedAsset(reference: string, refs: { mention: string; id: string }[], chatId: string) {
  const asset = resolveChatAsset(reference, refs, chatId);
  if (!asset) throw new Error(`The referenced media ${reference} is unavailable in this chat's library. Use an available @mention or local asset ID.`);
  const form = new FormData();
  const blob = new Blob([await readAsset(asset)], { type: asset.mime_type || "application/octet-stream" });
  form.append("file", blob, asset.original_name);
  const base = (process.env.COMFY_SERVICE_URL || "http://127.0.0.1:8012").replace(/\/$/, "");
  const token = process.env.COMFY_SERVICE_TOKEN?.trim();
  const response = await fetch(`${base}/v1/assets`, { method: "POST", headers: token ? { "X-Service-Token": token } : undefined, body: form });
  if (!response.ok) throw new Error(`Could not upload ${reference} to the Comfy service (${response.status}).`);
  return (await response.json()) as { id: string };
}

async function inspectMentionedAsset(reference: string, refs: { mention: string; id: string }[], chatId: string) {
  const asset = resolveChatAsset(reference, refs, chatId);
  if (!asset) throw new Error(`The referenced media ${reference} is unavailable in this chat's library.`);
  const bytes = await readAsset(asset);
  const maxDimension = 2048;
  if (asset.mime_type.startsWith("image/")) {
    const image = await sharp(bytes, { limitInputPixels: 100_000_000 }).rotate().resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return [{ type: "text" as const, text: `Visual inspection of ${reference} (${asset.original_name}, local asset ID ${asset.id}).` }, { type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}`, detail: "high" as const } }];
  }
  if (asset.mime_type.startsWith("video/")) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vfxguru-video-inspect-"));
    try {
      const input = path.join(tempDir, `input${path.extname(asset.original_name) || ".video"}`);
      await (await import("node:fs/promises")).writeFile(input, bytes);
      const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not read the video duration.");
      const frameCount = Math.min(9, Math.max(3, Math.ceil(duration / 5)));
      const times = Array.from({ length: frameCount }, (_, index) => duration * (index + 0.5) / frameCount);
      const frames: Buffer[] = [];
      for (let index = 0; index < times.length; index++) {
        const framePath = path.join(tempDir, `frame-${index}.jpg`);
        await execFileAsync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", times[index].toFixed(3), "-i", input, "-frames:v", "1", "-vf", "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=black", "-q:v", "4", framePath], { timeout: 30_000, maxBuffer: 1024 * 1024 });
        frames.push(await readFile(framePath));
      }
      const cellWidth = 480;
      const cellHeight = 300;
      const columns = Math.min(3, frames.length);
      const rows = Math.ceil(frames.length / columns);
      const composites: OverlayOptions[] = [];
      for (let index = 0; index < frames.length; index++) {
        const label = Buffer.from(`<svg width="480" height="30"><rect width="100%" height="100%" fill="#111827"/><text x="12" y="21" fill="white" font-size="16" font-family="Arial">${times[index].toFixed(2)}s</text></svg>`);
        composites.push({ input: frames[index], left: (index % columns) * cellWidth, top: Math.floor(index / columns) * cellHeight });
        composites.push({ input: label, left: (index % columns) * cellWidth, top: Math.floor(index / columns) * cellHeight + 270 });
      }
      const sheet = await sharp({ create: { width: columns * cellWidth, height: rows * cellHeight, channels: 3, background: "#111827" } }).composite(composites).jpeg({ quality: 82 }).toBuffer();
      return [{ type: "text" as const, text: `Video contact sheet for ${reference} (${asset.original_name}, local asset ID ${asset.id}), duration ${duration.toFixed(2)} seconds. Frames are sampled evenly across the clip; each tile is labeled with its source timestamp. Describe motion/order cautiously because only ${frames.length} samples are shown.` }, { type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${sheet.toString("base64")}`, detail: "high" as const } }];
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  throw new Error(`${reference} is ${asset.mime_type}; visual inspection supports image and video assets.`);
}

async function extractMentionedVideoFrame(reference: string, frameNumber: number, refs: { mention: string; id: string }[], chatId: string) {
  const asset = resolveChatAsset(reference, refs, chatId);
  if (!asset) throw new Error(`The referenced media ${reference} is unavailable in this chat's library.`);
  if (!asset.mime_type.startsWith("video/")) throw new Error(`${reference} is ${asset.mime_type}; frame extraction requires a video.`);
  if (!Number.isInteger(frameNumber) || frameNumber < 1 || frameNumber > 250_000) throw new Error("Frame number must be an integer from 1 to 250000. Frame numbering starts at 1.");

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vfxguru-video-frame-"));
  try {
    const input = path.join(tempDir, `input${path.extname(asset.original_name) || ".video"}`);
    const output = path.join(tempDir, "frame.jpg");
    await (await import("node:fs/promises")).writeFile(input, await readAsset(asset));
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json", input], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const probe = JSON.parse(stdout) as { streams?: Array<{ avg_frame_rate?: string; r_frame_rate?: string }> };
    const rate = probe.streams?.[0]?.avg_frame_rate || probe.streams?.[0]?.r_frame_rate || "";
    const [numerator, denominator] = rate.split("/").map(Number);
    const fps = denominator && numerator ? numerator / denominator : 0;
    const selectIndex = frameNumber - 1;
    try {
      await execFileAsync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", input, "-map", "0:v:0", "-vf", `select=eq(n\\,${selectIndex}),scale=2048:2048:force_original_aspect_ratio=decrease`, "-fps_mode", "vfr", "-frames:v", "1", "-q:v", "3", output], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      throw new Error(`Could not extract frame ${frameNumber}; the video may not contain that many frames.`);
    }
    let frame: Buffer;
    try { frame = await readFile(output); }
    catch { throw new Error(`Frame ${frameNumber} is beyond the end of this video.`); }
    const timestamp = fps > 0 ? selectIndex / fps : undefined;
    const note = timestamp === undefined ? "timestamp unavailable" : `approximately ${timestamp.toFixed(3)} seconds (estimated from ${fps.toFixed(3)} fps)`;
    const image = await sharp(frame).jpeg({ quality: 88 }).toBuffer();
    return {
      message: `Extracted frame ${frameNumber} (1-based decoded frame number) from ${asset.original_name}, local asset ID ${asset.id}; ${note}. The returned image is the exact selected decoded frame.`,
      imageUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractMentionedVideoEdgeFrame(reference: string, edge: "first" | "last", refs: { mention: string; id: string }[], chatId: string) {
  if (edge === "first") return extractMentionedVideoFrame(reference, 1, refs, chatId);
  const asset = resolveChatAsset(reference, refs, chatId);
  if (!asset) throw new Error(`The referenced media ${reference} is unavailable in this chat's library.`);
  if (!asset.mime_type.startsWith("video/")) throw new Error(`${reference} is ${asset.mime_type}; frame extraction requires a video.`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vfxguru-video-last-frame-"));
  try {
    const input = path.join(tempDir, `input${path.extname(asset.original_name) || ".video"}`);
    await (await import("node:fs/promises")).writeFile(input, await readAsset(asset));
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "json", input], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const probe = JSON.parse(stdout) as { streams?: Array<{ nb_read_frames?: string }> };
    const frameCount = Number(probe.streams?.[0]?.nb_read_frames);
    if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new Error("Could not determine the number of decoded video frames.");
    return await extractMentionedVideoFrame(reference, frameCount, refs, chatId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function POST(request: Request) {
  const form = await request.formData();
  const message = String(form.get("message") || "").trim();
  const chatId = String(form.get("chatId") || "").trim().slice(0, 120);
  const requestId = String(form.get("requestId") || "").trim().slice(0, 120);
  if (!chatId) return NextResponse.json({ error: "Chat ID is required." }, { status: 400 });
  let history: { role: "user" | "assistant"; content: string }[] = [];
  try {
    const raw = String(form.get("history") || "[]");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) history = parsed.filter((turn): turn is { role: "user" | "assistant"; content: string } => turn && (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string").slice(-24);
  } catch { return NextResponse.json({ error: "Conversation history is invalid." }, { status: 400 }); }
  const savedProvider = await getProviderSettings();
  const baseURL = savedProvider.baseURL;
  const apiKey = savedProvider.apiKey;
  const model = savedProvider.model;
  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  let assetMentions: { mention: string; id: string }[] = [];
  try {
    const parsed = JSON.parse(String(form.get("assetRefs") || "[]"));
    if (Array.isArray(parsed)) assetMentions = parsed.filter((item): item is { mention: string; id: string } => item && typeof item.mention === "string" && /^@(image|video|audio|file)\d+$/.test(item.mention) && typeof item.id === "string").slice(0, 24);
  } catch { return NextResponse.json({ error: "Referenced asset list is invalid." }, { status: 400 }); }
  const chatAssets = listAssets(chatId);
  const chatAssetIds = new Set(chatAssets.map((asset) => asset.id));
  assetMentions = assetMentions.filter((item) => chatAssetIds.has(item.id));
  const availableAssets = assetMentions.flatMap(({ mention, id }) => {
    const asset = getChatAsset(chatId, id);
    if (!asset) return [];
    const scene = getScene(id) as Record<string, unknown> | null;
    const sceneMetadata = scene?.metadata && typeof scene.metadata === "object" ? scene.metadata as Record<string, unknown> : null;
    const boxes = sceneMetadata?.vfxguruBboxes;
    const frameData = scene?.kind === "video-frame" ? {
      sourceTimeSec: scene.sourceTimeSec,
      edge: scene.edge,
    } : undefined;
    const type = asset.mime_type;
    const tools = type.startsWith("image/")
      ? ["view", "edit", "crop", "annotate", "bounding-boxes"]
      : type.startsWith("video/")
        ? ["view", "edit", "trim", "split", "extract-first-frame", "extract-last-frame"]
        : type.startsWith("audio/") ? ["play", "trim"] : ["view"];
    const metadata = { ...(boxes ? { vfxguruBboxes: boxes } : {}), ...(frameData ? { videoFrame: frameData } : {}) };
    const tags = getAssetTags(id).tags;
    const characters = getAssetCharacterProfiles(id);
    return [{ mention, assetId: id, fileName: asset.original_name, type, tools, tags, characters, hasMetadata: Boolean(scene || tags.length || characters.length), ...(Object.keys(metadata).length ? { metadata } : {}) }];
  });
  if (!apiKey) return NextResponse.json({ error: "Enter an API key in Model settings, or set OPENAI_API_KEY in .env.local." }, { status: 503 });
  if (!message) return NextResponse.json({ error: "Message is required." }, { status: 400 });
  try {
    const parsed = new URL(baseURL);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new Error();
  } catch {
    return NextResponse.json({ error: "Base URL must use HTTPS, except for localhost providers." }, { status: 400 });
  }
  if (files.length > 8) return NextResponse.json({ error: "Attach at most 8 files at a time." }, { status: 400 });
  if (files.some((file) => file.size > MAX_FILE_BYTES)) return NextResponse.json({ error: "Each file must be 25 MB or smaller." }, { status: 413 });
  if (files.some((file) => !allowedMime.test(file.type) && !allowedExtension.test(file.name))) return NextResponse.json({ error: "One or more file types are not supported." }, { status: 415 });

  try {
    const content: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }> = [{ type: "text", text: message }];
    if (availableAssets.length) content.push({ type: "text", text: `\nAvailable media in this chat. These descriptors do not include pixels. For visual inspection, call inspect_asset with either the @mention or assetId. For ComfyUI workflow inputs, asset_inputs may use either the @mention or assetId; Open SuperComputer will validate it belongs to this chat and upload it to ComfyUI automatically.\n${JSON.stringify(availableAssets, null, 2)}` });
    const nonImageFiles = files.filter((file) => !imageMime.has(file.type));
    if (nonImageFiles.length) content.push({ type: "text", text: `\nAttached files (the selected provider may not accept these as model inputs; images are included directly): ${nonImageFiles.map((file) => `${file.name} (${file.type || "unknown type"})`).join(", ")}` });
    for (const file of files) {
      if (!imageMime.has(file.type)) continue;
      const bytes = Buffer.from(await file.arrayBuffer());
      content.push({ type: "image", image: bytes, mediaType: file.type });
    }

    const messages: ModelMessage[] = [...history.map((turn) => ({ role: turn.role, content: turn.content } as ModelMessage)), { role: "user", content }];
    const systemPrompt = "You are Open SuperComputer, a practical creative production assistant. Available chat media is listed in each user message with both an @mention and a local assetId; these references point to the same saved asset. Descriptors and tags are not visual content. When you need to understand an image or video, call inspect_asset with its @mention or local assetId; the tool returns image pixels or a timestamped video contact sheet. For a specific video still, call extract_video_frame with the video reference and a 1-based frame_number (frame 1 is the first decoded frame); its timestamp is approximate for variable-frame-rate video. For a clip's exact first or last decoded frame, call extract_video_edge_frame with edge 'first' or 'last'. Use these tools before recommending or performing content-dependent edits. Reuse saved character profiles and asset tags to maintain identity and continuity across scenes. When the user asks you to remember, identify, or tag a character, inspect its reference and call tag_asset to save concise visual tags and a reusable character profile. For a scene-generation request based on a new reference, inspect it and save tags/profile when the user has named the character or asked for continuity. Never invent a proper name: only create a reusable character profile with a name supplied by the user. Put visible attributes of unnamed subjects in asset tags and omit them from character profiles. Distinguish observed appearance from user-provided identity, and do not overwrite a known profile with contradictory guesses. For run_workflow.asset_inputs, pass either the listed @mention or local assetId for each media input; Open SuperComputer validates it belongs to this chat and uploads it to ComfyUI. Bounding boxes use source-image pixel coordinates plus normalized coordinates. You can discover workflows, inspect their overridable parameters, and check ComfyUI status with MCP tools. When you submit a ComfyUI workflow, call pin_run with its returned job_id so the user can track it in the chat header; then wait briefly with wait_for_run and report what is happening. The pinned card refreshes status independently. When checking a run, compare its status, progress, message, and updated_at across checks. If progress appears unchanged over a wait interval, call list_recent_runs and check for other queued or running jobs before warning that the target may be stalled. If another active job exists, say it may be queued behind or competing for ComfyUI resources, but do not claim that is definitely the cause. If no other active job is listed, report the lack of observed progress as a possible stall, not a confirmed failure. Do not cancel or submit a duplicate run unless the user asks. If a ComfyUI run fails, inspect its error and error_details and decide whether to stop or attempt a reasoned correction. You may make at most five retries after the initial submission for any run failure; change relevant settings and never repeat an identical request. For image inputs, use asset_inputs with the exact workflow media input key and a listed @mention or local assetId; never put a local asset ID directly into a Load Image parameter. Stop after five retries, or sooner when you decide no safe correction is available. Treat cancellation and interruption statuses as evidence to evaluate; do not automatically stop or retry them. If the user refers to a previous ComfyUI render that is missing from the media library, call list_recent_runs to identify it, then import_run_outputs with that completed run ID; imported files will be shown in the chat with their existing image or video editor. Never claim a run completed unless the status confirms it. Do not submit a run for a suggestion or question. Ask for missing required inputs. For other actual operations through the existing pipeline, use run_pipeline. Available pipelines: analyze-shot, color-grade, remove-background, upscale, composite.";
    const mcpUrl = new URL(`${(process.env.COMFY_SERVICE_URL || "http://127.0.0.1:8012").replace(/\/$/, "")}/mcp/`);
    const serviceToken = process.env.COMFY_SERVICE_TOKEN?.trim();
    const transport = new StreamableHTTPClientTransport(mcpUrl, { requestInit: serviceToken ? { headers: { "X-Service-Token": serviceToken } } : undefined });
    const mcp = new Client({ name: "vfxguru-chat", version: "0.1.0" });
    try {
      let listedTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = [];
      try {
        await mcp.connect(transport);
        const listed = await mcp.listTools();
        listedTools = listed.tools.filter((item) => exposedMcpTools.has(item.name)).map((item) => ({ name: item.name, description: item.description, inputSchema: item.inputSchema as Record<string, unknown> }));
      } catch (error) {
        console.warn("Comfy MCP service unavailable; continuing without Comfy tools.", error);
      }
      let action: { type: string; pipeline: string; prompt: string } | undefined;
      const importedByRun = new Map<string, Array<Record<string, unknown>>>();
      const mediaAssets: Array<Record<string, unknown>> = [];
      let workflowSubmissionCount = 0;
      const workflowRequestSignatures = new Set<string>();
      const toolExecutors = new Map<string, (input: unknown) => Promise<unknown>>();
      const tools: ToolSet = {};
      const addTool = (name: string, description: string, inputSchema: Record<string, unknown>, execute: (input: Record<string, unknown>) => Promise<unknown>, toModelOutput?: NonNullable<Tool<unknown, unknown>["toModelOutput"]>) => {
        toolExecutors.set(name, (input) => execute(input as Record<string, unknown>));
        (tools as Record<string, ToolSet[string]>)[name] = tool({ description, inputSchema: jsonSchema(inputSchema as Parameters<typeof jsonSchema>[0]), execute: async (input) => execute(input as Record<string, unknown>), ...(toModelOutput ? { toModelOutput } : {}) });
      };
      for (const mcpTool of listedTools) {
        const description = mcpTool.name === "run_workflow"
          ? `${mcpTool.description || "Submit a ComfyUI workflow."} In Open SuperComputer chat, asset_inputs values may be either a listed @mention or a local Open SuperComputer assetId; the app validates and uploads the file before calling ComfyUI.`
          : mcpTool.name === "list_recent_runs"
            ? `${mcpTool.description || "Find recent ComfyUI runs."} Use it to check for other queued or running jobs when a target run appears not to be progressing.`
          : mcpTool.description || "Call the configured ComfyUI service tool.";
        addTool(mcpTool.name, description, mcpTool.inputSchema, async (input) => {
          try {
            if (mcpTool.name === "wait_for_run" && requestId) setChatActivity(requestId, "Waiting for the ComfyUI render…");
            if (mcpTool.name === "import_run_outputs") {
              const runId = String((input as { run_id?: unknown }).run_id || "").trim();
              if (!runId || runId.length > 120) throw new Error("Provide a valid ComfyUI run ID.");
              const base = (process.env.COMFY_SERVICE_URL || "http://127.0.0.1:8012").replace(/\/$/, "");
              const response = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}`, { headers: serviceToken ? { "X-Service-Token": serviceToken } : undefined });
              if (!response.ok) throw new Error(response.status === 404 ? "ComfyUI run not found." : `Could not read ComfyUI run (${response.status}).`);
              const runData = await response.json();
              const imported = await importCompletedRunOutputs(runData, chatId, importedByRun);
              if (!imported.length) throw new Error("This run has no completed outputs to import.");
              for (const asset of imported) if (!mediaAssets.some((item) => item.id === asset.id)) mediaAssets.push(asset);
              return { run: findRunRecord(runData), imported_assets: imported };
            }
            const args = { ...(input as Record<string, unknown>) };
            if (mcpTool.name === "run_workflow" && args.asset_inputs && typeof args.asset_inputs === "object") {
              const uploaded = new Map<string, string>();
              for (const [key, reference] of Object.entries(args.asset_inputs as Record<string, unknown>)) {
                if (typeof reference !== "string" || (!/^@(image|video|audio|file)\d+$/.test(reference) && !assetIdPattern.test(reference))) throw new Error(`Invalid media reference for workflow input ${key}. Use an available @mention or local asset ID.`);
                if (!uploaded.has(reference)) uploaded.set(reference, (await uploadReferencedAsset(reference, assetMentions, chatId)).id);
                (args.asset_inputs as Record<string, string>)[key] = uploaded.get(reference)!;
              }
            }
            if (mcpTool.name === "run_workflow") {
              const normalize = (value: unknown): unknown => {
                if (Array.isArray(value)) return value.map(normalize);
                if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize((value as Record<string, unknown>)[key])]));
                return value;
              };
              const signature = JSON.stringify(normalize({ workflow_id: args.workflow_id, parameters: args.parameters || {}, asset_inputs: args.asset_inputs || {} })) || "";
              if (workflowRequestSignatures.has(signature)) return { error: "This exact workflow request was already submitted. Change the relevant input or settings before trying again." };
              if (workflowSubmissionCount >= 6) return { error: "The initial submission plus five retries have been used. Do not submit another workflow for this request." };
              workflowRequestSignatures.add(signature);
              workflowSubmissionCount += 1;
            }
            const result = unwrapMcpResult(await mcp.callTool({ name: mcpTool.name, arguments: args }));
            if (mcpTool.name === "run_workflow" && result && typeof result === "object") {
              const submitted = result as { job_id?: unknown; error?: unknown };
              if (typeof submitted.job_id === "string" && submitted.job_id && !submitted.error) pinComfyRun(chatId, submitted.job_id);
            }
            if (mcpTool.name === "get_run_status" || mcpTool.name === "wait_for_run") {
              const imported = await importCompletedRunOutputs(result, chatId, importedByRun);
              for (const asset of imported) if (!mediaAssets.some((item) => item.id === asset.id)) mediaAssets.push(asset);
              if (imported.length && result && typeof result === "object") return { ...(result as Record<string, unknown>), imported_assets: imported };
              const run = findRunRecord(result);
              const runId = typeof run?.id === "string" ? run.id : undefined;
              const cached = runId ? importedByRun.get(runId) : undefined;
              if (cached?.length && result && typeof result === "object") return { ...(result as Record<string, unknown>), imported_assets: cached };
            }
            return result;
          } catch (error) { return { error: error instanceof Error ? error.message : "ComfyUI tool execution failed." }; }
        });
      }
      addTool("pin_run", "Pin a ComfyUI run to this chat so its live progress remains visible in the chat header. Call after run_workflow returns job_id.", { type: "object", additionalProperties: false, properties: { job_id: { type: "string", minLength: 1, maxLength: 120 } }, required: ["job_id"] }, async ({ job_id }) => {
        const runId = String(job_id || "").trim();
        if (!runId || runId.length > 120) return { error: "Provide a valid ComfyUI job ID." };
        const base = (process.env.COMFY_SERVICE_URL || "http://127.0.0.1:8012").replace(/\/$/, "");
        const response = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}`, { headers: serviceToken ? { "X-Service-Token": serviceToken } : undefined });
        if (!response.ok) return { error: response.status === 404 ? "ComfyUI run not found." : `Could not validate ComfyUI run (${response.status}).` };
        const run = findRunRecord(await response.json());
        if (!run || run.id !== runId) return { error: "ComfyUI returned an unexpected run record." };
        pinComfyRun(chatId, runId);
        return { pinned: true, chat_id: chatId, run };
      });
      addTool("inspect_asset", "Inspect an image or video in this chat's media library. Pass its @mention or local assetId. Returns visual pixels or a timestamped video contact sheet for analysis.", { type: "object", additionalProperties: false, properties: { mention: { type: "string", pattern: "^(?:@(image|video)\\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$" } }, required: ["mention"] }, async ({ mention }) => {
        if (typeof mention !== "string" || (!/^@(image|video)\d+$/.test(mention) && !assetIdPattern.test(mention))) return { error: "Choose an image or video @mention or local asset ID available in this chat's media library." };
        try {
          const inspected = await inspectMentionedAsset(mention, assetMentions, chatId);
          const imageUrl = inspected[1]?.type === "image_url" ? inspected[1].image_url.url : "";
          return { message: inspected[0].text, imageUrl };
        } catch (error) { return { error: error instanceof Error ? error.message : "Could not inspect this asset." }; }
      }, ({ output }) => {
        const result = output as { message?: string; imageUrl?: string };
        const match = result.imageUrl?.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
        return match ? { type: "content", value: [{ type: "text", text: result.message || "Visual asset inspection." }, { type: "image-data", data: match[2], mediaType: match[1] }] } : { type: "content", value: [{ type: "text", text: JSON.stringify(output) || "Asset inspection returned no result." }] };
      });
      addTool("extract_video_frame", "Extract and visually inspect one exact decoded frame from a video in this chat. frame_number is 1-based (frame 1 is the first frame). Returns the selected frame pixels and its estimated timestamp.", {
        type: "object", additionalProperties: false,
        properties: {
          reference: { type: "string", pattern: "^(?:@(image|video)\\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$" },
          frame_number: { type: "integer", minimum: 1, maximum: 250000 },
        }, required: ["reference", "frame_number"],
      }, async ({ reference, frame_number }) => {
        if (typeof reference !== "string" || (!/^@(image|video)\d+$/.test(reference) && !assetIdPattern.test(reference))) return { error: "Choose a video @mention or local asset ID available in this chat's media library." };
        if (typeof frame_number !== "number" || !Number.isInteger(frame_number) || frame_number < 1 || frame_number > 250_000) return { error: "frame_number must be an integer from 1 to 250000. Frame numbering starts at 1." };
        try { return await extractMentionedVideoFrame(reference, frame_number, assetMentions, chatId); }
        catch (error) { return { error: error instanceof Error ? error.message : "Could not extract the requested video frame." }; }
      }, ({ output }) => {
        const result = output as { message?: string; imageUrl?: string };
        const match = result.imageUrl?.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
        return match ? { type: "content", value: [{ type: "text", text: result.message || "Extracted video frame." }, { type: "image-data", data: match[2], mediaType: match[1] }] } : { type: "content", value: [{ type: "text", text: JSON.stringify(output) || "Frame extraction returned no result." }] };
      });
      addTool("extract_video_edge_frame", "Extract and visually inspect the exact first or last decoded frame of a video in this chat's media library. Use edge 'first' or 'last'; returns frame pixels and estimated timestamp.", {
        type: "object", additionalProperties: false,
        properties: {
          reference: { type: "string", pattern: "^(?:@(image|video)\\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$" },
          edge: { type: "string", enum: ["first", "last"] },
        }, required: ["reference", "edge"],
      }, async ({ reference, edge }) => {
        if (typeof reference !== "string" || (!/^@(image|video)\d+$/.test(reference) && !assetIdPattern.test(reference))) return { error: "Choose a video @mention or local asset ID available in this chat's media library." };
        if (edge !== "first" && edge !== "last") return { error: "edge must be 'first' or 'last'." };
        try { return await extractMentionedVideoEdgeFrame(reference, edge, assetMentions, chatId); }
        catch (error) { return { error: error instanceof Error ? error.message : `Could not extract the ${edge} video frame.` }; }
      }, ({ output }) => {
        const result = output as { message?: string; imageUrl?: string };
        const match = result.imageUrl?.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
        return match ? { type: "content", value: [{ type: "text", text: result.message || "Extracted video edge frame." }, { type: "image-data", data: match[2], mediaType: match[1] }] } : { type: "content", value: [{ type: "text", text: JSON.stringify(output) || "Edge-frame extraction returned no result." }] };
      });
      addTool("tag_asset", "Save descriptive tags and reusable character profiles for an image or video in this chat's media library. Inspect the asset first when tags are based on visual content. Create character profiles only with names supplied by the user; keep unnamed visual subjects in ordinary tags.", {
        type: "object", additionalProperties: false,
        properties: {
          reference: { type: "string", pattern: "^(?:@(image|video)\\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$" },
          tags: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 64 } },
          characters: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 100 }, description: { type: "string", maxLength: 1000 }, appearance: { type: "string", maxLength: 1500 } }, required: ["name"] } },
        }, required: ["reference", "tags"],
      }, async ({ reference, tags, characters }) => {
        if (typeof reference !== "string" || (!/^@(image|video)\d+$/.test(reference) && !assetIdPattern.test(reference))) return { error: "Choose an image or video @mention or local asset ID available in this chat." };
        const asset = resolveChatAsset(reference, assetMentions, chatId);
        if (!asset) return { error: `The referenced media ${reference} is unavailable in this chat's library.` };
        if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return { error: "Tags must be a list of text labels." };
        if (characters !== undefined && !Array.isArray(characters)) return { error: "Characters must be a list of character profiles." };
        const profiles = characters === undefined ? undefined : characters.filter((item): item is { name: string; description?: string; appearance?: string } => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string").map((item) => ({ name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}), ...(typeof item.appearance === "string" ? { appearance: item.appearance } : {}) }));
        const saved = saveAssetTags(asset.id, tags, profiles);
        return { assetId: asset.id, fileName: asset.original_name, tags: saved.tags, characters: saved.characters, updatedAt: saved.updatedAt };
      });
      addTool("run_pipeline", "Hand off an explicitly requested VFX pipeline operation to the Open SuperComputer interface.", { type: "object", additionalProperties: false, properties: { pipeline: { type: "string", enum: ["analyze-shot", "color-grade", "remove-background", "upscale", "composite"] }, prompt: { type: "string" } }, required: ["pipeline", "prompt"] }, async (input) => {
        action = input as { type: string; pipeline: string; prompt: string };
        return { accepted: true, message: "The existing pipeline action was handed to the Open SuperComputer interface." };
      });

      const provider = createOpenAICompatible({ name: "vfxguru-configured", apiKey, baseURL: baseURL.replace(/\/$/, "") });
      let streamedText = "";
      let activeCheckpointStep = false;
      let activeCheckpointText = "";
      let activeCheckpointPublished = false;
      const stepStartTimes = new Map<number, number>();
      const checkpointStepNumbers = new Set<number>();
      const logMessages = [
        { role: "system", content: systemPrompt },
        ...messages.map((item) => ({ role: item.role, content: typeof item.content === "string" ? item.content : item.content.map((part) => part.type === "image" ? { type: "image", mediaType: part.mediaType, sizeBytes: part.image instanceof Uint8Array ? part.image.byteLength : undefined } : part) })),
      ];
      const generation = streamText({
        model: provider(model), system: systemPrompt, messages, tools, stopWhen: stepCountIs(MAX_LLM_ROUNDS), abortSignal: request.signal,
        prepareStep: ({ stepNumber, steps }) => {
          const completedRounds = steps.length;
          const atHardCap = completedRounds >= MAX_LLM_ROUNDS - 1;
          const checkpointDue = completedRounds > 0 && completedRounds % 10 === 0;
          activeCheckpointStep = checkpointDue;
          activeCheckpointText = "";
          activeCheckpointPublished = false;
          const failedOutputs = steps.flatMap((step) => step.toolResults.map((toolResult) => toolResult.output)).filter((output) => terminalRunStatus(output));
          const failedRunIds = new Set(failedOutputs.map((output) => {
            const runId = findRunRecord(output)?.id;
            return typeof runId === "string" ? runId : JSON.stringify(output);
          }));
          const retryAllowed = failedRunIds.size > 0 && workflowSubmissionCount < 6;
          const failureGuidance = retryAllowed
            ? `${systemPrompt} A ComfyUI run failed. Inspect its exact error and error_details, then decide whether a retry is justified or whether you should stop and explain. You may make at most five retries after the initial submission. Each retry must change the relevant workflow input or setting; never repeat an identical request. For pre-render image validation errors, map the image through asset_inputs using the exact workflow media input key and a listed @mention or local assetId; never put the raw Open SuperComputer asset ID directly into a Load Image parameter. For execution errors, adjust settings only when the error suggests a concrete fix. Cancellations and interruptions are also information for you to evaluate; do not automatically stop or retry them. Stop if required user input is missing or no safe, reasoned adjustment is available.`
            : systemPrompt;
          const system = atHardCap
            ? `${failureGuidance} Do not call more tools. Give the user a concise status and clearly say what remains unfinished, without mentioning internal limits or round counts.`
            : checkpointDue
              ? `${failureGuidance} Progress checkpoint: ${completedRounds} tool rounds have completed. Give the user a short, concrete progress update in natural language now, then continue any necessary tool calls in this same run. Do not stop at the checkpoint unless the requested task is actually complete; if more work is needed, include the update and continue with tools. Do not expose round counts or internal limits to the user.`
              : failureGuidance;
          if (checkpointDue && requestId) setChatActivity(requestId, "Preparing a progress update…");
          if (checkpointDue) checkpointStepNumbers.add(stepNumber);
          return { system, toolChoice: atHardCap ? "none" : "auto" };
        },
        onChunk: ({ chunk }) => {
          if (chunk.type === "text-delta") {
            streamedText += chunk.text;
            if (activeCheckpointStep) activeCheckpointText += chunk.text;
            if (requestId) setChatProgress(requestId, streamedText);
          } else if (chunk.type === "tool-call") {
            if (activeCheckpointStep && activeCheckpointText.trim() && requestId && !activeCheckpointPublished) {
              publishChatCheckpoint(requestId, activeCheckpointText);
              activeCheckpointPublished = true;
            }
            if (requestId) setChatActivity(requestId, `Using ${chunk.toolName}…`);
          }
        },
        experimental_onStepStart: ({ stepNumber }) => { stepStartTimes.set(stepNumber, Date.now()); },
        onStepFinish: ({ stepNumber, finishReason, text, toolCalls, toolResults, usage }) => {
          if (checkpointStepNumbers.has(stepNumber)) {
            checkpointStepNumbers.delete(stepNumber);
            if (toolCalls.length && text.trim() && requestId && !activeCheckpointPublished) publishChatCheckpoint(requestId, text);
          }
          writeExchangeLog({ chatId, round: stepNumber + 1, model, baseURL, status: toolCalls.length ? "tool_calls" : "complete", duration: Date.now() - (stepStartTimes.get(stepNumber) || Date.now()),
            request: { messages: logMessages, toolNames: Object.keys(tools), step: stepNumber + 1 },
            response: { text, finishReason, toolCalls, toolResults }, usage });
          streamedText = "";
        },
      });
      const [text, steps] = await Promise.all([generation.text, generation.steps]);
      let responseText = text;
      const textToolCalls = parseDsmlToolCalls(text);
      const containsDsmlMarkup = /<｜{2}DSML｜{2}\s*(?:calls|invoke|parameter)\b/.test(text);
      if (textToolCalls.length) {
        const supportedTextTools = new Set(["list_recent_runs", "get_run_status", "wait_for_run", "import_run_outputs", "pin_run"]);
        const unsupported = textToolCalls.find((call) => !supportedTextTools.has(call.name));
        if (unsupported) {
          responseText = "The model returned a tool request as text instead of a callable function. I didn’t execute it. Please retry with a model that supports native tool calling.";
        } else {
          const results: Array<{ name: string; output: unknown }> = [];
          for (const call of textToolCalls) {
            const execute = toolExecutors.get(call.name);
            if (!execute) { results.push({ name: call.name, output: { error: "This tool is not available." } }); continue; }
            const output = await execute(call.input);
            results.push({ name: call.name, output });
            const imported = output && typeof output === "object" ? (output as { imported_assets?: Array<Record<string, unknown>> }).imported_assets : undefined;
            for (const asset of imported || []) if (!mediaAssets.some((item) => item.id === asset.id)) mediaAssets.push(asset);
          }
          const recentRuns = results.find((result) => result.name === "list_recent_runs");
          const importResult = results.find((result) => result.name === "import_run_outputs");
          if (recentRuns) responseText = formatRecentRuns(recentRuns.output);
          else if (importResult) {
            const imported = importResult.output && typeof importResult.output === "object" ? (importResult.output as { imported_assets?: Array<{ original_name?: string }> }).imported_assets || [] : [];
            responseText = imported.length
              ? `Imported ${imported.length} output${imported.length === 1 ? "" : "s"} into this chat’s media library: ${imported.map((asset) => asset.original_name || "generated media").join(", ")}. Select an @mention to open it in the image or video editor.`
              : "The run output import did not return any media assets.";
          } else {
            responseText = results.map((result) => `${result.name}: ${JSON.stringify(result.output)}`).join("\n");
          }
          writeExchangeLog({ chatId, round: steps.length + 1, model, baseURL, status: "text_tool_fallback", duration: 0,
            request: { messages: logMessages, toolNames: Object.keys(tools), parsedTextToolCalls: textToolCalls }, response: { text: responseText, results } });
        }
      } else if (containsDsmlMarkup) {
        responseText = "The model returned a tool request in an unreadable text format, so I didn’t execute it. Please retry; the recent-run list and output importer are available as native tools.";
      }
      for (const step of steps) {
        for (const toolResult of step.toolResults) {
          const output = toolResult.output as { imported_assets?: Array<Record<string, unknown>> } | undefined;
          for (const asset of output?.imported_assets || []) if (!mediaAssets.some((item) => item.id === asset.id)) mediaAssets.push(asset);
        }
      }
      const progressUpdates = requestId ? getChatProgress(requestId)?.checkpoints || [] : [];
      return NextResponse.json({ text: responseText || "The request finished without a text response.", action, mediaAssets, progressUpdates });
    } finally {
      await mcp.close().catch(() => undefined);
    }
  } catch (error) {
    const providerError = error && typeof error === "object" ? error as { status?: unknown; request_id?: unknown; message?: unknown } : undefined;
    if (providerError?.status === 402 || (typeof providerError?.message === "string" && /insufficient balance/i.test(providerError.message))) {
      const requestId = typeof providerError.request_id === "string" ? ` Support reference: ${providerError.request_id}.` : "";
      return NextResponse.json({ text: `Your model provider reports insufficient balance. Add credits to the provider account or switch to a provider/model with available balance, then try again.${requestId}` });
    }
    console.error("Compatible chat API error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Chat API request failed." }, { status: 502 });
  }
}
