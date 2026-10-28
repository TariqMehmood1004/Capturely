import { describe, expect, it } from "vitest";
import { cursorAt, cursorTrack, TRACK_RATE } from "./cursor";

describe("smooth cursor", () => {
  const path = [{ t: 0, x: 0.1, y: 0.1 }, { t: 2, x: 0.9, y: 0.5 }];

  it("holds still between far-apart points, then moves", () => {
    const track = cursorTrack(path, 3, 0);
    expect(track).toHaveLength(3 * TRACK_RATE + 1);
    expect(cursorAt(track, 1)).toEqual({ x: 0.1, y: 0.1 });
    expect(cursorAt(track, 2.5)).toEqual({ x: 0.9, y: 0.5 });
  });

  it("smooths without running late", () => {
    const sharp = cursorTrack(path, 3, 0);
    const soft = cursorTrack(path, 3, 1);
    const mid = 1.97;
    expect(cursorAt(soft, mid)!.x).toBeGreaterThan(0.1);
    expect(cursorAt(soft, mid)!.x).toBeLessThan(cursorAt(sharp, 2)!.x);
    expect(cursorAt(soft, 3)!.x).toBeCloseTo(0.9, 2);
  });
});
