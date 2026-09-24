import { describe, expect, it } from "vitest";
import { hashPhone } from "./phone-hash";
import { formatIndianMobile, normaliseIndianMobile } from "./phone";

describe("phone", () => {
  it("normalises common Indian formats to E.164 without plus", () => {
    expect(normaliseIndianMobile("98450 12345")).toBe("919845012345");
    expect(normaliseIndianMobile("+91 98450 12345")).toBe("919845012345");
    expect(normaliseIndianMobile("09845012345")).toBe("919845012345");
    expect(normaliseIndianMobile("919845012345")).toBe("919845012345");
    expect(normaliseIndianMobile("+91-98450-12345")).toBe("919845012345");
  });

  it("rejects non-mobile and non-Indian numbers", () => {
    expect(normaliseIndianMobile("1234567890")).toBeNull(); // starts with 1
    expect(normaliseIndianMobile("984501234")).toBeNull(); // 9 digits
    expect(normaliseIndianMobile("+44 7700 900123")).toBeNull();
    expect(normaliseIndianMobile("")).toBeNull();
  });

  it("hashes deterministically and never returns the input", () => {
    const h = hashPhone("919845012345");
    expect(h).toHaveLength(64);
    expect(h).toBe(hashPhone("919845012345"));
    expect(h).not.toContain("9845012345");
    expect(hashPhone("919845012346")).not.toBe(h);
  });

  it("formats for display", () => {
    expect(formatIndianMobile("919845012345")).toBe("+91 98450 12345");
  });
});
