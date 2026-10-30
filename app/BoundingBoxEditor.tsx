"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Crosshair, Minus, Plus, Save, X } from "lucide-react";

export type BoundingBox = { id: string; label: string; x: number; y: number; width: number; height: number };
type Props = { imageUrl: string; imageName: string; width: number; height: number; initialBoxes: BoundingBox[]; onSave: (boxes: BoundingBox[]) => Promise<void>; onClose: () => void };
type Point = { x: number; y: number };

export default function BoundingBoxEditor({ imageUrl, imageName, width, height, initialBoxes, onSave, onClose }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<Point | null>(null);
  const [scale, setScale] = useState(1);
  const [boxes, setBoxes] = useState(initialBoxes);
  const [draft, setDraft] = useState<BoundingBox | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [drawing, setDrawing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const resize = () => setScale(Math.max(0.05, Math.min(1, (window.innerWidth - 390) / width, (window.innerHeight - 260) / height)));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [height, width]);

  async function persist(next: BoundingBox[]) {
    setBoxes(next);
    setError("");
    setSaving(true);
    try { await onSave(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save bounding boxes."); }
    finally { setSaving(false); }
  }

  function imagePoint(event: ReactPointerEvent<HTMLDivElement>): Point | null {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || scale <= 0) return null;
    return {
      x: Math.max(0, Math.min(width, (event.clientX - rect.left) / scale)),
      y: Math.max(0, Math.min(height, (event.clientY - rect.top) / scale)),
    };
  }

  function startDrawing(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drawing || event.button !== 0) return;
    const point = imagePoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = point;
    setDraft({ id: "draft", label: `box-${boxes.length + 1}`, x: point.x, y: point.y, width: 0, height: 0 });
  }

  function moveDrawing(event: ReactPointerEvent<HTMLDivElement>) {
    if (!startRef.current) return;
    const point = imagePoint(event);
    if (!point) return;
    const start = startRef.current;
    setDraft({ id: "draft", label: `box-${boxes.length + 1}`, x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) });
  }

  function finishDrawing() {
    if (!startRef.current || !draft) { startRef.current = null; setDraft(null); return; }
    startRef.current = null;
    if (draft.width < 2 || draft.height < 2) { setDraft(null); return; }
    const box = { ...draft, id: crypto.randomUUID(), label: `box-${boxes.length + 1}` };
    setSelectedId(box.id);
    setDrawing(false);
    setDraft(null);
    void persist([...boxes, box]);
  }

  function changeLabel(id: string, label: string) {
    void persist(boxes.map((box) => box.id === id ? { ...box, label } : box));
  }

  function deleteBox(id: string) {
    const next = boxes.filter((box) => box.id !== id);
    setSelectedId(next.at(-1)?.id || "");
    void persist(next);
  }

  const displayedBox = draft;
  return <div className="bbox-editor-backdrop"><section className="bbox-editor-dialog" aria-label="Bounding box annotator">
    <header><div><strong>Bounding boxes</strong><span>{imageName} · {width} × {height} px</span></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close bounding box editor"><X size={17}/></button></header>
    <div className="bbox-editor-body"><div className="bbox-canvas-column"><div className="bbox-image-stage-wrap"><div ref={stageRef} className={`bbox-image-stage${drawing ? " is-drawing" : ""}`} style={{ width: width * scale, height: height * scale }} onPointerDown={startDrawing} onPointerMove={moveDrawing} onPointerUp={finishDrawing} onPointerCancel={finishDrawing}>
      <img src={imageUrl} alt={imageName} draggable={false}/>
      {boxes.map((box) => <div key={box.id} className={`bbox-rect${selectedId === box.id ? " selected" : ""}`} style={{ left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}><span>{box.label}</span></div>)}
      {displayedBox ? <div className="bbox-rect draft" style={{ left: displayedBox.x * scale, top: displayedBox.y * scale, width: displayedBox.width * scale, height: displayedBox.height * scale }}><span>{displayedBox.label}</span></div> : null}
    </div></div><div className="bbox-canvas-help">Drag over the image to create a box. Coordinates use the source image’s top-left origin.</div></div>
    <aside className="bbox-controls"><button type="button" className={`bbox-draw-toggle${drawing ? " active" : ""}`} onClick={() => setDrawing((value) => !value)}>{drawing ? <><Crosshair size={15}/> Drawing mode on</> : <><Plus size={15}/> Draw bounding box</>}</button>
      <div className="bbox-list-heading"><strong>Boxes</strong><span>{boxes.length}</span></div>
      <div className="bbox-list">{boxes.map((box) => <div key={box.id} className={`bbox-item${selectedId === box.id ? " selected" : ""}`} onClick={() => setSelectedId(box.id)}><label>Label<input value={box.label} onChange={(event) => changeLabel(box.id, event.target.value)} onClick={(event) => event.stopPropagation()}/></label><div className="bbox-coordinates"><span>x <b>{Math.round(box.x)}</b></span><span>y <b>{Math.round(box.y)}</b></span><span>w <b>{Math.round(box.width)}</b></span><span>h <b>{Math.round(box.height)}</b></span></div><button type="button" className="bbox-delete" onClick={(event) => { event.stopPropagation(); deleteBox(box.id); }} aria-label={`Delete ${box.label}`}><Minus size={13}/></button></div>)}{boxes.length === 0 ? <p className="bbox-empty">No boxes yet. Draw one over an object.</p> : null}</div>
      <div className="bbox-metadata-note"><strong>Saved metadata</strong><code>scene.metadata.vfxguruBboxes</code><span>Pixel and normalized coordinates, source dimensions, and labels.</span></div>
      <div className="bbox-save-status">{saving ? <><Save size={13}/> Saving…</> : error ? <span className="bbox-error">{error}</span> : boxes.length ? <><Check size={13}/> Saved to this asset</> : <span>Changes save automatically</span>}</div>
    </aside></div>
  </section></div>;
}
