// The inspector's Camera tab: the camera bubble's look and place, and the footage itself (upload,
// replace or remove). Changes go into the take's look (core/style.ts).
import { useState } from "react";
import { BUBBLE_SPOTS } from "../core/recorder";
import { DEFAULT_CAMERA, type CameraLook } from "../core/style";
import { Segmented, Slider, Switch } from "./controls";
import { ArrowUpTrayIcon, TrashIcon } from "./icons";

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function CameraPanel({ look, hasCamera, importing, setCamera, onUpload, onRemove }: { look: CameraLook; hasCamera: boolean; importing: number | null; setCamera: (patch: Partial<CameraLook>, key?: string) => void; onUpload: () => void; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <div className="ed-section-head">
        <span>Camera bubble</span>
        {hasCamera && (
          <button className="ed-reset" onClick={() => setCamera({ ...DEFAULT_CAMERA, on: look.on })}>
            Reset
          </button>
        )}
      </div>
      {hasCamera ? (
        <>
          <div className="ed-card">
            <div className="ed-line">
              <span>
                <strong>Camera bubble</strong>
                <em>{look.on ? (look.spot === "custom" ? "Placed by hand" : BUBBLE_SPOTS.find((s) => s.id === look.spot)?.label) : "Hidden"}</em>
              </span>
              <Switch on={look.on} label="Camera bubble" onChange={(on) => setCamera({ on })} />
            </div>
          </div>
          {look.on && (
            <>
              <div className="ed-card">
                <div className="ed-field">
                  <span>Place</span>
                  <div className="ed-corners" role="radiogroup" aria-label="Camera corner">
                    {BUBBLE_SPOTS.map((s) => (
                      <button key={s.id} role="radio" aria-checked={look.spot === s.id} aria-label={s.label} title={s.label} className={look.spot === s.id ? `ed-corner ${s.id} on` : `ed-corner ${s.id}`} onClick={() => setCamera({ spot: s.id })}>
                        <i aria-hidden />
                      </button>
                    ))}
                  </div>
                </div>
                <Segmented wide label="Placement" value={look.spot === "custom" ? "custom" : "corner"} onChange={(v) => setCamera(v === "custom" ? { spot: "custom" } : { spot: "bottom-right" })} options={[{ value: "corner", label: "Corner" }, { value: "custom", label: "Custom" }]} />
                {look.spot === "custom" ? (
                  <>
                    <Slider label="Across" value={look.x} min={0} max={1} step={0.01} format={pct} onChange={(x) => setCamera({ x }, "cam-x")} />
                    <Slider label="Down" value={look.y} min={0} max={1} step={0.01} format={pct} onChange={(y) => setCamera({ y }, "cam-y")} />
                    <p className="ed-hint">Or drag the bubble on the picture.</p>
                  </>
                ) : (
                  <Slider label="Margin" value={look.margin} min={0} max={0.1} step={0.005} format={pct} onChange={(margin) => setCamera({ margin }, "cam-margin")} />
                )}
              </div>
              <div className="ed-card">
                <Slider label="Size" value={look.size} min={0.08} max={0.5} step={0.01} format={pct} onChange={(size) => setCamera({ size }, "cam-size")} />
                <Slider label="Roundness" value={look.round} min={0} max={1} step={0.05} format={pct} onChange={(round) => setCamera({ round }, "cam-round")} />
                <Slider label="Shadow" value={look.shadow} min={0} max={1} step={0.05} format={pct} onChange={(shadow) => setCamera({ shadow }, "cam-shadow")} />
              </div>
              <div className="ed-card">
                <div className="ed-line">
                  <span>
                    <strong>Mirror</strong>
                    <em>{look.mirror ? "As you saw yourself" : "As the camera sees"}</em>
                  </span>
                  <Switch on={look.mirror} label="Mirror" onChange={(mirror) => setCamera({ mirror })} />
                </div>
                <div className="ed-line">
                  <span>
                    <strong>Shrink when zoomed</strong>
                    <em>{look.zoomReact ? "Smaller while the picture zooms in" : "Always the same size"}</em>
                  </span>
                  <Switch on={look.zoomReact} label="Shrink when zoomed" onChange={(zoomReact) => setCamera({ zoomReact })} />
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <p className="ed-hint">This recording has no camera. Add footage of yourself (a video file) to show it in a bubble.</p>
      )}
      <div className="ed-pane-actions glide">
        <span className="glide-pill" aria-hidden />
        <button className="btn" onClick={onUpload} disabled={importing !== null}>
          <ArrowUpTrayIcon aria-hidden /> {importing !== null ? `Adding… ${Math.round(importing * 100)}%` : hasCamera ? "Replace footage" : "Add camera footage"}
        </button>
        {hasCamera &&
          (confirm ? (
            <button className="btn danger" onClick={() => (setConfirm(false), onRemove())} onBlur={() => setConfirm(false)}>
              <TrashIcon aria-hidden /> Remove for good
            </button>
          ) : (
            <button className="btn ghost" onClick={() => setConfirm(true)}>
              <TrashIcon aria-hidden /> Remove
            </button>
          ))}
      </div>
    </>
  );
}
