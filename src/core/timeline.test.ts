import { describe, expect, it } from "vitest";
import { outDuration, outTime, rateAt, segments, videoTimeChain } from "./timeline";

describe("timeline", () => {
  const segs = segments(20, [{ a: 2, b: 4 }], [{ a: 3, b: 6, rate: 4 }, { a: 10, b: 18, rate: 2 }]);

  it("splits the recording, cuts winning over speed-ups", () => {
    expect(segs).toEqual([
      { a: 0, b: 2, rate: 1 },
      { a: 2, b: 4, rate: 0 },
      { a: 4, b: 6, rate: 4 },
      { a: 6, b: 10, rate: 1 },
      { a: 10, b: 18, rate: 2 },
      { a: 18, b: 20, rate: 1 },
    ]);
  });

  it("maps recording time to the output", () => {
    expect(outDuration(segs)).toBeCloseTo(2 + 0.5 + 4 + 4 + 2);
    expect(outTime(segs, 3)).toBeCloseTo(2);
    expect(outTime(segs, 5)).toBeCloseTo(2.25);
    expect(outTime(segs, 14)).toBeCloseTo(8.5);
    expect(rateAt(segs, 3)).toBe(0);
    expect(rateAt(segs, 11)).toBe(2);
  });

  it("keeps the FFmpeg expression shallow", () => {
    const many = segments(1000, [], Array.from({ length: 200 }, (_, i) => ({ a: i * 5, b: i * 5 + 2, rate: 4 })));
    const chain = videoTimeChain(many, 30, "[in]", "[out]");
    let depth = 0;
    let max = 0;
    for (const c of chain) (depth += c === "(" ? 1 : c === ")" ? -1 : 0), (max = Math.max(max, depth));
    expect(max).toBeLessThan(40);
  });
});
