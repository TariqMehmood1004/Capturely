import { describe, expect, it } from "vitest";
import { buildExportGraph } from "./exportGraph";
import { DEFAULT_FRAME } from "./frame";
import { clickRegions, regionKeys } from "./zoom";

describe("export graph", () => {
  const keys = regionKeys(clickRegions([{ t: 2, x: 0.1, y: 0.2 }], 10, { zoom: 2, hold: 1.5 }));

  it("is a plain copy without effects", () => {
    expect(buildExportGraph({ width: 1920, height: 1080, fps: 30, keys: [], rings: [], frame: null, camera: null })).toBe("[0:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[src];\n[src]format=yuv420p[vout]");
  });

  it("chains zoom, rings, frame and camera in that order", () => {
    const g = buildExportGraph({ width: 1920, height: 1080, fps: 30, keys, rings: [{ t: 2, x: 0.1, y: 0.2 }], frame: DEFAULT_FRAME, camera: { spot: "bottom-right", size: 0.2 } });
    const at = (s: string) => g.indexOf(s);
    expect(at("[zoomed]")).toBeGreaterThan(0);
    expect(at("[rg0]")).toBeGreaterThan(at("[zoomed]"));
    expect(at("[fframe]")).toBeGreaterThan(at("[rg0]"));
    expect(at("[withcam]")).toBeGreaterThan(at("[fframe]"));
    expect(g).toContain("overlay=x='max(W-w,min(0,W/2-");
    expect(g).toContain("enable='between(t,2,2.45)'");
    expect(g.endsWith("[withcam]format=yuv420p[vout]")).toBe(true);
  });

  it("leaves out rings that the zoom pushes off the picture", () => {
    const g = buildExportGraph({ width: 1920, height: 1080, fps: 30, keys, rings: [{ t: 2.5, x: 0.95, y: 0.95 }], frame: null, camera: null });
    expect(g).not.toContain("[ring0]");
  });
});
