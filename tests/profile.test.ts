import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProfile, normalizeProfile, resolveProfile } from "@/lib/profile";

afterEach(() => vi.unstubAllEnvs());

describe("normalizeProfile", () => {
  it("lowercases and trims BGG usernames", () => {
    expect(normalizeProfile("  GaleSwift ")).toBe("galeswift");
    expect(normalizeProfile("john_doe.99")).toBe("john_doe.99");
    expect(normalizeProfile("Board Gamer")).toBe("board gamer");
  });

  it.each(["", " ", "-leading", "a/b", "x".repeat(65), "<script>", 42, null])("rejects %j", (value) => {
    expect(() => normalizeProfile(value)).toThrow("Invalid BGG username.");
  });
});

describe("resolveProfile", () => {
  it("falls back to the default profile when none is given", () => {
    expect(resolveProfile(null)).toBe("galeswift");
    expect(resolveProfile("")).toBe("galeswift");
    expect(resolveProfile(undefined)).toBe("galeswift");
  });

  it("honours DEFAULT_PROFILE", () => {
    vi.stubEnv("DEFAULT_PROFILE", "SomeoneElse");
    expect(defaultProfile()).toBe("someoneelse");
    expect(resolveProfile(undefined)).toBe("someoneelse");
  });
});
