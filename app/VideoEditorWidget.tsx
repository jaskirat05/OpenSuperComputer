"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorProvider, Preview, Timeline, createDefaultDemuxerFactory, deserializeProject, exportVideo, importUrl, relinkProjectMedia, mediaLibraryStore, useTimelineEngine, type MediaAsset, type Project } from "@elah/editor";
import { Camera, Check, Clapperboard, Download, Film, LoaderCircle, Plus, X } from "lucide-react";

type Props = { assetId: string; chatId: string; fileName: string; onClose: () => void };
type LibraryAsset = { id: string; original_name: string; mime_type: string; size: number; url: string };
const FPS = 30;
const TRACKS = [
  { kind: "video" as const, name: "Video" },
  { kind: "elements" as const, name: "Titles & graphics" },
  { kind: "audio" as const, name: "Audio" },
];
const demuxerFactory = createDefaultDemuxerFactory();

export default function VideoEditorWidget(props: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(<div className="video-editor-backdrop"><section className="video-editor-dialog" aria-label="Video editor">
    <header className="video-editor-heading"><div><Clapperboard size={17}/><span><strong>Edit video</strong><small>{props.fileName} · saved in local media library</small></span></div><button type="button" className="icon-button" onClick={props.onClose} aria-label="Close video editor"><X size={17}/></button></header>
    <EditorProvider key={props.assetId} fps={FPS} stage={{ width: 1920, height: 1080 }} initialTracks={TRACKS}>
      <VideoEditorContents {...props}/>
    </EditorProvider>
  </section></div>, document.body);
}

function VideoEditorContents({ assetId, chatId, fileName, onClose }: Props) {
  const engine = useTimelineEngine();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [busy, setBusy] = useState("Loading project…");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [exportProgress, setExportProgress] = useState<{ frame: number; totalFrames: number } | null>(null);
  const [capturingFrame, setCapturingFrame] = useState<"first" | "last" | null>(null);

  const persistProject = useCallback(async (project: Project) => {
    const response = await fetch(`/api/assets/${assetId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: { kind: "elah-video-project", version: 1, project } }),
    });
    if (!response.ok) throw new Error("Could not save the video project to the local library.");
  }, [assetId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [assetResponse, libraryResponse] = await Promise.all([
          fetch(`/api/assets/${assetId}?metadata=1`),
          fetch(`/api/assets?chatId=${encodeURIComponent(chatId)}`),
        ]);
        const assetData = await assetResponse.json();
        const libraryData = await libraryResponse.json();
        if (!assetResponse.ok) throw new Error(assetData.error || "Could not load the video asset.");
        if (!libraryResponse.ok) throw new Error(libraryData.error || "Could not load the media library.");
        const items = (libraryData.assets || []) as LibraryAsset[];
        if (!active) return;
        setLibrary(items.filter((item) => item.mime_type.startsWith("video/") || item.mime_type.startsWith("audio/") || item.mime_type.startsWith("image/")));

        const stored = assetData.asset?.scene;
        const project = stored?.kind === "elah-video-project" ? stored.project as Project : null;
        const media = project
          ? Array.from(new Set(Object.values(project.clips).flat().flatMap((clip) => clip.src ? [clip.src] : [])))
          : [`/api/assets/${assetId}`];
        const byUrl = new Map<string, MediaAsset>();
        for (const src of media) {
          const item = items.find((entry) => entry.url === src || `/api/assets/${entry.id}` === src);
          if (!item) continue;
          const kind = item.mime_type.startsWith("audio/") ? "audio" : item.mime_type.startsWith("image/") ? "image" : "video";
          setBusy(`Reading ${item.original_name} metadata…`);
          const mediaAsset = await importUrl(item.url, { name: item.original_name, kind });
          byUrl.set(src, mediaAsset);
        }
        if (!active) return;
        if (project) {
          setBusy("Restoring timeline…");
          deserializeProject(engine, JSON.stringify(project));
          const relinked = relinkProjectMedia(engine.getProject(), Object.values(mediaLibraryStore.getState().assets));
          if (relinked.relinked) engine.loadProject(relinked.project, { transport: "rewind", history: "reset" });
        } else {
          const sourceUrl = `/api/assets/${assetId}`;
          setBusy("Preparing timeline…");
          const mediaAsset = byUrl.get(sourceUrl) || await importUrl(sourceUrl, { name: fileName, kind: "video" });
          let track = engine.getProject().tracks.find((candidate) => candidate.kind === "video");
          if (!track) track = engine.addTrack("video", { name: "Video" });
          engine.addClip({ type: "video", trackId: track.id, src: mediaAsset.src, assetId: mediaAsset.id, name: fileName, startFrame: 0, durationFrames: Math.max(1, Math.ceil(mediaAsset.durationSec * FPS)) });
        }
        setBusy("");
        setStatus("Project ready");
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : "Could not initialize the video editor."); setBusy(""); }
      }
    })();
    return () => { active = false; if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [assetId, chatId, engine, fileName]);

  useEffect(() => {
    const onChange = (project: Project) => {
      if (busy || error) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persistProject(project).then(() => setStatus("Saved to local library")).catch((cause) => setError(cause instanceof Error ? cause.message : "Project save failed."));
      }, 700);
    };
    engine.on("change", onChange);
    return () => engine.off("change", onChange);
  }, [busy, engine, error, persistProject]);

  async function addAsset(item: LibraryAsset) {
    setError(""); setStatus(`Loading ${item.original_name}…`);
    try {
      const kind = item.mime_type.startsWith("audio/") ? "audio" : item.mime_type.startsWith("image/") ? "image" : "video";
      const mediaAsset = await importUrl(item.url, { name: item.original_name, kind });
      const trackKind = kind === "audio" ? "audio" : "video";
      let track = engine.getProject().tracks.find((candidate) => candidate.kind === trackKind);
      if (!track) track = engine.addTrack(trackKind, { name: trackKind === "audio" ? "Audio" : "Video" });
      const existingClips = engine.getProject().clips[track.id] || [];
      const startFrame = existingClips.reduce((end, clip) => Math.max(end, clip.startFrame + clip.durationFrames), 0);
      engine.addClip({ type: kind, trackId: track.id, src: mediaAsset.src, assetId: mediaAsset.id, name: item.original_name, startFrame, durationFrames: Math.max(1, Math.ceil(mediaAsset.durationSec * FPS)) } as Parameters<typeof engine.addClip>[0]);
      setStatus("Media added to timeline");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this asset."); }
  }

  async function saveNow() {
    setError(""); setStatus("Saving…");
    try { await persistProject(engine.getProject()); setStatus("Saved to local library"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Project save failed."); }
  }

  async function extractFrame(edge: "first" | "last") {
    setError(""); setCapturingFrame(edge); setStatus(`Extracting ${edge} frame…`);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    try {
      video.src = `/api/assets/${assetId}`;
      await new Promise<void>((resolve, reject) => {
        const onMetadata = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("Could not read video metadata for frame extraction.")); };
        const cleanup = () => { video.removeEventListener("loadedmetadata", onMetadata); video.removeEventListener("error", onError); };
        video.addEventListener("loadedmetadata", onMetadata, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.load();
      });
      const time = edge === "first" ? 0 : Math.max(0, video.duration - 1 / FPS);
      if (time > 0) {
        await new Promise<void>((resolve, reject) => {
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error("Could not seek to the requested video frame.")); };
          const cleanup = () => { video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError); };
          video.addEventListener("seeked", onSeeked, { once: true });
          video.addEventListener("error", onError, { once: true });
          video.currentTime = time;
        });
      } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await new Promise<void>((resolve, reject) => {
          const onData = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error("Could not decode the requested video frame.")); };
          const cleanup = () => { video.removeEventListener("loadeddata", onData); video.removeEventListener("error", onError); };
          video.addEventListener("loadeddata", onData, { once: true });
          video.addEventListener("error", onError, { once: true });
        });
      }

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context || !canvas.width || !canvas.height) throw new Error("The video frame could not be rendered.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not encode the extracted frame.")), "image/png"));
      const baseName = fileName.replace(/\.[^.]+$/, "");
      const outputName = `${baseName}-${edge}-frame.png`;
      const body = new FormData();
      body.set("chatId", chatId);
      body.set("parentAssetId", assetId);
      body.set("scene", JSON.stringify({ kind: "video-frame", version: 1, sourceAssetId: assetId, sourceTimeSec: time, edge }));
      body.set("file", new File([blob], outputName, { type: "image/png" }));
      const response = await fetch("/api/assets", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the extracted frame.");
      const saved = data.asset as LibraryAsset;
      setLibrary((current) => current.some((item) => item.id === saved.id) ? current : [saved, ...current]);
      setStatus(`Saved ${saved.original_name} to local media library`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Frame extraction failed.");
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      setCapturingFrame(null);
    }
  }

  async function exportToLibrary() {
    setError(""); setStatus("Exporting video…");
    try {
      const blob = await exportVideo(engine.getProject(), { videoCodec: "avc", onProgress: setExportProgress });
      await persistProject(engine.getProject());
      const body = new FormData();
      body.set("chatId", chatId); body.set("parentAssetId", assetId);
      body.set("scene", JSON.stringify({ kind: "elah-video-project", version: 1, project: engine.getProject() }));
      body.set("file", new File([blob], `${fileName.replace(/\.[^.]+$/, "")}-edit.mp4`, { type: "video/mp4" }));
      const response = await fetch("/api/assets", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the exported video.");
      setStatus(`Export saved: ${data.asset.original_name}`); setExportProgress(null);
    } catch (cause) { setExportProgress(null); setError(cause instanceof Error ? cause.message : "Video export failed."); }
  }

  const projectReady = !busy && !error;
  return <div className="video-editor-body">
    <aside className="video-editor-assets"><div className="video-editor-section-title"><Film size={14}/> Chat media library</div><div className="video-editor-library-list">{library.map((item) => <button key={item.id} type="button" onClick={() => void addAsset(item)} disabled={!projectReady}><span className="video-editor-thumb">{item.mime_type.startsWith("image/") ? <img src={item.url} alt=""/> : <Film size={15}/>}</span><span className="video-editor-asset-name">{item.original_name}</span><Plus size={13}/></button>)}</div></aside>
    <main className="video-editor-workspace"><div className="video-editor-preview"><Preview demuxerFactory={demuxerFactory} style={{ width: "100%", height: "100%" }}/></div><Timeline fps={FPS} style={{ height: 250, flex: "0 0 250px" }}/></main>
    <footer className="video-editor-footer"><span className={error ? "video-editor-error" : "video-editor-status"}>{error || (busy || (capturingFrame ? `Extracting ${capturingFrame} frame…` : exportProgress ? `Exporting ${Math.floor(exportProgress.frame / Math.max(1, exportProgress.totalFrames) * 100)}%` : status))}</span><div><button type="button" onClick={() => void extractFrame("first")} disabled={!projectReady || Boolean(capturingFrame)} title="Extract the video's first frame"><Camera size={14}/> First frame</button><button type="button" onClick={() => void extractFrame("last")} disabled={!projectReady || Boolean(capturingFrame)} title="Extract the video's last frame"><Camera size={14}/> Last frame</button><button type="button" onClick={() => void saveNow()} disabled={!projectReady}><Check size={14}/> Save project</button><button type="button" className="video-export-button" onClick={() => void exportToLibrary()} disabled={!projectReady || Boolean(exportProgress)}>{exportProgress ? <LoaderCircle size={14} className="video-editor-spin"/> : <Download size={14}/>} Export to library</button><button type="button" onClick={onClose}>Done</button></div></footer>
  </div>;
}
