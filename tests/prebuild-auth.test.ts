import { describe, expect, test } from "bun:test";
import { authorizeApiSecret } from "../src/server.js";

const SECRET = "test-secret-1234567890";

describe("authorizeApiSecret (guards POST /pre-build-ext-image)", () => {
  test("accepts a matching Bearer token", () => {
    expect(authorizeApiSecret(`Bearer ${SECRET}`, SECRET)).toEqual({
      ok: true,
    });
  });

  test("rejects a missing Authorization header with 401", () => {
    expect(authorizeApiSecret(undefined, SECRET)).toEqual({
      ok: false,
      status: 401,
    });
  });

  test("rejects a wrong token with 401", () => {
    expect(authorizeApiSecret("Bearer wrong-secret", SECRET)).toEqual({
      ok: false,
      status: 401,
    });
  });

  test("rejects a token of the same length but different bytes with 401", () => {
    const sameLenWrong = "x".repeat(SECRET.length);
    expect(sameLenWrong.length).toBe(SECRET.length);
    expect(authorizeApiSecret(`Bearer ${sameLenWrong}`, SECRET)).toEqual({
      ok: false,
      status: 401,
    });
  });

  test("rejects a non-Bearer scheme with 401", () => {
    expect(authorizeApiSecret(SECRET, SECRET)).toEqual({
      ok: false,
      status: 401,
    });
  });

  test("refuses with 503 when no secret is configured (never runs open)", () => {
    expect(authorizeApiSecret(`Bearer ${SECRET}`, undefined)).toEqual({
      ok: false,
      status: 503,
    });
    expect(authorizeApiSecret(`Bearer ${SECRET}`, "")).toEqual({
      ok: false,
      status: 503,
    });
  });
});
