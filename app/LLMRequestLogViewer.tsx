"use client";

import { useEffect, useState } from "react";
import { ScrollText, Trash2, X } from "lucide-react";

type Entry = { id: string; chat_id: string; created_at: string; round: number; model: string; base_url: string; status: string; duration_ms: number; request: unknown; response: unknown; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null; error: string | null };

export default function LLMRequestLogViewer({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [scope, setScope] = useState<"all" | "chat">("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/llm-logs${scope === "chat" ? `?chatId=${encodeURIComponent(chatId)}` : ""}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load LLM request logs.");
      setEntries(data.logs || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load LLM request logs."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [scope, chatId]);

  async function clearLogs() {
    try {
      const response = await fetch(`/api/llm-logs${scope === "chat" ? `?chatId=${encodeURIComponent(chatId)}` : ""}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not clear logs.");
      setEntries([]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not clear logs."); }
  }

  return <div className="modal-backdrop llm-logs-backdrop" onClick={onClose}><section className="llm-logs-modal" onClick={(event) => event.stopPropagation()}>
    <header><div><ScrollText size={17}/><div><strong>LLM request log</strong><small>Local diagnostic history · up to 1,000 exchanges retained</small></div></div><button className="icon-button" onClick={onClose} aria-label="Close request log"><X size={17}/></button></header>
    <div className="llm-log-toolbar"><label>Show<select value={scope} onChange={(event) => setScope(event.target.value as "all" | "chat")}><option value="all">All chats</option><option value="chat">This chat</option></select></label><button type="button" onClick={() => void load()}>Refresh</button><button type="button" onClick={() => void clearLogs()}><Trash2 size={13}/> Clear {scope === "chat" ? "chat" : "all"} logs</button></div>
    {error ? <p className="llm-log-error">{error}</p> : null}
    <div className="llm-log-list">{loading ? <p className="llm-log-empty">Loading request history…</p> : entries.map((entry) => <article key={entry.id}>
      <div className="llm-log-entry-heading"><div><strong>{entry.model}</strong><span>{entry.status}</span></div><small>{new Date(entry.created_at).toLocaleString()} · Round {entry.round} · {entry.duration_ms} ms{entry.usage?.total_tokens ? ` · ${entry.usage.total_tokens.toLocaleString()} tokens` : ""}</small></div>
      <small className="llm-log-provider">{entry.base_url} · chat {entry.chat_id.slice(0, 8)}</small>
      <details><summary>Request sent ({Array.isArray((entry.request as { messages?: unknown[] })?.messages) ? (entry.request as { messages: unknown[] }).messages.length : 0} messages, tools and context)</summary><pre>{JSON.stringify(entry.request, null, 2)}</pre></details>
      <details><summary>Model response{entry.usage?.prompt_tokens ? ` · ${entry.usage.prompt_tokens} input / ${entry.usage.completion_tokens || 0} output tokens` : ""}</summary><pre>{JSON.stringify(entry.response, null, 2)}</pre></details>
      {entry.error ? <details open><summary>Provider error</summary><pre>{entry.error}</pre></details> : null}
    </article>)}{!loading && entries.length === 0 && !error ? <p className="llm-log-empty">No model exchanges logged yet.</p> : null}</div>
    <footer>Image/video payloads are excluded from the log; entries contain a size marker. Text prompts, tool schemas, and model responses are stored locally for debugging.</footer>
  </section></div>;
}
