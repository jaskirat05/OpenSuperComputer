export type ChatCheckpoint = { id: string; text: string };
type ProgressEntry = { text: string; activity: string | null; checkpoints: ChatCheckpoint[]; updatedAt: number };
type ProgressGlobal = typeof globalThis & { __vfxGuruChatProgress?: Map<string, ProgressEntry> };

const progressGlobal = globalThis as ProgressGlobal;
const entries = progressGlobal.__vfxGuruChatProgress ??= new Map<string, ProgressEntry>();

export function setChatProgress(requestId: string, text: string) {
  if (!requestId) return;
  const now = Date.now();
  for (const [key, entry] of entries) if (now - entry.updatedAt > 5 * 60_000) entries.delete(key);
  const previous = entries.get(requestId);
  entries.set(requestId, { text: text.slice(0, 500), activity: null, checkpoints: previous?.checkpoints || [], updatedAt: now });
}

export function setChatActivity(requestId: string, activity: string | null) {
  if (!requestId) return;
  const now = Date.now();
  for (const [key, entry] of entries) if (now - entry.updatedAt > 5 * 60_000) entries.delete(key);
  const previous = entries.get(requestId);
  entries.set(requestId, { text: previous?.text || "", activity: activity?.slice(0, 160) || null, checkpoints: previous?.checkpoints || [], updatedAt: now });
}

export function publishChatCheckpoint(requestId: string, text: string) {
  if (!requestId || !text.trim()) return null;
  const now = Date.now();
  for (const [key, entry] of entries) if (now - entry.updatedAt > 5 * 60_000) entries.delete(key);
  const previous = entries.get(requestId);
  const checkpoints = previous?.checkpoints || [];
  const checkpoint = { id: crypto.randomUUID(), text: text.trim().slice(0, 1200) };
  checkpoints.push(checkpoint);
  entries.set(requestId, { text: previous?.text || "", activity: previous?.activity || null, checkpoints: checkpoints.slice(-10), updatedAt: now });
  return checkpoint;
}

export function getChatProgress(requestId: string) {
  const entry = entries.get(requestId);
  if (!entry || Date.now() - entry.updatedAt > 5 * 60_000) {
    entries.delete(requestId);
    return null;
  }
  return { text: entry.text, activity: entry.activity, checkpoints: entry.checkpoints };
}
