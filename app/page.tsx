"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, ChevronRight, CircleHelp, Clapperboard, Clock3, File, MoreHorizontal, Plus, Settings2, X } from "lucide-react";
import AssistantChat from "./AssistantChat";
import LLMRequestLogViewer from "./LLMRequestLogViewer";
import type { ChatSummary } from "@/lib/asset-store";

const VideoPreview = dynamic(() => import("./VideoPreview"), { ssr: false });

export default function Home() {
  const [busy, setBusy] = useState(false);
  const [runStatus, setRunStatus] = useState("Ready");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [provider, setProvider] = useState({ baseURL: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: "" });
  const [serverKeyConfigured, setServerKeyConfigured] = useState(false);
  const [providerSaveBusy, setProviderSaveBusy] = useState(false);
  const [providerMessage, setProviderMessage] = useState("");
  const [clearProviderKey, setClearProviderKey] = useState(false);
  const [llmLogsOpen, setLlmLogsOpen] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string; type: string } | null>(null);
  const [chatId, setChatId] = useState("");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [comfyUrl, setComfyUrl] = useState("http://127.0.0.1:8188");
  const [comfyConnection, setComfyConnection] = useState<{ configured: boolean; connected: boolean; managed_proxy?: boolean; detail?: string }>({ configured: false, connected: false });
  const [comfyBusy, setComfyBusy] = useState(false);
  const [comfyMessage, setComfyMessage] = useState("");
  const [trackedRuns, setTrackedRuns] = useState<Array<{ id: string; workflow_id?: string; status: string; progress: number; message?: string }>>([]);

  const refreshChats = useCallback(async () => {
    const response = await fetch("/api/chats");
    if (!response.ok) return;
    const data = await response.json();
    setChats(data.chats || []);
  }, []);

  const handleChatsChanged = useCallback(() => { void refreshChats(); }, [refreshChats]);

  const createChat = useCallback(async () => {
    const id = crypto.randomUUID();
    const response = await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (!response.ok) throw new Error("Could not start a new chat.");
    localStorage.setItem("vfxguru-active-chat", id);
    setChatId(id);
    setRunStatus("Ready");
    await refreshChats();
  }, [refreshChats]);

  const selectChat = useCallback((id: string) => {
    localStorage.setItem("vfxguru-active-chat", id);
    setChatId(id);
    setRunStatus("Ready");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initChat = async () => {
      const storedChat = localStorage.getItem("vfxguru-active-chat") || crypto.randomUUID();
      const response = await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: storedChat }) });
      if (!response.ok) throw new Error("Could not restore the active chat.");
      if (cancelled) return;
      localStorage.setItem("vfxguru-active-chat", storedChat);
      setChatId(storedChat);
      void refreshChats();
    };
    void initChat().catch(() => setRunStatus("Could not load chats"));
    void fetch("/api/config").then((response) => response.json()).then((config) => {
      setServerKeyConfigured(Boolean(config.keyConfigured));
      setProvider({ baseURL: config.baseURL, model: config.model, apiKey: "" });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [refreshChats]);

  useEffect(() => {
    if (!chatId) { setTrackedRuns([]); return; }
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/runs`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        if (active) setTrackedRuns(Array.isArray(data.runs) ? data.runs : []);
      } catch { /* Keep the last known tracker state while the service reconnects. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [chatId]);

  async function unpinRun(runId: string) {
    if (!chatId) return;
    await fetch(`/api/chats/${encodeURIComponent(chatId)}/runs`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run_id: runId }) });
    setTrackedRuns((runs) => runs.filter((run) => run.id !== runId));
  }

  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    void Promise.all([fetch("/api/comfy/instance"), fetch("/api/comfy/status")]).then(async ([instanceResponse, statusResponse]) => {
      const [instanceData, statusData] = await Promise.all([instanceResponse.json(), statusResponse.json()]);
      if (cancelled) return;
      const instance = instanceData.instance;
      if (instance?.comfy_url) setComfyUrl(instance.comfy_url);
      setComfyConnection({ configured: Boolean(instanceData.configured), connected: Boolean(statusData.connected), managed_proxy: Boolean(instance?.managed_proxy), detail: statusData.detail });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [settingsOpen]);

  function updateProvider(next: typeof provider) {
    setProvider(next);
    setProviderMessage("");
    if (next.apiKey) setClearProviderKey(false);
  }

  async function saveProvider() {
    setProviderSaveBusy(true);
    setProviderMessage("");
    try {
      const response = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseURL: provider.baseURL, model: provider.model, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}), clearApiKey: clearProviderKey }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save model settings.");
      setProvider({ baseURL: data.baseURL, model: data.model, apiKey: "" });
      setServerKeyConfigured(Boolean(data.keyConfigured));
      setClearProviderKey(false);
      setProviderMessage("Settings saved on this computer.");
    } catch (error) {
      setProviderMessage(error instanceof Error ? error.message : "Could not save model settings.");
    } finally { setProviderSaveBusy(false); }
  }

  async function connectComfy() {
    setComfyBusy(true);
    setComfyMessage("Connecting and starting the API proxy…");
    try {
      const response = await fetch("/api/comfy/instance", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: comfyUrl }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not connect to ComfyUI.");
      const statusResponse = await fetch("/api/comfy/status");
      const status = await statusResponse.json();
      setComfyConnection({ configured: true, connected: Boolean(status.connected), managed_proxy: Boolean(data.instance?.managed_proxy), detail: status.detail });
      setComfyMessage(status.connected ? "Connected. The Comfy API proxy is ready for the SDK." : status.detail || "The proxy started, but ComfyUI is not responding yet.");
    } catch (error) {
      setComfyConnection((current) => ({ ...current, connected: false }));
      setComfyMessage(error instanceof Error ? error.message : "Could not connect to ComfyUI.");
    } finally {
      setComfyBusy(false);
    }
  }

  async function disconnectComfy() {
    setComfyBusy(true);
    try {
      const response = await fetch("/api/comfy/instance", { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not disconnect ComfyUI.");
      setComfyConnection({ configured: false, connected: false });
      setComfyMessage("ComfyUI disconnected and the managed proxy stopped.");
      setComfyUrl("http://127.0.0.1:8188");
    } catch (error) {
      setComfyMessage(error instanceof Error ? error.message : "Could not disconnect ComfyUI.");
    } finally {
      setComfyBusy(false);
    }
  }

  const handlePipeline = useCallback(async (action: { pipeline: string; prompt: string }, files: File[]) => {
    setRunStatus("Submitting render");
    const jobResponse = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pipeline: action.pipeline, prompt: action.prompt, inputFiles: files.map((file) => file.name) }) });
    const job = await jobResponse.json();
    if (!jobResponse.ok) throw new Error(job.error || "Could not submit the render job.");
    setRunStatus("Ready");
  }, []);

  const handleChatError = useCallback((message: string) => { setRunStatus("Needs attention"); console.error(message); }, []);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><img src="/open-supercomputer.svg" alt=""/></div><div><strong>Open SuperComputer</strong><span>CREATIVE STUDIO</span></div><button className="icon-button sidebar-collapse" aria-label="Collapse sidebar"><ChevronRight size={16}/></button></div>
        <button className="new-session" onClick={() => { void createChat().catch((error) => handleChatError(error instanceof Error ? error.message : "Could not start a new chat.")); }}><Plus size={17}/> New chat</button>
        <div className="side-label recent-label">CHATS <span className="chat-count">{chats.length}</span></div>
        <div className="chat-list">{chats.map((chat) => <button key={chat.id} className={`recent-item${chat.id === chatId ? " selected" : ""}`} title={chat.title || chat.id} onClick={() => selectChat(chat.id)}><span className="recent-dot"/><span className="chat-title">{chat.title || (chat.message_count ? "Untitled chat" : "New chat")}</span></button>)}{chats.length === 0 ? <div className="chat-empty">Your conversations will appear here.</div> : null}</div>
        <div className="sidebar-bottom"><section className="sidebar-run-status" aria-label="ComfyUI render status"><div className="sidebar-run-heading"><span><Clapperboard size={13}/><strong>Render status</strong></span><small>{trackedRuns.some((run) => ["queued", "running", "pending", "in_progress"].includes(run.status.toLowerCase())) ? "LIVE" : "STATUS"}</small></div>{trackedRuns.length ? <div className="sidebar-run-list">{trackedRuns.slice(0, 3).map((run) => { const progress = Math.max(0, Math.min(100, Number(run.progress || 0) * (Number(run.progress || 0) <= 1 ? 100 : 1))); return <article className="sidebar-run" key={run.id}><div className="sidebar-run-name"><strong title={run.workflow_id || "ComfyUI render"}>{run.workflow_id || "ComfyUI render"}</strong><span className={`pinned-run-status status-${run.status}`}>{run.status.replaceAll("_", " ")}</span><button onClick={() => void unpinRun(run.id)} aria-label="Dismiss render status" title="Dismiss status"><X size={11}/></button></div><div className="pinned-run-progress"><i style={{ width: `${progress}%` }}/></div><small>{run.message || `${Math.round(progress)}% complete`}</small></article>; })}</div> : <p>No tracked renders yet. ComfyUI updates will appear here.</p>}</section><button className="profile"><div className="avatar">♥</div><div className="profile-copy"><strong>In love with</strong><span>Open source ❤️</span></div><MoreHorizontal size={18}/></button></div>
      </aside>
      <section className="workspace">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={14}/><strong>Agent studio</strong></div><div className="top-actions"><div className="connection"><span className="green-dot"/> {provider.apiKey || serverKeyConfigured ? "API configured" : "Model settings"}</div><button className="icon-button" aria-label="Help"><CircleHelp size={17}/></button><button className="icon-button" aria-label="Model settings" onClick={() => setSettingsOpen(true)}><Settings2 size={17}/></button></div></header>
        {chatId ? <AssistantChat key={chatId} chatId={chatId} provider={provider} isBusy={busy} setBusy={(value) => { setBusy(value); setRunStatus(value ? "Thinking" : "Ready"); }} onAction={handlePipeline} onError={handleChatError} onChatsChanged={handleChatsChanged}/> : null}
        <footer className="statusbar"><div><span className="status-pulse"/>{runStatus}<span className="status-sep">·</span><Clock3 size={13}/> Ready for your next idea</div><div><span>All systems operational</span><span className="status-sep">·</span><button>v1.0.0 <ChevronDown size={12}/></button></div></footer>
      </section>
      {settingsOpen ? <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><section className="settings-modal" onClick={(e) => e.stopPropagation()}><div className="settings-heading"><div><span className="settings-kicker">PROVIDER CONFIGURATION</span><h2>Connect a model</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close"><X size={17}/></button></div><p>Use OpenAI or any provider that supports OpenAI Chat Completions.</p><label>Base URL<input value={provider.baseURL} onChange={(e) => updateProvider({ ...provider, baseURL: e.target.value })} placeholder="https://api.openai.com/v1" /></label><label>Model ID<input value={provider.model} onChange={(e) => updateProvider({ ...provider, model: e.target.value })} placeholder="gpt-4.1" /></label><label>API key<input type="password" value={provider.apiKey} onChange={(e) => updateProvider({ ...provider, apiKey: e.target.value })} placeholder={serverKeyConfigured ? "Saved securely · enter to replace" : "sk-…"} autoComplete="new-password" /></label><div className="settings-note">Connection settings are saved locally. The API key is encrypted in the Open SuperComputer data folder and used by the server.</div>{providerMessage ? <div className={`comfy-message${providerMessage.includes("saved") ? " success" : ""}`}>{providerMessage}</div> : null}
        <div className="comfy-connection-panel"><div className="comfy-connection-heading"><div><span className="settings-kicker">LOCAL WORKFLOWS</span><strong>ComfyUI</strong></div><span className={`comfy-state${comfyConnection.connected ? " is-connected" : ""}`}><i/>{comfyConnection.connected ? "Connected" : comfyConnection.configured ? "Unavailable" : "Not connected"}</span></div><label>ComfyUI URL<input value={comfyUrl} onChange={(e) => setComfyUrl(e.target.value)} placeholder="http://127.0.0.1:8188" autoComplete="url" /></label><small>Enter the normal ComfyUI address. Open SuperComputer starts the local API proxy for the SDK automatically. Example: http://127.0.0.1:8188</small>{comfyMessage ? <div className={`comfy-message${comfyConnection.connected ? " success" : ""}`}>{comfyMessage}</div> : comfyConnection.detail ? <div className="comfy-message">{comfyConnection.detail}</div> : null}<div className="comfy-actions"><button disabled={comfyBusy || !comfyUrl.trim()} onClick={() => void connectComfy()}>{comfyBusy ? "Connecting…" : comfyConnection.configured ? "Replace URL" : "Connect"}</button>{comfyConnection.configured ? <button disabled={comfyBusy} onClick={() => void disconnectComfy()}>Disconnect</button> : null}</div></div>
        <div className="settings-actions"><button onClick={() => { updateProvider({ baseURL: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: "" }); setClearProviderKey(true); }}>Reset</button><button onClick={() => { setSettingsOpen(false); setLlmLogsOpen(true); }}>Request log</button><button className="settings-save" disabled={providerSaveBusy} onClick={() => void saveProvider()}>{providerSaveBusy ? "Saving…" : "Save settings"}</button><button onClick={() => setSettingsOpen(false)}>Done</button></div></section></div> : null}
      {llmLogsOpen ? <LLMRequestLogViewer chatId={chatId} onClose={() => setLlmLogsOpen(false)}/> : null}
      {preview ? <div className="modal-backdrop preview-backdrop" onClick={() => setPreview(null)}><section className="preview-modal" onClick={(e) => e.stopPropagation()}><div className="preview-heading"><strong>{preview.name}</strong><button className="icon-button" onClick={() => setPreview(null)} aria-label="Close preview"><X size={17}/></button></div>{preview.type.startsWith("image/") ? <img className="preview-image" src={preview.url} alt={preview.name}/> : preview.type.startsWith("video/") ? <VideoPreview src={preview.url}/> : preview.type.startsWith("audio/") ? <audio className="preview-audio" src={preview.url} controls autoPlay/> : <div className="preview-unavailable"><File size={28}/><p>This file is attached, but the browser cannot preview this format.</p><a href={preview.url} download={preview.name}>Download file</a><small>EXR and DPX previews need a render-format decoder or a server-generated proxy image.</small></div>}</section></div> : null}
    </main>
  );
}
