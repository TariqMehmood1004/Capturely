import { describe, expect, it } from "vitest";
import { filterValue, fitMark, newMark } from "./marks";

describe("blur and text", () => {
  it("escapes text for a filter graph (option level, then graph level)", () => {
    expect(filterValue(String.raw`It's 50% done: [ok], yes; C:\x`)).toBe(String.raw`It\\\'s 50% done\\: \[ok\]\, yes\; C\\:\\\\x`);
  });

  it("keeps marks on the picture and in time", () => {
    const m = fitMark({ ...newMark("blur", 9, 10), x: 0.95, w: 0.3, b: 2 }, 10);
    expect(m.a).toBe(2);
    expect(m.b).toBe(9);
    expect(m.x).toBeCloseTo(0.7);
    expect(fitMark({ ...newMark("text", 0, 10), text: "a\n b" }, 10).text).toBe("a b");
  });
});
