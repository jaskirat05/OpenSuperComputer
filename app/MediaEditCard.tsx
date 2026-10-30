"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { Check, Clapperboard, Crosshair, ExternalLink, Image as ImageIcon, X } from "lucide-react";
import type { IScene } from "@fastlabai/design-editor";
import BoundingBoxEditor, { type BoundingBox } from "./BoundingBoxEditor";

const DesignEditor = dynamic(() => import("./OpenImageEditor"), { ssr: false, loading: () => <div className="image-editor-loading">Loading image editor…</div> });
const VideoEditor = dynamic(() => import("./VideoEditorWidget"), { ssr: false, loading: () => <div className="image-editor-loading">Loading video editor…</div> });
type Props = { file: File; id: string; chatId: string; assetId?: string; compact?: boolean; autoOpenEditor?: boolean; editorOnly?: boolean; onEditorClose?: () => void };
type LibraryAsset = { id: string; original_name: string; mime_type: string; size: number; url: string; hasScene: boolean };

export default function MediaEditCard({ file, id, chatId, assetId, compact = false, autoOpenEditor = false, editorOnly = false, onEditorClose }: Props) {
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [videoEditing, setVideoEditing] = useState(false);
  const [savedAsset, setSavedAsset] = useState("");
  const [error, setError] = useState("");
  const [scene, setScene] = useState<IScene | null>(null);
  const [sourceFrame, setSourceFrame] = useState<{ width: number; height: number } | null>(null);
  const [boxesOpen, setBoxesOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [dataDir, setDataDir] = useState("");
  const isImage = file.type.startsWith("image/");

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  useEffect(() => {
    if (!isImage || !url) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      const width = image.naturalWidth || 1080;
      const height = image.naturalHeight || 1080;
      setSourceFrame({ width, height });
      setScene({ id: `scene-${id}`, name: file.name, frame: { width, height }, metadata: {}, layers: [{ id: `image-${id}`, name: file.name, type: "StaticImage", src: url, left: 0, top: 0, width, height, originX: "left", originY: "top" }] });
    };
    image.src = url;
    return () => { active = false; };
  }, [file.name, id, isImage, url]);

  useEffect(() => {
    if (!autoOpenEditor) return;
    if (isImage) { setEditing(true); void refreshLibrary(); }
    else if (file.type.startsWith("video/")) setVideoEditing(true);
  }, [autoOpenEditor, file.type, isImage]);

  useEffect(() => {
    if (!assetId || !isImage) return;
    void fetch(`/api/assets/${assetId}?metadata=1`).then((response) => response.json()).then((data) => {
      if (data.asset?.scene) setScene(data.asset.scene as IScene);
    }).catch(() => undefined);
  }, [assetId, isImage]);

  async function refreshLibrary() {
    try {
      const response = await fetch(`/api/assets?chatId=${encodeURIComponent(chatId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load the media library.");
      setLibrary((data.assets || []).filter((item: LibraryAsset) => item.mime_type.startsWith("image/")));
      setDataDir(data.dataDir || "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the media library."); }
  }

  async function exportDesign(blob: Blob, format: "png" | "jpg" | "svg", exportedScene: IScene) {
    setError("");
    const extension = format === "jpg" ? "jpg" : format;
    const outputName = `${file.name.replace(/\.[^.]+$/, "")}-edit.${extension}`;
    const body = new FormData();
    body.set("chatId", chatId);
    body.set("parentAssetId", assetId || "");
    body.set("scene", JSON.stringify(stableScene(withCurrentBoxes(exportedScene, scene), url, assetId)));
    body.set("file", new File([blob], outputName, { type: format === "jpg" ? "image/jpeg" : `image/${format}` }));
    const response = await fetch("/api/assets", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save the edited image.");
    setSavedAsset(data.asset.original_name);
    await refreshLibrary();
  }

  async function saveBoundingBoxes(boxes: BoundingBox[]) {
    if (!assetId || !scene || !sourceFrame) throw new Error("Save this image to the media library before adding bounding boxes.");
    const metadataBoxes = boxes.map((box) => {
      const x = round(box.x), y = round(box.y), boxWidth = round(box.width), boxHeight = round(box.height);
      return { id: box.id, label: box.label, x, y, width: boxWidth, height: boxHeight,
        normalized: { x: round(x / sourceFrame.width, 6), y: round(y / sourceFrame.height, 6), width: round(boxWidth / sourceFrame.width, 6), height: round(boxHeight / sourceFrame.height, 6) } };
    });
    const nextScene = { ...scene, metadata: { ...(scene.metadata || {}), vfxguruBboxes: { version: 1, coordinateSpace: "source-image-pixels; origin at top-left", image: sourceFrame, boxes: metadataBoxes } } } as IScene;
    const response = await fetch(`/api/assets/${assetId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: stableScene(nextScene, url, assetId) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save bounding boxes.");
    setScene(nextScene);
  }

  const sceneKey = useMemo(() => `vfxguru:${chatId}:${assetId || id}`, [assetId, chatId, id]);
  const persistenceProvider = useMemo(() => ({
    async save(_key: string, savedScene: IScene) {
      if (!assetId) return;
      const response = await fetch(`/api/assets/${assetId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: stableScene(withCurrentBoxes(savedScene, scene), url, assetId) }) });
      if (!response.ok) throw new Error("Could not persist image editor changes.");
    },
    async load() {
      if (!assetId) return null;
      const response = await fetch(`/api/assets/${assetId}?metadata=1`);
      if (!response.ok) return null;
      const data = await response.json();
      return (data.asset?.scene as IScene | undefined) || null;
    },
  }), [assetId, scene, url]);
  const closeImageEditor = () => { setEditing(false); onEditorClose?.(); };
  const editorModal = editing && scene ? createPortal(<div className="image-editor-backdrop"><section className="image-editor-dialog" aria-label="Image design editor"><div className="image-editor-heading"><div><strong>Edit image</strong><span>{file.name}</span></div><div className="image-editor-heading-actions">{isImage ? <button type="button" className="bbox-open-button" onClick={() => setBoxesOpen(true)} disabled={!sourceFrame || !assetId}><Crosshair size={14}/> Bounding boxes</button> : null}<button type="button" className="icon-button" onClick={closeImageEditor} aria-label="Close editor"><X size={17}/></button></div></div><DesignEditor title="Open SuperComputer · Image Studio" initialScene={scene} sceneKey={sceneKey} persistenceProvider={persistenceProvider} onBack={closeImageEditor} onExport={exportDesign} libraryPanel={({ onAddMedia }) => <div className="editor-library-panel"><strong>Chat media library</strong><small>Click an asset to add it to the canvas.</small>{library.map((item) => <button type="button" key={item.id} onClick={() => onAddMedia(item.url)}><img src={item.url} alt=""/><span>{item.original_name}</span></button>)}{library.length === 0 ? <p>No saved assets yet.</p> : null}<small className="editor-library-path">Stored locally{dataDir ? ` · ${dataDir}` : ""}</small></div>}/></section></div>, document.body) : null;
  const boundingBoxModal = boxesOpen && scene && sourceFrame ? createPortal(<BoundingBoxEditor imageUrl={url} imageName={file.name} width={sourceFrame.width} height={sourceFrame.height} initialBoxes={getBoundingBoxes(scene)} onSave={saveBoundingBoxes} onClose={() => setBoxesOpen(false)}/>, document.body) : null;
  if (!url) return null;
  return <>
    {!editorOnly ? <section className={`media-edit-card${compact ? " media-edit-card-compact" : ""}`} aria-label={`Edit ${file.name}`}>
      <div className="media-edit-preview">
        {isImage ? <img src={url} alt={file.name}/> : file.type.startsWith("video/") ? <video src={url} controls playsInline/> : <div className="image-editor-loading">{file.name}</div>}
      </div>
      <div className="media-edit-controls">
        <div className="media-edit-title"><strong>{file.name}</strong><span>{isImage ? "IMAGE ASSET" : file.type.startsWith("video/") ? "VIDEO ASSET" : "ATTACHMENT"}</span></div>
        {compact ? <div className="media-edit-footer"><span>{assetId ? "Saved in local media library" : "Saving to local media library…"}</span>{isImage ? <button type="button" onClick={() => { setEditing(true); void refreshLibrary(); }}><ImageIcon size={13}/> Edit image</button> : file.type.startsWith("video/") ? <button type="button" disabled={!assetId} onClick={() => setVideoEditing(true)}><Clapperboard size={13}/> Edit video</button> : null}</div> : <>
        <div className="media-library-caption"><span>{assetId ? "Saved to this chat’s local media library" : "Saving attachment to local library…"}</span><button type="button" onClick={() => { setError(""); void refreshLibrary(); }} aria-label="Refresh media library"><ExternalLink size={13}/></button></div>
        <div className="media-edit-footer"><span>{savedAsset ? <><Check size={13}/> Saved {savedAsset}</> : assetId ? "Original archived in local library" : "Editing stays non-destructive"}</span>{isImage ? <button type="button" onClick={() => { setEditing(true); void refreshLibrary(); }}><ImageIcon size={13}/> Edit image</button> : file.type.startsWith("video/") ? <button type="button" disabled={!assetId} onClick={() => setVideoEditing(true)}><Clapperboard size={13}/> Edit video</button> : null}</div>
        {error ? <p className="media-editor-error">{error}</p> : null}
        </>}
      </div>
    </section> : null}
    {editorModal}{boundingBoxModal}
    {videoEditing && assetId ? <VideoEditor assetId={assetId} chatId={chatId} fileName={file.name} onClose={() => { setVideoEditing(false); onEditorClose?.(); }} /> : null}
  </>;
}

function getBoundingBoxes(scene: IScene): BoundingBox[] {
  const metadata = scene.metadata as Record<string, unknown> | undefined;
  const saved = metadata?.vfxguruBboxes as { boxes?: BoundingBox[] } | undefined;
  return Array.isArray(saved?.boxes) ? saved.boxes.map(({ id, label, x, y, width, height }) => ({ id, label, x, y, width, height })) : [];
}

function withCurrentBoxes(target: IScene, source: IScene | null): IScene {
  if (!source) return target;
  const metadata = source.metadata as Record<string, unknown> | undefined;
  if (!metadata?.vfxguruBboxes) return target;
  return { ...target, metadata: { ...(target.metadata || {}), vfxguruBboxes: metadata.vfxguruBboxes } } as IScene;
}

function round(value: number, digits = 2) { return Math.round(value * 10 ** digits) / 10 ** digits; }

function stableScene(scene: IScene, sourceUrl: string, assetId?: string): IScene {
  const stableUrl = assetId ? `/api/assets/${assetId}` : sourceUrl;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const next = { ...(value as Record<string, unknown>) };
    if (next.src === sourceUrl) next.src = stableUrl;
    for (const [key, child] of Object.entries(next)) if (child && typeof child === "object") next[key] = visit(child);
    return next;
  };
  return visit(scene) as IScene;
}
