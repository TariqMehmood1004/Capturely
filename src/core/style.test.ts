import { describe, expect, it } from "vitest";
import { DEFAULT_FRAME } from "./frame";
import { cameraBox, cropPoint, DEFAULT_CAMERA, DEFAULT_STYLE, layout, validStyle } from "./style";

describe("look and layout", () => {
  const rec = { width: 1920, height: 1080 };

  it("is the whole video without a frame or another shape", () => {
    expect(layout(rec, DEFAULT_STYLE)).toEqual({ out: { width: 1920, height: 1080 }, box: { x: 0, y: 0, w: 1920, h: 1080, radius: 0 }, framed: false });
  });

  it("keeps the picture's shape inside a frame", () => {
    const l = layout(rec, { ...DEFAULT_STYLE, frame: DEFAULT_FRAME });
    expect(l.out).toEqual({ width: 1920, height: 1080 });
    expect(l.box.w / l.box.h).toBeCloseTo(16 / 9, 2);
    expect(l.box.x).toBeGreaterThan(100);
  });

  it("puts bars around a picture of another shape, keeping its longer side", () => {
    const l = layout(rec, { ...DEFAULT_STYLE, aspect: "9:16" });
    expect(l.out).toEqual({ width: 1920, height: 3414 });
    expect(l.framed).toBe(true);
    expect(l.box).toMatchObject({ x: 0, w: 1920, h: 1080 });
    const sq = layout(rec, { ...DEFAULT_STYLE, aspect: "1:1" }, 0.5);
    expect(sq.out).toEqual({ width: 960, height: 960 });
  });

  it("crops before the shape and maps points onto the crop", () => {
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 };
    expect(layout(rec, { ...DEFAULT_STYLE, crop }).out).toEqual({ width: 960, height: 1080 });
    expect(cropPoint({ t: 1, x: 0.5, y: 0.5 }, crop)).toEqual({ t: 1, x: 0.5, y: 0.5 });
    expect(cropPoint({ t: 1, x: 0.25, y: 0.2 }, crop).x).toBe(0);
  });

  it("places the bubble in a corner or around a chosen centre", () => {
    expect(cameraBox(DEFAULT_CAMERA, 1920, 1080)).toMatchObject({ size: 422, x: 1920 - 422 - 58, y: 1080 - 422 - 58, ax: "right", ay: "bottom" });
    const c = cameraBox({ ...DEFAULT_CAMERA, spot: "custom", x: 0.99, y: 0.5 }, 1920, 1080);
    expect(c.x + c.size).toBe(1920);
    expect(c.cy).toBe(540);
  });

  it("repairs a stored look, using the recorder's choices where it is missing", () => {
    const s = validStyle({ aspect: "21:9", camera: { size: 9, mirror: false }, crop: { x: 0, y: 0, w: 1, h: 1 } }, { ...DEFAULT_STYLE, rings: false });
    expect(s.aspect).toBe("auto");
    expect(s.camera.size).toBe(0.5);
    expect(s.camera.mirror).toBe(false);
    expect(s.crop).toBeNull();
    expect(s.rings).toBe(false);
  });
});
