"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, unstable_useComposerInput, useAui, useLocalRuntime, type ChatModelAdapter, type ThreadHistoryAdapter, type ThreadMessage } from "@assistant-ui/react";
import { ArrowUp, File as FileIcon, Image as ImageIcon, Library, Paperclip, Pencil, Sparkles, StopCircle, Video, X } from "lucide-react";
import MediaEditCard from "./MediaEditCard";

type Props = { provider: { baseURL: string; model: string; apiKey: string }; chatId: string; setBusy: (busy: boolean) => void; isBusy: boolean; onAction: (action: { pipeline: string; prompt: string }, files: File[]) => Promise<void>; onError: (message: string) => void; onChatsChanged: () => void };
type MentionAsset = { id: string; original_name: string; mime_type: string; size: number; url: string; hasScene?: boolean; created_at?: string; tags?: string[]; characters?: Array<{ id: string; name: string; description: string | null; appearance: string | null }>; mention: string };
type ProgressUpdate = { id: string; text: string };
const AssetIdContext = createContext<{ chatId: string; assets: MentionAsset[] }>({ chatId: "", assets: [] });
const textOf = (message: ThreadMessage) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

export default function AssistantChat({ provider, chatId, setBusy, isBusy, onAction, onError, onChatsChanged }: Props) {
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const [interimText, setInterimText] = useState("");
  const [interimActivity, setInterimActivity] = useState("");
  const [interimUpdates, setInterimUpdates] = useState<ProgressUpdate[]>([]);
  const [libraryAssets, setLibraryAssets] = useState<MentionAsset[]>([]);
  const mentionAssets = useMemo(() => assignMentions(libraryAssets), [libraryAssets]);
  const refreshLibraryAssets = useCallback(async () => {
    const response = await fetch(`/api/assets?chatId=${encodeURIComponent(chatId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load the local media library.");
    const assets = data.assets || [];
    setLibraryAssets(assets);
    return assignMentions(assets);
  }, [chatId]);
  useEffect(() => { void refreshLibraryAssets().catch((cause) => onError(cause instanceof Error ? cause.message : "Could not load the local media library.")); }, [onError, refreshLibraryAssets]);

  const adapter = useMemo<ChatModelAdapter>(() => ({
    async run({ messages, abortSignal }) {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      if (!lastUser) return { content: [{ type: "text", text: "Send a message to get started." }] };
      const history = messages.slice(0, messages.indexOf(lastUser)).filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ role: message.role, content: textOf(message) }));
      const body = new FormData();
      const message = textOf(lastUser) || "Please inspect these attached assets.";
      body.set("message", message);
      body.set("history", JSON.stringify(history));
      body.set("chatId", chatId);
      const requestId = crypto.randomUUID();
      const progressUpdates: ProgressUpdate[] = [];
      const seenProgressUpdateIds = new Set<string>();
      body.set("requestId", requestId);
      body.set("baseURL", provider.baseURL); body.set("model", provider.model); body.set("apiKey", provider.apiKey);
      body.set("assetRefs", JSON.stringify(mentionAssets.map((asset) => ({ mention: asset.mention, id: asset.id }))));
      setBusy(true);
      setInterimText("Thinking…");
      setInterimActivity("");
      setInterimUpdates([]);
      let pollProgress = true;
      const progressPoll = (async () => {
        while (pollProgress) {
          try {
            const progressResponse = await fetch(`/api/chat/progress?requestId=${encodeURIComponent(requestId)}`, { signal: abortSignal });
            if (progressResponse.ok) {
              const progressData = await progressResponse.json();
              if (typeof progressData.text === "string" && progressData.text) setInterimText(progressData.text);
              setInterimActivity(typeof progressData.activity === "string" ? progressData.activity : "");
              if (Array.isArray(progressData.checkpoints)) {
                for (const checkpoint of progressData.checkpoints as ProgressUpdate[]) {
                  if (!checkpoint?.id || typeof checkpoint.text !== "string" || seenProgressUpdateIds.has(checkpoint.id)) continue;
                  seenProgressUpdateIds.add(checkpoint.id);
                  progressUpdates.push(checkpoint);
                  setInterimUpdates((current) => [...current, checkpoint]);
                }
              }
            }
          } catch { if (abortSignal.aborted) break; }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      })();
      try {
        const response = await fetch("/api/chat", { method: "POST", body, signal: abortSignal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Request failed");
        if (Array.isArray(data.progressUpdates)) {
          for (const update of data.progressUpdates as ProgressUpdate[]) {
            if (!update?.id || typeof update.text !== "string" || seenProgressUpdateIds.has(update.id)) continue;
            seenProgressUpdateIds.add(update.id);
            progressUpdates.push(update);
          }
        }
        const outputAssets = Array.isArray(data.mediaAssets) ? data.mediaAssets as Array<{ id: string; original_name: string; mime_type: string; url: string }> : [];
        if (outputAssets.length) await refreshLibraryAssets();
        if (data.action?.type === "run_pipeline") {
          try { await onAction(data.action, []); }
          catch (error) { onError(error instanceof Error ? error.message : "Pipeline submission failed."); }
        }
        return { content: [
          ...progressUpdates.map((update) => ({ type: "data" as const, name: "progress-update", data: update })),
          { type: "text", text: data.text || "I’m ready to help with this shot." },
          ...outputAssets.map((asset) => ({ type: "data" as const, name: "media-output", data: asset })),
        ] };
      } catch (error) {
        if (abortSignal.aborted) return { content: [
          ...progressUpdates.map((update) => ({ type: "data" as const, name: "progress-update", data: update })),
          { type: "text", text: "Stopped." },
        ] };
        const message = error instanceof Error ? error.message : "Something went wrong.";
        onError(message);
        return { content: [
          ...progressUpdates.map((update) => ({ type: "data" as const, name: "progress-update", data: update })),
          { type: "text", text: `I couldn’t complete that request: ${message}` },
        ] };
      } finally { pollProgress = false; await progressPoll; setInterimText(""); setInterimActivity(""); setInterimUpdates([]); setBusy(false); }
    },
  }), [chatId, mentionAssets, onAction, onError, provider, refreshLibraryAssets, setBusy]);

  const historyAdapter = useMemo<ThreadHistoryAdapter>(() => ({
    scopeId: `chat:${chatId}`,
    async load() {
      const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`);
      if (!response.ok) throw new Error("Could not load this chat's history.");
      return response.json();
    },
    async append(item) {
      const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
      if (!response.ok) throw new Error("Could not save this chat's history.");
      onChatsChanged();
    },
    async update(item) {
      const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
      if (!response.ok) throw new Error("Could not update this chat's history.");
      onChatsChanged();
    },
    async delete(items) {
      const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
      if (!response.ok) throw new Error("Could not update this chat's history.");
      onChatsChanged();
    },
  }), [chatId, onChatsChanged]);
  const runtime = useLocalRuntime(adapter, { adapters: { history: historyAdapter } });
  return <AssistantRuntimeProvider runtime={runtime}><AssetIdContext.Provider value={{ chatId, assets: mentionAssets }}><div className="assistant-chat"><ThreadPrimitive.Root className="assistant-thread">
    <ThreadPrimitive.Viewport className="assistant-viewport"><ThreadPrimitive.Empty><div className="assistant-welcome"><span><Sparkles size={19}/></span><h1>Your creative co-pilot<br/>for <em>every frame.</em></h1><p>Attach an image or video to inspect and edit it right here in chat.</p><div className="assistant-suggestions"><ThreadPrimitive.Suggestion prompt="Analyze this shot and suggest a grade." method="replace"><Video size={15}/> Analyze this shot</ThreadPrimitive.Suggestion><ThreadPrimitive.Suggestion prompt="Create a clean crop for this image." method="replace"><ImageIcon size={15}/> Crop an image</ThreadPrimitive.Suggestion></div></div></ThreadPrimitive.Empty><div className="assistant-message-list">
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage}}/>{isBusy ? interimUpdates.map((update) => <ProgressUpdateMessage key={update.id} update={update}/>) : null}{isBusy ? <div className="thinking"><span className="thinking-mark"><Sparkles size={14}/></span><div><strong>Open SuperComputer</strong><span className="thinking-interim">{interimText || "Thinking…"}{interimActivity ? <small className="thinking-activity">{interimActivity}</small> : null}</span><span className="thinking-dots"><i/><i/><i/></span></div></div> : null}
    </div></ThreadPrimitive.Viewport>
    <div className="assistant-composer-wrap"><ComposerPrimitive.Root className="assistant-composer"><MentionComposerInput inputRef={composerInputRef} assets={mentionAssets} refreshAssets={refreshLibraryAssets}/><div className="assistant-composer-bottom"><div className="assistant-composer-tools"><MediaAttachButton chatId={chatId} inputRef={composerInputRef} refreshAssets={refreshLibraryAssets} onError={onError}/><LibraryPicker chatId={chatId} inputRef={composerInputRef} refreshAssets={refreshLibraryAssets} onError={onError}/><span className="assistant-attach-hint">Images and video</span></div>{isBusy ? <StopGenerationButton/> : <ComposerPrimitive.Send className="send-button"><ArrowUp size={16}/></ComposerPrimitive.Send>}</div></ComposerPrimitive.Root><div className="composer-foot"><span><kbd>↵</kbd> to send <kbd>⇧ ↵</kbd> for new line</span><span><Sparkles size={12}/> Assets save to your local library</span></div></div>
    </ThreadPrimitive.Root></div></AssetIdContext.Provider></AssistantRuntimeProvider>;
}

function StopGenerationButton() {
  const aui = useAui();
  return <button type="button" className="stop-generation-button" onClick={() => aui.thread.cancelRun()} title="Stop the assistant response. An already submitted ComfyUI render will continue." aria-label="Stop assistant response"><StopCircle size={15}/><span>Stop</span></button>;
}

function UserMessage() { return <MessagePrimitive.Root className="assistant-message user"><div className="message-avatar"><span>JK</span></div><div className="message-body"><div className="message-meta"><strong>You</strong><span>just now</span></div><MessagePrimitive.Parts>{({ part }) => part.type === "text" ? <MentionText text={part.text}/> : null}</MessagePrimitive.Parts></div></MessagePrimitive.Root>; }
function AssistantMessage() { return <MessagePrimitive.Root className="assistant-message assistant"><div className="message-avatar"><Sparkles size={15}/></div><div className="message-body"><div className="message-meta"><strong>Open SuperComputer</strong><span>just now</span></div><MessagePrimitive.Parts>{({ part }) => part.type === "text" ? <MentionText text={part.text}/> : part.type === "data" && part.name === "media-output" ? <GeneratedMediaOutput key={part.id} asset={part.data as { id: string; original_name: string; mime_type: string; url: string }}/> : part.type === "data" && part.name === "progress-update" ? <ProgressUpdateMessage key={part.id} update={part.data as ProgressUpdate} persistent/> : null}</MessagePrimitive.Parts></div></MessagePrimitive.Root>; }

function ProgressUpdateMessage({ update, persistent = false }: { update: ProgressUpdate; persistent?: boolean }) {
  if (persistent) return <div className="progress-update-persistent"><div className="progress-update-label">Status update</div><MentionText text={update.text}/></div>;
  return <div className="assistant-message assistant progress-update"><div className="message-avatar"><Sparkles size={15}/></div><div className="message-body"><div className="message-meta"><strong>Open SuperComputer</strong><span>Status update</span></div><MentionText text={update.text}/></div></div>;
}

function GeneratedMediaOutput({ asset }: { asset: { id: string; original_name: string; mime_type: string; url: string } }) {
  const { chatId } = useContext(AssetIdContext);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void fetch(asset.url).then(async (response) => {
      if (!response.ok) throw new Error("Could not load the generated media asset.");
      const blob = await response.blob();
      if (active) setFile(new File([blob], asset.original_name, { type: asset.mime_type || blob.type }));
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load the generated media asset."); });
    return () => { active = false; };
  }, [asset.id, asset.mime_type, asset.original_name, asset.url]);
  if (error) return <p className="media-editor-error">{error}</p>;
  if (!file) return <div className="image-editor-loading">Loading generated media…</div>;
  return <MediaEditCard file={file} id={`generated-${asset.id}`} chatId={chatId} assetId={asset.id} compact/>;
}
function MentionComposerInput({ inputRef, assets, refreshAssets }: { inputRef: React.RefObject<HTMLTextAreaElement | null>; assets: MentionAsset[]; refreshAssets: () => Promise<MentionAsset[]> }) {
  const { chatId } = useContext(AssetIdContext);
  const { value, setText } = unstable_useComposerInput();
  const menuRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const mentionStart = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [editorAsset, setEditorAsset] = useState<MentionAsset | null>(null);
  const filtered = assets.filter((asset) => asset.mention.slice(1).includes(query.toLowerCase()) || asset.original_name.toLowerCase().includes(query.toLowerCase()));
  const composerParts = value.split(/(@(?:image|video|audio|file)\d+\b)/g);

  function moveActiveOption(direction: -1 | 1) {
    const nextIndex = (activeIndex + direction + filtered.length) % filtered.length;
    setActiveIndex(nextIndex);
    requestAnimationFrame(() => {
      const menu = menuRef.current;
      const option = menu?.querySelector<HTMLElement>(`[data-mention-index="${nextIndex}"]`);
      if (!menu || !option) return;
      const menuBounds = menu.getBoundingClientRect();
      const optionBounds = option.getBoundingClientRect();
      if (optionBounds.bottom > menuBounds.bottom) menu.scrollTop += optionBounds.bottom - menuBounds.bottom;
      else if (optionBounds.top < menuBounds.top) menu.scrollTop -= menuBounds.top - optionBounds.top;
    });
  }

  function syncPicker(text: string, cursor: number) {
    const match = text.slice(0, cursor).match(/(?:^|\s)@([\w-]*)$/);
    if (!match) { mentionStart.current = null; setOpen(false); return; }
    mentionStart.current = cursor - match[1].length - 1;
    setQuery(match[1].toLowerCase());
    setActiveIndex(0);
    setOpen(true);
  }

  function selectAsset(asset: MentionAsset) {
    const input = inputRef.current;
    const start = mentionStart.current;
    if (!input || start === null) return;
    const cursor = input.selectionStart;
    const next = `${value.slice(0, start)}${asset.mention} ${value.slice(cursor)}`;
    const nextCursor = start + asset.mention.length + 1;
    setText(next);
    setOpen(false);
    mentionStart.current = null;
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(nextCursor, nextCursor); });
  }

  function handleComposerClick(event: MouseEvent<HTMLTextAreaElement>) {
    const bounds = { x: event.clientX, y: event.clientY };
    const clickedChip = [...(overlayRef.current?.querySelectorAll<HTMLElement>("[data-mention-asset-id]") || [])].find((chip) => {
      const rect = chip.getBoundingClientRect();
      return bounds.x >= rect.left && bounds.x <= rect.right && bounds.y >= rect.top && bounds.y <= rect.bottom;
    });
    const asset = clickedChip?.dataset.mentionAssetId ? assets.find((item) => item.id === clickedChip.dataset.mentionAssetId) : undefined;
    if (asset) { setOpen(false); setEditorAsset(asset); return; }
    syncPicker(event.currentTarget.value, event.currentTarget.selectionStart);
  }

  return <div className={`composer-input-wrap${composerParts.some((part) => assets.some((asset) => asset.mention === part)) ? " has-mention-overlay" : ""}`}>
    <ComposerPrimitive.Input ref={inputRef} placeholder="Describe your creative vision... Use @ to mention media" rows={1}
      onClick={handleComposerClick}
      onKeyUp={(event) => { syncPicker(event.currentTarget.value, event.currentTarget.selectionStart); if (event.key === "@") void refreshAssets().catch(() => undefined); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); return; }
        if (!open || !filtered.length) return;
        if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); moveActiveOption(1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); moveActiveOption(-1); }
        else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); selectAsset(filtered[activeIndex] || filtered[0]); }
      }}
      onChange={(event) => { syncPicker(event.currentTarget.value, event.currentTarget.selectionStart); }} />
    {composerParts.some((part) => assets.some((asset) => asset.mention === part)) ? <div ref={overlayRef} className="composer-mention-overlay" aria-hidden="true">{composerParts.map((part, index) => {
      const asset = assets.find((item) => item.mention === part);
      const editable = asset && (asset.mime_type.startsWith("image/") || asset.mime_type.startsWith("video/"));
      return editable ? <span className="composer-mention-chip" data-mention-asset-id={asset.id} key={`${part}-${index}`} title={`Click to edit ${asset.original_name}`}>{part}</span> : <span key={`${part}-${index}`}>{part}</span>;
    })}</div> : null}
    {editorAsset ? <AssetEditLauncher asset={editorAsset} chatId={chatId} onClose={() => setEditorAsset(null)}/> : null}
    {open ? <div ref={menuRef} className="asset-mention-menu" role="listbox" aria-label="Mention a media asset">
      <div className="asset-mention-menu-title">Mention media <span>Choose an asset to insert its reference</span></div>
      {filtered.map((asset, index) => <button type="button" role="option" data-mention-index={index} aria-selected={index === activeIndex} key={asset.id} onMouseDown={(event) => event.preventDefault()} onClick={() => selectAsset(asset)}>
        <AssetThumbnail asset={asset}/><span><strong>{asset.mention}</strong><small>{asset.original_name}</small></span><em>{asset.mime_type.split("/")[0]}</em>
      </button>)}
      {filtered.length === 0 ? <p>No matching local assets. Add media with Attach or Media library.</p> : null}
      {assets.length === 0 ? <button type="button" className="asset-mention-refresh" onMouseDown={(event) => event.preventDefault()} onClick={() => void refreshAssets().catch(() => undefined)}>Refresh media library</button> : null}
    </div> : null}
  </div>;
}

function assignMentions(assets: Omit<MentionAsset, "mention">[]): MentionAsset[] {
  const sorted = [...assets].sort((left, right) => (left.created_at || "").localeCompare(right.created_at || "") || left.id.localeCompare(right.id));
  const counters: Record<string, number> = {};
  return sorted.map((asset) => {
    const kind = asset.mime_type.startsWith("image/") ? "image" : asset.mime_type.startsWith("video/") ? "video" : asset.mime_type.startsWith("audio/") ? "audio" : "file";
    counters[kind] = (counters[kind] || 0) + 1;
    return { ...asset, mention: `@${kind}${counters[kind]}` };
  });
}

function AssetThumbnail({ asset }: { asset: MentionAsset }) {
  return <span className="asset-mention-thumb">{asset.mime_type.startsWith("image/") ? <img src={asset.url} alt=""/> : asset.mime_type.startsWith("video/") ? <video src={asset.url}/> : <FileIcon size={16}/>}</span>;
}

function MentionText({ text }: { text: string }) {
  const { assets } = useContext(AssetIdContext);
  const parts = text.split(/(@(?:image|video|audio|file)\d+\b)/g);
  return <div className="message-content">{parts.map((part, index) => {
    const asset = assets.find((item) => item.mention === part);
    return asset ? <MentionAssetToken key={`${part}-${index}`} asset={asset}/> : <span key={index}>{part}</span>;
  })}</div>;
}

function MentionAssetToken({ asset }: { asset: MentionAsset }) {
  const { chatId } = useContext(AssetIdContext);
  const [editorRequested, setEditorRequested] = useState(false);
  const editable = asset.mime_type.startsWith("image/") || asset.mime_type.startsWith("video/");
  return <span className="asset-mention-token-wrap">
    {editable ? <button type="button" className="asset-mention-token" title={`Open ${asset.original_name} in editor`} onClick={() => setEditorRequested(true)}>{asset.mention}<Pencil size={11}/></button> : <span className="asset-mention-token asset-mention-token-static" title={`${asset.original_name} · ${asset.mime_type}`}>{asset.mention}</span>}
    {editorRequested && editable ? <AssetEditLauncher asset={asset} chatId={chatId} onClose={() => setEditorRequested(false)}/> : null}
  </span>;
}

function AssetEditLauncher({ asset, chatId, onClose }: { asset: MentionAsset; chatId: string; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      setError("");
      try {
        const response = await fetch(asset.url);
        if (!response.ok) throw new Error("Could not load this asset from the local library.");
        const blob = await response.blob();
        if (asset.mime_type.startsWith("video/")) {
          const linkResponse = await fetch(`/api/assets/${asset.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }) });
          if (!linkResponse.ok) throw new Error("Could not add this video to the current chat's media library.");
        }
        if (active) setFile(new File([blob], asset.original_name, { type: asset.mime_type }));
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Could not open this asset."); }
    })();
    return () => { active = false; };
  }, [asset.id, asset.mime_type, asset.original_name, asset.url, chatId]);
  return <>{error ? <small className="asset-mention-error">{error}</small> : null}{file ? <MediaEditCard key={asset.id} compact editorOnly autoOpenEditor id={asset.id} chatId={chatId} assetId={asset.id} file={file} onEditorClose={onClose}/> : error ? <small className="asset-mention-error">Could not open editor</small> : <small className="asset-mention-error">Loading editor…</small>}</>;
}

function appendMentionsToDraft(aui: ReturnType<typeof useAui>, inputRef: React.RefObject<HTMLTextAreaElement | null>, mentions: string[]) {
  const composer = aui.thread().composer();
  const current = composer.getState().text || "";
  const separator = current && !/\s$/.test(current) ? " " : "";
  const next = `${current}${separator}${mentions.join(" ")} `;
  composer.setText(next);
  requestAnimationFrame(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(next.length, next.length);
  });
}

function MediaAttachButton({ chatId, inputRef, refreshAssets, onError }: { chatId: string; inputRef: React.RefObject<HTMLTextAreaElement | null>; refreshAssets: () => Promise<MentionAsset[]>; onError: (message: string) => void }) {
  const aui = useAui();
  const pickerRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function saveFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const savedIds: string[] = [];
      for (const file of Array.from(files)) {
        if (file.size > 25 * 1024 * 1024) throw new Error("Each file must be 25 MB or smaller.");
        const form = new FormData();
        form.set("chatId", chatId);
        form.set("file", file);
        const response = await fetch("/api/assets", { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Could not save ${file.name} to the media library.`);
        savedIds.push(data.asset.id);
      }
      const assets = await refreshAssets();
      const mentions = savedIds.map((id) => assets.find((asset) => asset.id === id)?.mention).filter((mention): mention is string => Boolean(mention));
      if (mentions.length) appendMentionsToDraft(aui, inputRef, mentions);
      else throw new Error("The media was saved, but its mention could not be added to the draft.");
    } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not add media to the chat draft."); }
    finally { setBusy(false); if (pickerRef.current) pickerRef.current.value = ""; }
  }
  return <><input ref={pickerRef} className="media-attach-input" type="file" accept="image/*,video/*,audio/*,.pdf,.txt,.md,.json,.zip,.mov,.mp4,.exr,.dpx,.mxf,.tif,.tiff" multiple onChange={(event) => void saveFiles(event.currentTarget.files)}/><button type="button" disabled={busy} onClick={() => pickerRef.current?.click()}><Paperclip size={15}/><span>{busy ? "Saving…" : "Attach"}</span></button></>;
}

function LibraryPicker({ chatId, inputRef, refreshAssets, onError }: { chatId: string; inputRef: React.RefObject<HTMLTextAreaElement | null>; refreshAssets: () => Promise<MentionAsset[]>; onError: (message: string) => void }) {
  const aui = useAui();
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<{ id: string; original_name: string; mime_type: string; size: number; url: string; tags?: string[]; characters?: Array<{ name: string }> }[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  async function showLibrary() {
    setOpen(true); setError("");
    try {
      const response = await fetch(`/api/assets?chatId=${encodeURIComponent(chatId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open the media library.");
      setAssets(data.assets || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the media library."); }
  }
  async function attach(asset: typeof assets[number]) {
    setBusyId(asset.id); setError("");
    try {
      const linked = await fetch(`/api/assets/${asset.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }) });
      if (!linked.ok) throw new Error("Could not add this asset to the current chat.");
      const assigned = await refreshAssets();
      const mention = assigned.find((item) => item.id === asset.id)?.mention;
      if (!mention) throw new Error("The asset was linked, but its mention could not be added to the draft.");
      appendMentionsToDraft(aui, inputRef, [mention]);
      setOpen(false);
    } catch (cause) { const message = cause instanceof Error ? cause.message : "Could not add this media reference."; setError(message); onError(message); }
    finally { setBusyId(""); }
  }
  const libraryModal = open ? createPortal(<div className="media-library-backdrop" onClick={() => setOpen(false)}><section className="media-library-dialog" onClick={(event) => event.stopPropagation()}><header><div><strong>Media library</strong><span>Choose media to reference in your prompt</span></div><button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close media library"><X size={16}/></button></header>{error ? <p className="media-library-error">{error}</p> : null}<div className="media-library-grid">{assets.map((asset) => <button type="button" key={asset.id} disabled={Boolean(busyId)} onClick={() => void attach(asset)}><div>{asset.mime_type.startsWith("image/") ? <img src={asset.url} alt=""/> : asset.mime_type.startsWith("video/") ? <video src={asset.url}/> : <FileIcon size={24}/>}</div><strong>{asset.original_name}</strong>{asset.characters?.length ? <small className="media-library-tags">Character: {asset.characters.map((character) => character.name).join(", ")}</small> : null}{asset.tags?.length ? <small className="media-library-tags">Tags: {asset.tags.join(", ")}</small> : null}<small>{(asset.size / 1024 / 1024).toFixed(1)} MB {busyId === asset.id ? "· Adding mention…" : "· Insert mention"}</small></button>)}</div>{assets.length === 0 && !error ? <p className="media-library-empty">No saved assets yet. Attach an image or video to add it.</p> : null}</section></div>, document.body) : null;
  return <><button type="button" onClick={() => void showLibrary()}><Library size={15}/><span>Media library</span></button>{libraryModal}</>;
}
