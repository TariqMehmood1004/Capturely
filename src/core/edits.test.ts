import { describe, expect, it } from "vitest";
import { addSpeeds, addSplit, cutExpr, editedZooms, editZoom, EMPTY_EDIT, keptDuration, keptSpans, pieces, playFrom, removeSpeeds, togglePiece, validEdit } from "./edits";

describe("cuts", () => {
  it("splits into pieces and ignores splits too close to an edge", () => {
    let e = addSplit(EMPTY_EDIT, 4, 10);
    e = addSplit(e, 7, 10);
    e = addSplit(e, 7.05, 10);
    e = addSplit(e, 0.02, 10);
    expect(e.splits).toEqual([4, 7]);
    expect(pieces(10, e.splits)).toEqual([{ a: 0, b: 4 }, { a: 4, b: 7 }, { a: 7, b: 10 }]);
  });

  it("removes a piece, merges neighbours and brings one back", () => {
    let e = { ...EMPTY_EDIT, splits: [4, 7] };
    e = togglePiece(e, { a: 4, b: 7 }, 10);
    e = togglePiece(e, { a: 7, b: 10 }, 10);
    expect(e.cuts).toEqual([{ a: 4, b: 10 }]);
    expect(keptDuration(10, e.cuts)).toBe(4);
    e = togglePiece(e, { a: 4, b: 7 }, 10);
    expect(e.cuts).toEqual([{ a: 7, b: 10 }]);
    expect(keptSpans(10, e.cuts)).toEqual([{ a: 0, b: 7 }]);
  });

  it("plays past cuts and stops at a cut that runs to the end", () => {
    const cuts = [{ a: 2, b: 3 }, { a: 8, b: 10 }];
    expect(playFrom(1, 10, cuts)).toBe(1);
    expect(playFrom(2.5, 10, cuts)).toBe(3);
    expect(playFrom(9, 10, cuts)).toBeNull();
  });

  it("writes the FFmpeg test for the cut stretches", () => {
    expect(cutExpr([{ a: 3, b: 2 }, { a: 5, b: 6.12345 }], 10)).toBe("between(t,2,3)+between(t,5,6.123)");
  });
});

describe("zoom edits", () => {
  const regions = [
    { start: 1, end: 3, zoom: 1.8, fx: 0.5, fy: 0.5 },
    { start: 5, end: 8, zoom: 1.8, fx: 0.2, fy: 0.2 },
  ];

  it("changes one zoom, turns another off, and finds them again by time", () => {
    let e = editZoom(EMPTY_EDIT, regions[0]!, { zoom: 2.6 });
    e = editZoom(e, regions[1]!, { off: true });
    const z = editedZooms(regions, e.zooms);
    expect(z.map((r) => [r.zoom, r.off])).toEqual([[2.6, false], [1.8, true]]);
    // The second zoom moved a little (a different hold): still found.
    expect(editedZooms([regions[0]!, { ...regions[1]!, start: 5.2, end: 7.4 }], e.zooms)[1]!.off).toBe(true);
    expect(editZoom(e, regions[0]!, null).zooms).toHaveLength(1);
  });

  it("repairs stored edits", () => {
    expect(validEdit({ splits: [2, -1, "x"], cuts: [{ a: 1, b: 2 }, { a: 1 }], zooms: [{ at: 2, zoom: 9 }, {}] })).toEqual({ ...EMPTY_EDIT, splits: [2], cuts: [{ a: 1, b: 2 }], zooms: [{ at: 2, zoom: 3 }] });
  });

  it("repairs speed-ups, sound and cursor, keeping good values", () => {
    const e = validEdit({ speeds: [{ a: 4, b: 2, rate: 4 }, { a: 1, b: 3, rate: 4 }, { a: 5, b: 6, rate: 99 }], sound: { system: 5, mic: 0.4, clean: true }, cursor: { on: false, size: 9 } });
    expect(e.speeds).toEqual([{ a: 1, b: 3, rate: 4 }]);
    expect(e.sound).toEqual({ system: 2, mic: 0.4, clean: true });
    expect(e.cursor).toEqual({ on: false, size: 3, smooth: 0.5 });
  });

  it("speeds stretches up, replacing what they overlap", () => {
    const e = addSpeeds(addSpeeds(EMPTY_EDIT, [{ a: 1, b: 3 }], 2), [{ a: 2, b: 5 }, { a: 8, b: 9 }], 4);
    expect(e.speeds).toEqual([{ a: 2, b: 5, rate: 4 }, { a: 8, b: 9, rate: 4 }]);
    expect(removeSpeeds(e, [{ a: 8.5, b: 8.6 }]).speeds).toEqual([{ a: 2, b: 5, rate: 4 }]);
  });
});
