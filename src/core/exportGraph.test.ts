import { describe, expect, it } from "vitest";
import { buildExportGraph } from "./exportGraph";
import { DEFAULT_CURSOR } from "./cursor";
import { DEFAULT_FRAME } from "./frame";
import { DEFAULT_CAMERA } from "./style";
import { segments } from "./timeline";
import { clickRegions, regionKeys } from "./zoom";

const at = (g: string, s: string) => g.indexOf(s);

describe("export graph", () => {
  const keys = regionKeys(clickRegions([{ t: 2, x: 0.1, y: 0.2 }], 10, { zoom: 2, hold: 1.5 }));

  it("is a plain copy without effects", () => {
    expect(buildExportGraph({ width: 1920, height: 1080, fps: 30, keys: [], rings: [], frame: null, camera: null })).toBe("[0:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[src];\n[src]format=yuv420p[vout]");
  });

  it("chains zoom, rings, frame and camera in that order", () => {
    const g = buildExportGraph({ width: 1920, height: 1080, fps: 30, box: { x: 116, y: 64, w: 1688, h: 952, radius: 24 }, keys, rings: [{ t: 2, x: 0.1, y: 0.2 }], frame: DEFAULT_FRAME, camera: { look: { ...DEFAULT_CAMERA, size: 0.2, shadow: 0 } } });
    const at = (s: string) => g.indexOf(s);
    expect(at("[zoomed]")).toBeGreaterThan(0);
    expect(at("[rg0]")).toBeGreaterThan(at("[zoomed]"));
    expect(at("[fframe]")).toBeGreaterThan(at("[rg0]"));
    expect(at("[withcam]")).toBeGreaterThan(at("[fframe]"));
    expect(g).toContain("overlay=x='max(W-w,min(0,W/2-");
    expect(g).toContain("enable='between(t,2,2.45)'");
    expect(g.endsWith("[withcam]format=yuv420p[vout]")).toBe(true);
  });

  it("ends a GIF in a palette at the chosen size", () => {
    const g = buildExportGraph({ width: 1152, height: 648, fps: 15, keys: [], rings: [], frame: null, camera: null, gif: true });
    expect(g.startsWith("[0:v]fps=15,scale=1152:648:")).toBe(true);
    expect(g).toContain("[gp]palettegen=stats_mode=diff[pal]");
    expect(g.endsWith("[gu][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[vout]")).toBe(true);
    expect(g).not.toContain("format=yuv420p[vout]");
  });

  it("cuts last, picture and sound alike", () => {
    const g = buildExportGraph({ width: 1920, height: 1080, fps: 30, keys, rings: [], frame: null, camera: null, cuts: [{ a: 4, b: 6 }], duration: 10, audio: true });
    expect(at(g, "[kept]")).toBeGreaterThan(at(g, "[zoomed]"));
    expect(g).toContain("[zoomed]select='between(t,0,4)+between(t,6,10)+gte(t,10)',setpts='(if(lt(T,6),0+T,if(lt(T,10),-2+T,-2+T)))/TB',fps=30[kept]");
    expect(g).toContain("aselect='between(t,0,4)+between(t,6,10)',asetpts=N/SR/TB[aout]");
    expect(buildExportGraph({ width: 1920, height: 1080, fps: 30, keys: [], rings: [], frame: null, camera: null, cuts: [{ a: 4, b: 6 }], duration: 10, audio: false })).not.toContain("[aout]");
  });

  it("puts blur and cursor before the zoom, text after the camera, speed-ups last", () => {
    const g = buildExportGraph({
      width: 1280,
      height: 720,
      fps: 30,
      keys,
      rings: [],
      frame: null,
      camera: { look: { ...DEFAULT_CAMERA, size: 0.2 }, input: 1 },
      segments: segments(10, [], [{ a: 5, b: 9, rate: 4 }]),
      sound: [
        { input: 3, volume: 0.5, clean: false },
        { input: 4, volume: 1.4, clean: true },
      ],
      cursor: { poses: [{ x: 0.5, y: 0.5, s: 1, a: 0 }, { x: 0.6, y: 0.5, s: 1, a: 0 }], look: { ...DEFAULT_CURSOR, size: 1, smooth: 0 }, input: 2 },
      marks: [
        { id: "b", kind: "blur", a: 1, b: 3, x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
        { id: "t", kind: "text", a: 0, b: 2, x: 0.1, y: 0.8, w: 0, h: 0, text: "Step 1: open it", size: 0.05 },
      ],
      font: "C:/Windows/Fonts/segoeuib.ttf",
    });
    const order = ["[blur0]", "[withcur]", "[zoomed]", "[withcam]", "[texted]", "[kept]"].map((l) => at(g, l));
    expect(order).toEqual([...order].sort((p, q) => p - q));
    expect(g).toContain("[2:v]scale=");
    expect(g).toMatch(/0\.000 overlay@cur x \d+, overlay@cur y \d+;/);
    expect(g).toContain("[1:v]fps=30,crop=");
    expect(g).toContain(String.raw`text=Step 1\\: open it`);
    expect(g).toContain("[4:a]aresample=48000,aformat=channel_layouts=stereo,volume=1.4,afftdn=nf=-25:tn=1[snd1]");
    expect(g).toContain("amix=inputs=2:duration=longest:normalize=0[mixed]");
    expect(g).toContain("[mixed]aselect='between(t,0,5)+between(t,5,6)+between(t,9,10)',asetpts=N/SR/TB[aout]");
  });

  it("leaves out rings that the zoom pushes off the picture", () => {
    const g = buildExportGraph({ width: 1920, height: 1080, fps: 30, keys, rings: [{ t: 2.5, x: 0.95, y: 0.95 }], frame: null, camera: null });
    expect(g).not.toContain("[ring0]");
  });
});
