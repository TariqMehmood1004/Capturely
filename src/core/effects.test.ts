import { describe, expect, it } from "vitest";
import { cursorChains, cursorPoses, cursorTrack, DEFAULT_CURSOR, poseAt, TRACK_RATE } from "./cursor";
import { buildExportGraph } from "./exportGraph";
import { gradientLine, validFrame } from "./frame";
import { fitMark, newMark, shapeSvg, validMarks } from "./marks";
import { DEFAULT_CAMERA } from "./style";
import { audioTimeChain, outDuration, segments } from "./timeline";
import { suggestZooms, withManual, type ZoomRegion } from "./zoom";

describe("cursor effects", () => {
  const path = [{ t: 0, x: 0.1, y: 0.1 }, { t: 1, x: 0.9, y: 0.5 }];

  it("comes back to the start when looping", () => {
    const track = cursorTrack(path, 3, 0, true);
    expect(track[track.length - 1]!.x).toBeCloseTo(0.1, 6);
    expect(track[track.length - 1]!.y).toBeCloseTo(0.1, 6);
    expect(cursorTrack(path, 3, 0)[3 * TRACK_RATE]).toMatchObject({ x: 0.9, y: 0.5 });
  });

  it("bounces on a click and leans when moving sideways", () => {
    const track = cursorTrack(path, 3, 0);
    const poses = cursorPoses(track, { bounce: 1, sway: 1 }, [2]);
    expect(poseAt(poses, 2.14)!.s).toBeLessThan(0.75);
    expect(poseAt(poses, 2.5)!.s).toBe(1);
    expect(Math.abs(poseAt(poses, 1.02)!.a)).toBeGreaterThan(0.05);
    expect(cursorPoses(track, { bounce: 0, sway: 0 }, [2]).every((p) => p.s === 1 && p.a === 0)).toBe(true);
  });

  it("turns and scales the cursor by commands, and blurs it on its own layer", () => {
    const poses = cursorPoses(cursorTrack(path, 2, 0), { bounce: 1, sway: 1 }, [1.5]);
    const chains: string[] = [];
    cursorChains(chains, poses, { ...DEFAULT_CURSOR, blur: 1 }, 2, "[in]", 1280, 720, 30);
    const g = chains.join(";");
    expect(g).toContain("scale@cur=w=");
    expect(g).toContain("rotate@cur=a=");
    expect(g).toMatch(/scale@cur w \d+, scale@cur h \d+, rotate@cur a -?\d/);
    expect(g).toContain("tmix=frames=5");
  });
});

describe("timing", () => {
  it("slows a stretch down, sound stretched to match", () => {
    const segs = segments(10, [], [{ a: 2, b: 4, rate: 0.5 }, { a: 6, b: 8, rate: 4 }]);
    expect(outDuration(segs)).toBeCloseTo(2 + 4 + 2 + 0.5 + 2);
    const a = audioTimeChain(segs, "[m]", "[aout]");
    expect(a).toContain("[m]asplit=5");
    expect(a).toContain("atrim=start=2:end=4,asetpts=PTS-STARTPTS,atempo=0.5[atp1]");
    expect(a).toContain("atrim=start=6:end=6.5,asetpts=PTS-STARTPTS[atp3]");
    expect(a).toContain("concat=n=5:v=0:a=1[aout]");
    expect(audioTimeChain(segments(10, [], [{ a: 2, b: 4, rate: 0.25 }]), "[m]", "[o]")).toContain("atempo=0.5,atempo=0.5");
  });
});

describe("zooms by hand and suggested", () => {
  it("lets a zoom placed by hand win over click zooms it overlaps", () => {
    const clicks: ZoomRegion[] = [{ start: 1, end: 3, zoom: 2, fx: 0.1, fy: 0.1 }, { start: 6, end: 8, zoom: 2, fx: 0.1, fy: 0.1 }];
    const all = withManual(clicks, [{ id: "m", a: 2, b: 4, zoom: 2.5, x: 0.5, y: 0.5 }]);
    expect(all.map((r) => r.start)).toEqual([2, 6]);
  });

  it("suggests a zoom where the pointer comes to rest", () => {
    const path = [{ t: 0, x: 0.1, y: 0.1 }, { t: 0.5, x: 0.4, y: 0.4 }, { t: 1, x: 0.7, y: 0.6 }, { t: 1.1, x: 0.71, y: 0.6 }, { t: 4, x: 0.2, y: 0.9 }];
    const s = suggestZooms(path, 10, [], { zoom: 2 });
    expect(s).toHaveLength(1);
    expect(s[0]!.x).toBeCloseTo(0.705, 2);
    expect(suggestZooms(path, 10, [{ start: 0, end: 5, zoom: 2, fx: 0, fy: 0 }], { zoom: 2 })).toHaveLength(0);
  });
});

describe("marks, backgrounds and the camera", () => {
  it("draws shapes as SVG inside the video", () => {
    const box = shapeSvg(newMark("shape", 0, 10, 3, { shape: "ellipse", x: 0.9, w: 0.3 }), 1000, 500);
    expect(box.x + box.w).toBeLessThanOrEqual(1000);
    expect(box.svg).toContain("<ellipse");
    const arrow = fitMark(newMark("shape", 0, 10, 3, { shape: "arrow", x: 0.8, y: 0.2, w: 0.5, h: -0.5 }), 10);
    expect(arrow.x + arrow.w).toBe(1);
    expect(arrow.y + arrow.h).toBe(0);
    expect(shapeSvg(arrow, 1000, 500).svg).toContain("<polygon");
  });

  it("keeps pictures only from the take's own files", () => {
    expect(validMarks([{ id: "i", kind: "image", a: 0, b: 1, x: 0, y: 0, w: 0.2, h: 0.2, file: "media:logo.png" }, { id: "j", kind: "image", a: 0, b: 1, x: 0, y: 0, w: 0.2, h: 0.2, file: "C:/Windows/x.png" }])).toHaveLength(1);
  });

  it("reads colour, gradient and picture backgrounds", () => {
    expect(validFrame({ background: "gradient", from: "#FF0000", to: "#0000ff", angle: 90 })).toMatchObject({ from: "#ff0000", angle: 90 });
    expect(validFrame({ background: "image", image: "wallpaper:../x.jpg" })!.background).toBe("violet");
    expect(validFrame({ background: "image", image: "builtin:aurora", blur: 0.5 })).toMatchObject({ image: "builtin:aurora", blur: 0.5 });
    expect(gradientLine(90, 100, 50)).toEqual({ x0: 0, y0: 25, x1: 100, y1: 25 });
  });

  it("rounds, mirrors and shrinks the bubble with the zoom", () => {
    const keys = [{ t: 1, z: 1, fx: 0.5, fy: 0.5 }, { t: 2, z: 2, fx: 0.5, fy: 0.5 }, { t: 3, z: 1, fx: 0.5, fy: 0.5 }];
    const g = buildExportGraph({ width: 1280, height: 720, fps: 30, keys, rings: [], frame: null, camera: { look: { ...DEFAULT_CAMERA, mirror: false, zoomReact: true, round: 0.5 } } });
    expect(g).not.toContain("hflip");
    expect(g).toContain("[camz]");
    expect(g).toMatch(/overlay=x='W-38-w\*[\d.]+':y='H-38-h\*[\d.]+':eval=frame/);
  });

  it("puts extra sound at its place in time", () => {
    const g = buildExportGraph({ width: 640, height: 360, fps: 30, keys: [], rings: [], frame: null, camera: null, sound: [{ input: 0, volume: 1, clean: false }, { input: 2, volume: 0.5, clean: false, delay: 1.5, from: 3, len: 10 }] });
    expect(g).toContain("[2:a]atrim=start=3:duration=10,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=0.5,adelay=1500:all=1[snd1]");
  });
});
