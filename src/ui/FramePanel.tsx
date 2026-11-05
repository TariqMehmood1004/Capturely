// The inspector's Frame tab: the video's shape, the background and frame around the picture, and
// the crop. Changes go into the take's look (core/style.ts), so they are saved and undoable.
import { BUILTIN_WALLPAPERS, DEFAULT_FRAME, FRAME_BACKGROUNDS, paintOf, type ScreenFrame } from "../core/frame";
import { ASPECTS, type Crop, type EditorStyle } from "../core/style";
import { Segmented, Slider, Swatches, Switch } from "./controls";
import { ArrowUpTrayIcon, FolderOpenIcon } from "./icons";
import { builtinUrl, wallpaperRef } from "./media";

const pct = (v: number) => `${Math.round(v * 100)}%`;
type Kind = "preset" | "color" | "gradient" | "image";
const kindOf = (f: ScreenFrame): Kind => (f.background === "color" || f.background === "gradient" || f.background === "image" ? f.background : "preset");

export function FramePanel({
  style,
  setStyle,
  wallpapers,
  imageUrl,
  onAddPicture,
  onOpenWallpapers,
}: {
  style: EditorStyle;
  /** Change the look; quick repeats of one control (`key`) are one undo step. */
  setStyle: (patch: Partial<EditorStyle>, key?: string) => void;
  /** Pictures in the Wallpapers folder. */
  wallpapers: string[];
  imageUrl: (ref: string) => string;
  /** Pick a picture for the background (resolves with its reference, or null). */
  onAddPicture: () => Promise<string | null>;
  onOpenWallpapers: () => void;
}) {
  const frame = style.frame;
  const setFrame = (patch: Partial<ScreenFrame>, key?: string) => frame && setStyle({ frame: { ...frame, ...patch } }, key);
  const kind = frame ? kindOf(frame) : "preset";
  const paint = frame ? paintOf(frame) : null;
  const toKind = (k: Kind) => {
    if (!frame) return;
    const base = { padding: frame.padding, radius: frame.radius, shadow: frame.shadow };
    const p = paint ?? { from: "#6d28d9", to: "#db2777", angle: 135 };
    if (k === "preset") setStyle({ frame: { ...base, background: DEFAULT_FRAME.background } });
    if (k === "color") setStyle({ frame: { ...base, background: "color", color: p.from } });
    if (k === "gradient") setStyle({ frame: { ...base, background: "gradient", from: p.from, to: p.to === p.from ? "#0ea5e9" : p.to, angle: p.angle } });
    if (k === "image") setStyle({ frame: { ...base, background: "image", image: "builtin:aurora", blur: 0 } });
  };
  const crop = style.crop;
  // The crop as the share cut from each side.
  const sides = { left: crop?.x ?? 0, top: crop?.y ?? 0, right: crop ? 1 - crop.x - crop.w : 0, bottom: crop ? 1 - crop.y - crop.h : 0 };
  const setSide = (side: keyof typeof sides, v: number) => {
    const s = { ...sides, [side]: v };
    const w = Math.max(0.1, 1 - s.left - s.right);
    const h = Math.max(0.1, 1 - s.top - s.bottom);
    const next: Crop = { x: Math.min(s.left, 1 - w), y: Math.min(s.top, 1 - h), w, h };
    setStyle({ crop: next.x < 1e-4 && next.y < 1e-4 && next.w > 0.9999 && next.h > 0.9999 ? null : next }, `crop-${side}`);
  };
  const pictures = [...BUILTIN_WALLPAPERS.map((b) => ({ id: `builtin:${b.id}`, label: b.label, paint: `center / cover url("${builtinUrl(b.id)}")` })), ...wallpapers.map((p) => ({ id: wallpaperRef(p), label: wallpaperRef(p).slice(10), paint: `center / cover url("${imageUrl(wallpaperRef(p))}")` }))];
  if (frame?.image?.startsWith("media:")) pictures.push({ id: frame.image, label: "Your picture", paint: `center / cover url("${imageUrl(frame.image)}")` });

  return (
    <>
      <div className="ed-section-head">
        <span>Shape</span>
      </div>
      <div className="ed-card">
        <Segmented wide label="Video shape" value={style.aspect} onChange={(aspect) => setStyle({ aspect })} options={ASPECTS.map((a) => ({ value: a.id, label: a.label }))} />
        {style.aspect !== "auto" && !frame && <p className="ed-hint">The picture keeps its shape; the space around it is black, or the background below when it is on.</p>}
      </div>

      <div className="ed-section-head">
        <span>Background and frame</span>
        {frame && (
          <button className="ed-reset" onClick={() => setStyle({ frame: DEFAULT_FRAME })}>
            Reset
          </button>
        )}
      </div>
      <div className="ed-card">
        <div className="ed-line">
          <span>
            <strong>Background and frame</strong>
            <em>{frame ? "Space, rounded corners, shadow" : "Off · the recording fills the video"}</em>
          </span>
          <Switch on={!!frame} label="Background and frame" onChange={(v) => setStyle({ frame: v ? DEFAULT_FRAME : null })} />
        </div>
      </div>
      {frame && (
        <>
          <div className="ed-card">
            <Segmented wide label="Background" value={kind} onChange={toKind} options={[{ value: "preset", label: "Presets" }, { value: "color", label: "Colour" }, { value: "gradient", label: "Gradient" }, { value: "image", label: "Picture" }]} />
            {kind === "preset" && <Swatches label="Background" value={frame.background} onChange={(id) => setFrame({ background: id })} options={FRAME_BACKGROUNDS.map((b) => ({ id: b.id, label: b.label, paint: b.from === b.to ? b.from : `linear-gradient(135deg, ${b.from}, ${b.to})` }))} />}
            {kind === "color" && (
              <label className="ed-color">
                <input type="color" value={frame.color ?? "#000000"} onChange={(e) => setFrame({ color: e.target.value }, "bg-color")} aria-label="Background colour" />
                <span>{(frame.color ?? "#000000").toUpperCase()}</span>
              </label>
            )}
            {kind === "gradient" && (
              <>
                <div className="ed-colors">
                  <label className="ed-color">
                    <input type="color" value={frame.from ?? "#000000"} onChange={(e) => setFrame({ from: e.target.value }, "bg-from")} aria-label="First colour" />
                    <span>{(frame.from ?? "").toUpperCase()}</span>
                  </label>
                  <label className="ed-color">
                    <input type="color" value={frame.to ?? "#000000"} onChange={(e) => setFrame({ to: e.target.value }, "bg-to")} aria-label="Second colour" />
                    <span>{(frame.to ?? "").toUpperCase()}</span>
                  </label>
                </div>
                <Slider label="Direction" value={frame.angle ?? 135} min={0} max={360} step={5} format={(v) => `${v}°`} onChange={(angle) => setFrame({ angle }, "bg-angle")} />
              </>
            )}
            {kind === "image" && (
              <>
                <Swatches label="Picture" value={frame.image ?? ""} onChange={(image) => setFrame({ image })} options={pictures} />
                <div className="ed-pane-actions glide">
                  <span className="glide-pill" aria-hidden />
                  <button className="btn" onClick={() => void onAddPicture().then((ref) => ref && setFrame({ image: ref }))}>
                    <ArrowUpTrayIcon aria-hidden /> Add a picture
                  </button>
                  <button className="btn ghost" onClick={onOpenWallpapers} title="Pictures put in this folder show up here">
                    <FolderOpenIcon aria-hidden /> Wallpapers folder
                  </button>
                </div>
                <Slider label="Blur" value={frame.blur ?? 0} min={0} max={1} step={0.05} format={pct} onChange={(blur) => setFrame({ blur }, "bg-blur")} />
              </>
            )}
          </div>
          <div className="ed-card">
            <Slider label="Space" value={frame.padding} min={0} max={0.2} step={0.005} format={pct} onChange={(v) => setFrame({ padding: v }, "frame-pad")} />
            <Slider label="Corners" value={frame.radius} min={0} max={0.1} step={0.0025} format={(v) => pct(v * 10)} onChange={(v) => setFrame({ radius: v }, "frame-radius")} />
            <Slider label="Shadow" value={frame.shadow} min={0} max={1} step={0.05} format={pct} onChange={(v) => setFrame({ shadow: v }, "frame-shadow")} />
          </div>
        </>
      )}

      <div className="ed-section-head">
        <span>Crop</span>
        {crop && (
          <button className="ed-reset" onClick={() => setStyle({ crop: null })}>
            Reset
          </button>
        )}
      </div>
      <div className="ed-card">
        <Slider label="Left" value={sides.left} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => setSide("left", v)} />
        <Slider label="Right" value={sides.right} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => setSide("right", v)} />
        <Slider label="Top" value={sides.top} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => setSide("top", v)} />
        <Slider label="Bottom" value={sides.bottom} min={0} max={0.45} step={0.005} format={pct} onChange={(v) => setSide("bottom", v)} />
      </div>
      <p className="ed-hint">Cut away the edges of the recording. Zooms, clicks and the cursor follow the crop.</p>
    </>
  );
}
