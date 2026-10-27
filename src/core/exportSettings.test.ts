import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT, exportFps, exportSize, savePreset, validExport, validPreset } from "./exportSettings";

describe("export settings", () => {
  it("scales the recording per quality to even sizes", () => {
    expect(exportSize(1920, 1080, "low")).toEqual({ width: 1152, height: 648 });
    expect(exportSize(1920, 1080, "medium")).toEqual({ width: 1440, height: 810 });
    expect(exportSize(1920, 1080, "high")).toEqual({ width: 1728, height: 972 });
    expect(exportSize(1366, 767, "original")).toEqual({ width: 1366, height: 768 });
  });

  it("never exports above the recorded frame rate and keeps GIF rates", () => {
    expect(exportFps({ ...DEFAULT_EXPORT, fps: 60 }, 30)).toBe(30);
    expect(exportFps({ ...DEFAULT_EXPORT, fps: 24 }, 60)).toBe(24);
    expect(exportFps({ ...DEFAULT_EXPORT, format: "gif", fps: 60 }, 60)).toBe(24);
  });

  it("repairs stored settings", () => {
    expect(validExport({ format: "webm", quality: "ultra", fps: 99 })).toEqual(DEFAULT_EXPORT);
    expect(validExport({ format: "gif", fps: 60 })).toEqual({ ...DEFAULT_EXPORT, format: "gif", fps: 15 });
  });

  it("reads presets back and replaces one with the same name", () => {
    expect(validPreset({ name: "  " })).toBeNull();
    const a = validPreset({ name: "Demo", zoom: { depth: 9 } })!;
    expect(a.zoom.depth).toBe(3);
    expect(a.frame).toBeNull();
    const b = { ...a, rings: false };
    const list = savePreset(savePreset([], a), { ...b, name: "demo" });
    expect(list).toHaveLength(1);
    expect(list[0]!.rings).toBe(false);
  });
});
