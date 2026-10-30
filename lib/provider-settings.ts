import "server-only";
import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assetDataDir } from "@/lib/asset-store";

export type ProviderSettings = { baseURL: string; model: string; apiKey: string };

function database() {
  const root = assetDataDir();
  const db = new Database(path.join(root, "vfxguru.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS provider_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), base_url TEXT NOT NULL, model TEXT NOT NULL, encrypted_api_key TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)");
  return db;
}

async function encryptionKey() {
  const root = assetDataDir();
  const file = path.join(root, "provider-key.bin");
  await mkdir(root, { recursive: true });
  try { return await readFile(file); }
  catch {
    const key = randomBytes(32);
    try { await writeFile(file, key, { flag: "wx", mode: 0o600 }); return key; }
    catch { return readFile(file); }
  }
}

async function encrypt(value: string) {
  if (!value) return "";
  const key = await encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

async function decrypt(value: string) {
  if (!value) return "";
  const blob = Buffer.from(value, "base64");
  if (blob.length < 29) throw new Error("Saved provider key is corrupt.");
  const decipher = createDecipheriv("aes-256-gcm", await encryptionKey(), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}

export async function getProviderSettings(): Promise<ProviderSettings> {
  await mkdir(assetDataDir(), { recursive: true });
  const db = database();
  try {
    const row = db.prepare("SELECT base_url, model, encrypted_api_key FROM provider_settings WHERE singleton=1").get() as { base_url: string; model: string; encrypted_api_key: string } | undefined;
    return {
      baseURL: row?.base_url || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      model: row?.model || process.env.OPENAI_MODEL || "gpt-4.1",
      apiKey: row?.encrypted_api_key ? await decrypt(row.encrypted_api_key) : process.env.OPENAI_API_KEY || "",
    };
  } finally { db.close(); }
}

export async function saveProviderSettings(input: { baseURL: string; model: string; apiKey?: string; clearApiKey?: boolean }) {
  await mkdir(assetDataDir(), { recursive: true });
  const db = database();
  try {
    const previous = db.prepare("SELECT encrypted_api_key FROM provider_settings WHERE singleton=1").get() as { encrypted_api_key: string } | undefined;
    const encryptedKey = input.clearApiKey ? "" : input.apiKey ? await encrypt(input.apiKey) : previous?.encrypted_api_key || "";
    db.prepare("INSERT INTO provider_settings(singleton, base_url, model, encrypted_api_key, updated_at) VALUES(1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET base_url=excluded.base_url, model=excluded.model, encrypted_api_key=excluded.encrypted_api_key, updated_at=excluded.updated_at")
      .run(input.baseURL, input.model, encryptedKey, new Date().toISOString());
  } finally { db.close(); }
}
