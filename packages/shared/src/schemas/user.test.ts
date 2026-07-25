import { describe, it, expect } from "vitest";
import { validatePassword, PASSWORD_MIN_LENGTH, CreateUserSchema } from "./user";

describe("validatePassword", () => {
  it("accepts a strong password", () => {
    expect(validatePassword("CorrectHorse42!")).toEqual({ ok: true });
  });

  it("rejects passwords shorter than the minimum", () => {
    const short = "a1".repeat(Math.floor((PASSWORD_MIN_LENGTH - 1) / 2));
    const result = validatePassword(short);
    expect(result.ok).toBe(false);
  });

  it("rejects passwords without a digit", () => {
    const result = validatePassword("OnlyLettersHere");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/digit/i) });
  });

  it("rejects passwords without a letter", () => {
    const result = validatePassword("123456789012345");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/letter/i) });
  });

  it("rejects empty / non-string input", () => {
    expect(validatePassword("").ok).toBe(false);
    expect(validatePassword(undefined).ok).toBe(false);
    expect(validatePassword(123).ok).toBe(false);
  });

  it("rejects passwords longer than the max", () => {
    const tooLong = "a1".repeat(100);
    expect(validatePassword(tooLong).ok).toBe(false);
  });
});

describe("CreateUserSchema", () => {
  it("rejects an 8-char password (below new policy)", () => {
    const result = CreateUserSchema.safeParse({ username: "alice", password: "abc12345" });
    expect(result.success).toBe(false);
  });

  it("accepts a compliant create-user payload", () => {
    const result = CreateUserSchema.safeParse({ username: "alice", password: "Strong-Pw-2026" });
    expect(result.success).toBe(true);
  });

  it("rejects usernames with invalid characters", () => {
    const result = CreateUserSchema.safeParse({ username: "al ice", password: "Strong-Pw-2026" });
    expect(result.success).toBe(false);
  });
});
