import "server-only";
import Database from "better-sqlite3";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type AssetRecord = {
  id: string; chat_id: string; parent_asset_id: string | null; original_name: string;
  stored_name: string; mime_type: string; size: number; kind: string; scene_json: string | null; metadata_json: string | null; created_at: string;
};

export type AssetTags = { tags: string[]; characterIds: string[]; updatedAt: string | null };
export type CharacterProfile = { id: string; name: string; description: string | null; appearance: string | null };

const dataDir = process.env.VFXGURU_DATA_DIR || (process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "VFXGuru")
  : path.join(homedir(), ".local", "share", "vfxguru"));
const assetDir = path.join(dataDir, "assets");
let db: Database.Database | undefined;

function database() {
  if (!db) {
    db = new Database(path.join(dataDir, "vfxguru.sqlite"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title TEXT, head_message_id TEXT);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), parent_asset_id TEXT REFERENCES assets(id),
        original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        kind TEXT NOT NULL, scene_json TEXT, metadata_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS asset_chats (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(asset_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS comfy_output_imports (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        output_name TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        PRIMARY KEY(chat_id, run_id, output_name)
      );
      CREATE TABLE IF NOT EXISTS tracked_comfy_runs (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS assets_chat_created ON assets(chat_id, created_at DESC);
      INSERT OR IGNORE INTO asset_chats(asset_id, chat_id, created_at) SELECT id, chat_id, created_at FROM assets;`);
    const assetColumns = new Set((db.pragma("table_info(assets)") as { name: string }[]).map((column) => column.name));
    if (!assetColumns.has("metadata_json")) db.exec("ALTER TABLE assets ADD COLUMN metadata_json TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY, normalized_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT, appearance TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_characters (
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, PRIMARY KEY(asset_id, character_id)
    );
    CREATE INDEX IF NOT EXISTS asset_characters_character ON asset_characters(character_id);`);
    const chatColumns = new Set((db.pragma("table_info(chats)") as { name: string }[]).map((column) => column.name));
    if (!chatColumns.has("title")) db.exec("ALTER TABLE chats ADD COLUMN title TEXT");
    if (!chatColumns.has("head_message_id")) db.exec("ALTER TABLE chats ADD COLUMN head_message_id TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL, parent_id TEXT, message_json TEXT NOT NULL, run_config_json TEXT,
      created_at TEXT NOT NULL, UNIQUE(chat_id, message_id)
    ); CREATE INDEX IF NOT EXISTS chat_messages_order ON chat_messages(chat_id, seq);`);
    db.exec(`CREATE TABLE IF NOT EXISTS llm_request_logs (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, created_at TEXT NOT NULL, round INTEGER NOT NULL,
      model TEXT NOT NULL, base_url TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      request_json TEXT NOT NULL, response_json TEXT, usage_json TEXT, error TEXT
    ); CREATE INDEX IF NOT EXISTS llm_logs_chat_created ON llm_request_logs(chat_id, created_at DESC);`);
  }
  return db;
}

function safeExtension(name: string) {
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12);
  return ext || ".bin";
}

export async function saveAsset(input: { chatId: string; file: File; parentAssetId?: string | null; scene?: unknown }) {
  const store = database();
  const chatId = input.chatId.slice(0, 120);
  const now = new Date().toISOString();
  store.prepare("INSERT INTO chats(id, created_at, updated_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at")
    .run(chatId, now, now);
  const id = randomUUID();
  const storedName = `${id}${safeExtension(input.file.name)}`;
  await mkdir(assetDir, { recursive: true });
  const bytes = Buffer.from(await input.file.arrayBuffer());
  const filePath = path.join(assetDir, storedName);
  await writeFile(filePath, bytes, { flag: "wx" });
  const scene = input.scene === undefined ? null : JSON.stringify(input.scene);
  try {
    store.prepare(`INSERT INTO assets(id, chat_id, parent_asset_id, original_name, stored_name, mime_type, size, kind, scene_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, chatId, input.parentAssetId || null, input.file.name.slice(0, 240), storedName,
        input.file.type || "application/octet-stream", bytes.byteLength,
        input.file.type.startsWith("image/") ? "image" : input.file.type.startsWith("video/") ? "video" : "file", scene, now);
    store.prepare("INSERT OR IGNORE INTO asset_chats(asset_id, chat_id, created_at) VALUES (?, ?, ?)").run(id, chatId, now);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
  return getAsset(id)!;
}

export function getAsset(id: string) {
  return database().prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRecord | undefined;
}

export function getChatAsset(chatId: string, assetId: string) {
  return database().prepare("SELECT assets.* FROM assets JOIN asset_chats ON asset_chats.asset_id = assets.id WHERE asset_chats.chat_id = ? AND assets.id = ?")
    .get(chatId.trim().slice(0, 120), assetId) as AssetRecord | undefined;
}

export function getImportedComfyOutput(chatId: string, runId: string, outputName: string) {
  return database().prepare(`SELECT assets.* FROM comfy_output_imports
    JOIN assets ON assets.id = comfy_output_imports.asset_id
    WHERE comfy_output_imports.chat_id = ? AND comfy_output_imports.run_id = ? AND comfy_output_imports.output_name = ?`)
    .get(chatId.trim().slice(0, 120), runId, outputName) as AssetRecord | undefined;
}

export function recordImportedComfyOutput(chatId: string, runId: string, outputName: string, assetId: string) {
  database().prepare("INSERT OR IGNORE INTO comfy_output_imports(chat_id, run_id, output_name, asset_id) VALUES (?, ?, ?, ?)")
    .run(chatId.trim().slice(0, 120), runId, outputName, assetId);
}

export function pinComfyRun(chatId: string, runId: string) {
  const id = ensureChat(chatId);
  database().prepare("INSERT OR IGNORE INTO tracked_comfy_runs(chat_id, run_id, created_at) VALUES (?, ?, ?)")
    .run(id, runId, new Date().toISOString());
  return { chat_id: id, run_id: runId };
}

export function listPinnedComfyRuns(chatId: string) {
  const id = chatId.trim().slice(0, 120);
  return database().prepare("SELECT run_id, created_at FROM tracked_comfy_runs WHERE chat_id = ? ORDER BY created_at DESC")
    .all(id) as { run_id: string; created_at: string }[];
}

export function unpinComfyRun(chatId: string, runId: string) {
  return database().prepare("DELETE FROM tracked_comfy_runs WHERE chat_id = ? AND run_id = ?")
    .run(chatId.trim().slice(0, 120), runId).changes > 0;
}

export function listAssets(chatId?: string) {
  if (!chatId) return database().prepare("SELECT * FROM assets ORDER BY created_at DESC").all() as AssetRecord[];
  return database().prepare("SELECT assets.* FROM assets JOIN asset_chats ON asset_chats.asset_id = assets.id WHERE asset_chats.chat_id = ? ORDER BY asset_chats.created_at DESC").all(chatId) as AssetRecord[];
}

export function linkAssetToChat(assetId: string, chatId: string) {
  const store = database();
  const now = new Date().toISOString();
  store.prepare("INSERT INTO chats(id, created_at, updated_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at").run(chatId, now, now);
  return store.prepare("INSERT OR IGNORE INTO asset_chats(asset_id, chat_id, created_at) VALUES (?, ?, ?)").run(assetId, chatId, now).changes > 0;
}

export type ChatSummary = { id: string; title: string | null; created_at: string; updated_at: string; message_count: number };
export type StoredChatMessage = { message: Record<string, unknown>; parentId: string | null; runConfig?: Record<string, unknown> };

export function ensureChat(chatId: string) {
  const id = chatId.trim().slice(0, 120);
  if (!id) throw new Error("Chat ID is required.");
  const now = new Date().toISOString();
  database().prepare("INSERT INTO chats(id, created_at, updated_at, title) VALUES(?, ?, ?, NULL) ON CONFLICT(id) DO NOTHING").run(id, now, now);
  return id;
}

export function listChats() {
  return database().prepare(`SELECT chats.id,
      COALESCE(chats.title, (SELECT assets.original_name FROM asset_chats
        JOIN assets ON assets.id = asset_chats.asset_id WHERE asset_chats.chat_id = chats.id
        ORDER BY asset_chats.created_at DESC LIMIT 1)) AS title,
      chats.created_at, chats.updated_at,
      (SELECT COUNT(*) FROM chat_messages WHERE chat_id = chats.id) AS message_count
    FROM chats ORDER BY chats.updated_at DESC, chats.created_at DESC`).all() as ChatSummary[];
}

export function loadChatHistory(chatId: string) {
  const id = ensureChat(chatId);
  const chat = database().prepare("SELECT head_message_id FROM chats WHERE id = ?").get(id) as { head_message_id: string | null };
  const rows = database().prepare("SELECT message_json, parent_id, run_config_json FROM chat_messages WHERE chat_id = ? ORDER BY seq").all(id) as { message_json: string; parent_id: string | null; run_config_json: string | null }[];
  return {
    headId: chat.head_message_id || undefined,
    messages: rows.map((row) => ({ message: JSON.parse(row.message_json), parentId: row.parent_id, ...(row.run_config_json ? { runConfig: JSON.parse(row.run_config_json) } : {}) })),
  };
}

export function saveChatMessage(chatId: string, item: StoredChatMessage) {
  const id = ensureChat(chatId);
  const messageId = typeof item.message?.id === "string" ? item.message.id : "";
  if (!messageId) throw new Error("Message ID is required.");
  const now = new Date().toISOString();
  const content = Array.isArray(item.message.content) ? item.message.content : [];
  const firstText = content.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
  const candidateTitle = typeof firstText?.text === "string" ? firstText.text.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const runConfig = item.runConfig === undefined ? null : JSON.stringify(item.runConfig);
  const store = database();
  const transaction = store.transaction(() => {
    store.prepare(`INSERT INTO chat_messages(chat_id, message_id, parent_id, message_json, run_config_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET
      parent_id=excluded.parent_id, message_json=excluded.message_json, run_config_json=excluded.run_config_json`)
      .run(id, messageId, item.parentId || null, JSON.stringify(item.message), runConfig, now);
    store.prepare("UPDATE chats SET updated_at = ?, head_message_id = ? WHERE id = ?").run(now, messageId, id);
    if (item.message.role === "user" && candidateTitle) {
      store.prepare("UPDATE chats SET title = ? WHERE id = ? AND (title IS NULL OR title = '')").run(candidateTitle, id);
    }
  });
  transaction();
}

export function deleteChatMessages(chatId: string, items: { message: { id: string } }[]) {
  const id = ensureChat(chatId);
  const store = database();
  const remove = store.prepare("DELETE FROM chat_messages WHERE chat_id = ? AND message_id = ?");
  const transaction = store.transaction(() => {
    for (const item of items) remove.run(id, item.message.id);
    const head = store.prepare("SELECT message_id FROM chat_messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1").get(id) as { message_id: string } | undefined;
    store.prepare("UPDATE chats SET head_message_id = ?, updated_at = ? WHERE id = ?").run(head?.message_id || null, new Date().toISOString(), id);
  });
  transaction();
}

export function getScene(id: string) {
  const row = database().prepare("SELECT scene_json FROM assets WHERE id = ?").get(id) as { scene_json: string | null } | undefined;
  return row?.scene_json ? JSON.parse(row.scene_json) : null;
}

export function getAssetTags(id: string): AssetTags {
  const row = database().prepare("SELECT metadata_json FROM assets WHERE id = ?").get(id) as { metadata_json: string | null } | undefined;
  if (!row?.metadata_json) return { tags: [], characterIds: [], updatedAt: null };
  try {
    const parsed = JSON.parse(row.metadata_json) as Partial<AssetTags>;
    return { tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : [], characterIds: Array.isArray(parsed.characterIds) ? parsed.characterIds.filter((value): value is string => typeof value === "string") : [], updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null };
  } catch { return { tags: [], characterIds: [], updatedAt: null }; }
}

export function getAssetCharacterProfiles(id: string): CharacterProfile[] {
  return database().prepare(`SELECT characters.id, characters.name, characters.description, characters.appearance
    FROM asset_characters JOIN characters ON characters.id = asset_characters.character_id
    WHERE asset_characters.asset_id = ? ORDER BY characters.normalized_name`).all(id) as CharacterProfile[];
}

export function saveAssetTags(id: string, tags: string[], profiles?: Array<{ name: string; description?: string; appearance?: string }>) {
  const store = database();
  const asset = store.prepare("SELECT metadata_json FROM assets WHERE id = ?").get(id) as { metadata_json: string | null } | undefined;
  if (!asset) throw new Error("Asset not found.");
  let existing: Record<string, unknown> = {};
  try { if (asset.metadata_json) existing = JSON.parse(asset.metadata_json) as Record<string, unknown>; } catch { /* Replace malformed metadata with valid tag data. */ }
  const uniqueTags = [...new Set(tags.map((tag) => tag.trim().replace(/\s+/g, " ").slice(0, 64)).filter(Boolean))].slice(0, 30);
  const now = new Date().toISOString();
  const normalizedProfiles = [...new Map<string, { name: string; description: string | null; appearance: string | null }>((profiles || []).map((profile) => {
    const name = profile.name.trim().replace(/\s+/g, " ").slice(0, 100);
    return [name.toLocaleLowerCase(), { name, description: profile.description?.trim().slice(0, 1000) || null, appearance: profile.appearance?.trim().slice(0, 1500) || null }] as const;
  }).filter(([key, profile]) => key && profile.name)).values()];
  const transaction = store.transaction(() => {
    if (profiles !== undefined) store.prepare("DELETE FROM asset_characters WHERE asset_id = ?").run(id);
    const characterIds: string[] = profiles === undefined
      ? (store.prepare("SELECT character_id FROM asset_characters WHERE asset_id = ?").all(id) as { character_id: string }[]).map((row) => row.character_id)
      : [];
    for (const profile of normalizedProfiles) {
      const normalizedName = profile.name.toLocaleLowerCase();
      store.prepare(`INSERT INTO characters(id, normalized_name, name, description, appearance, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(normalized_name) DO UPDATE SET
        updated_at=excluded.updated_at`)
        .run(randomUUID(), normalizedName, profile.name, profile.description, profile.appearance, now, now);
      const character = store.prepare("SELECT id FROM characters WHERE normalized_name = ?").get(normalizedName) as { id: string };
      characterIds.push(character.id);
      store.prepare("INSERT OR IGNORE INTO asset_characters(asset_id, character_id, created_at) VALUES(?, ?, ?)").run(id, character.id, now);
    }
    store.prepare("UPDATE assets SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...existing, tags: uniqueTags, characterIds, updatedAt: now }), id);
  });
  transaction();
  return { tags: uniqueTags, characters: getAssetCharacterProfiles(id), updatedAt: now };
}

export function saveScene(id: string, scene: unknown) {
  const result = database().prepare("UPDATE assets SET scene_json = ? WHERE id = ?").run(JSON.stringify(scene), id);
  return result.changes > 0;
}

export async function readAsset(asset: AssetRecord) {
  return readFile(path.join(assetDir, asset.stored_name));
}

export function assetDataDir() { return dataDir; }

export type LLMRequestLog = {
  id: string; chat_id: string; created_at: string; round: number; model: string; base_url: string;
  status: string; duration_ms: number; request_json: string; response_json: string | null; usage_json: string | null; error: string | null;
};

export function saveLLMRequestLog(input: Omit<LLMRequestLog, "id" | "created_at">) {
  const store = database();
  store.prepare(`INSERT INTO llm_request_logs(id, chat_id, created_at, round, model, base_url, status, duration_ms, request_json, response_json, usage_json, error)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.chat_id, new Date().toISOString(), input.round, input.model, input.base_url, input.status, input.duration_ms,
      input.request_json, input.response_json, input.usage_json, input.error);
  store.prepare("DELETE FROM llm_request_logs WHERE id IN (SELECT id FROM llm_request_logs ORDER BY created_at DESC LIMIT -1 OFFSET 1000)").run();
}

export function listLLMRequestLogs(chatId?: string) {
  const store = database();
  if (chatId) return store.prepare("SELECT * FROM llm_request_logs WHERE chat_id = ? ORDER BY created_at DESC LIMIT 200").all(chatId) as LLMRequestLog[];
  return store.prepare("SELECT * FROM llm_request_logs ORDER BY created_at DESC LIMIT 200").all() as LLMRequestLog[];
}

export function clearLLMRequestLogs(chatId?: string) {
  const store = database();
  return chatId ? store.prepare("DELETE FROM llm_request_logs WHERE chat_id = ?").run(chatId).changes : store.prepare("DELETE FROM llm_request_logs").run().changes;
}
