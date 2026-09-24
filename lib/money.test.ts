import { describe, expect, it } from "vitest";
import { formatPaise, paiseToRupees, rupeesToPaise } from "./money";

describe("money", () => {
  it("converts rupees to paise and back", () => {
    expect(rupeesToPaise(750)).toBe(75000);
    expect(rupeesToPaise(1.5)).toBe(150);
    expect(paiseToRupees(14900)).toBe(149);
  });

  it("rejects non-finite rupees", () => {
    expect(() => rupeesToPaise(Number.NaN)).toThrow(RangeError);
  });

  it("formats whole rupees without decimals", () => {
    expect(formatPaise(75000)).toBe("₹750");
    expect(formatPaise(14900)).toBe("₹149");
  });

  it("formats fractional amounts with two decimals", () => {
    expect(formatPaise(75050)).toBe("₹750.50");
    expect(formatPaise(75000, { showPaise: true })).toBe("₹750.00");
  });

  it("uses Indian digit grouping", () => {
    expect(formatPaise(12345600)).toBe("₹1,23,456");
  });
});
