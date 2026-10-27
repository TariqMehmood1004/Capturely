import { describe, expect, it } from "vitest";
import { clickRegions, ease, PAN_TIME, pointerZooms, regionKeys, viewAt, viewExprs, ZOOM_RAMP, zoomView } from "./zoom";

/** Evaluate an FFmpeg expression of `t` (between, lt, +, *, numbers) in JavaScript. */
function evalExpr(expr: string, t: number): number {
  const js = expr.replace(/\bt\b/g, String(t));
  return new Function("between", "lt", `return ${js};`)((v: number, a: number, b: number) => (v >= a && v <= b ? 1 : 0), (a: number, b: number) => (a < b ? 1 : 0)) as number;
}

describe("click zooms", () => {
  it("glide between clicks close together", () => {
    const r = clickRegions([{ t: 2, x: 0.1, y: 0.1 }, { t: 3.5, x: 0.8, y: 0.7 }, { t: 9, x: 0.5, y: 0.5 }], 20, { zoom: 2, hold: 1.5 });
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ start: 2 - ZOOM_RAMP, fx: 0.1, pans: [{ t: 3.5, fx: 0.8, fy: 0.7 }] });
  });

  it("follow the pointer nearby and zoom out when it leaves", () => {
    const click = [{ t: 2, x: 0.3, y: 0.3 }];
    const near = pointerZooms(click, [{ t: 2.8, x: 0.3, y: 0.3 }, { t: 3.4, x: 0.45, y: 0.32 }], 20, { zoom: 2, hold: 1.5, after: "follow" });
    expect(near[0]!.pans?.map((p) => p.t)).toEqual([3.4]);
    const far = pointerZooms(click, [{ t: 2.8, x: 0.3, y: 0.3 }, { t: 3.2, x: 0.95, y: 0.9 }], 20, { zoom: 2, hold: 1.5, after: "follow" });
    expect(far[0]!.end).toBeCloseTo(3.2 + ZOOM_RAMP);
  });

  it("ease the zoom and the anchor between keys", () => {
    const keys = regionKeys(clickRegions([{ t: 2, x: 0.1, y: 0.1 }, { t: 3.5, x: 0.9, y: 0.9 }], 20, { zoom: 2, hold: 1.5 }));
    expect(viewAt(keys, 0.5).z).toBe(1);
    expect(viewAt(keys, 2.5)).toMatchObject({ z: 2, fx: 0.1 });
    const mid = viewAt(keys, 3.5 - PAN_TIME / 2).fx;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    expect(viewAt(keys, 4).fx).toBeCloseTo(0.9, 6);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
  });

  it("centres the view but never leaves the picture", () => {
    expect(zoomView(0.5, 2)).toBeCloseTo(0.25);
    expect(zoomView(0.02, 2)).toBe(0);
    expect(zoomView(0.99, 2)).toBeCloseTo(0.5);
  });

  it("export expressions follow the preview's curve", () => {
    const keys = regionKeys(clickRegions([{ t: 2, x: 0.2, y: 0.3 }, { t: 3.4, x: 0.7, y: 0.6 }], 20, { zoom: 1.8, hold: 1.5 }));
    const e = viewExprs(keys, 1 / 30);
    for (const t of [0.5, 1.7, 2.2, 3.1, 3.4, 5.0, 6.2, 9]) {
      const v = viewAt(keys, t);
      expect(evalExpr(e.z, t)).toBeCloseTo(v.z, 2);
      if (v.z > 1.001) expect(evalExpr(e.fx, t)).toBeCloseTo(v.fx, 2);
    }
  });
});
