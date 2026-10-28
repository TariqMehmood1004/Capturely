import { describe, expect, it } from "vitest";
import { quietSpans } from "./quiet";

describe("quiet parts", () => {
  it("keeps still and silent stretches, broken where the mouse moved", () => {
    const freezes = [{ a: 1, b: 12 }, { a: 20, b: 21 }];
    const silences = [{ a: 0, b: 9 }, { a: 15, b: 30 }];
    expect(quietSpans(freezes, silences, [5])).toEqual([{ a: 1.25, b: 4.35 }, { a: 5.65, b: 8.75 }]);
  });

  it("uses the picture alone without sound, and drops short ones", () => {
    expect(quietSpans([{ a: 0, b: 2 }, { a: 3, b: 9 }], null, [])).toEqual([{ a: 3.25, b: 8.75 }]);
  });
});
