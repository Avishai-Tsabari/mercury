import { describe, expect, test } from "bun:test";
import {
  mintCallerToken,
  verifyCallerToken,
} from "../src/core/caller-token.js";

const KEY = "test-signing-key-do-not-use-in-prod";
const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 10;

describe("caller-token", () => {
  test("round-trips caller and space identity", () => {
    const token = mintCallerToken(
      { callerId: "user-a", spaceId: "dm-123", exp: future() },
      KEY,
    );
    const verified = verifyCallerToken(token, KEY);
    expect(verified).toEqual({ callerId: "user-a", spaceId: "dm-123" });
  });

  test("rejects a tampered payload", () => {
    const token = mintCallerToken(
      { callerId: "user-a", spaceId: "dm-123", exp: future() },
      KEY,
    );
    // Swap the payload for one claiming a different caller, keep the signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ c: "victim", s: "dm-123", exp: future() }),
      "utf8",
    ).toString("base64url");
    const forged = `${forgedPayload}.${token.slice(token.indexOf(".") + 1)}`;
    expect(verifyCallerToken(forged, KEY)).toBeNull();
  });

  test("rejects a token signed with a different key", () => {
    const token = mintCallerToken(
      { callerId: "user-a", spaceId: "dm-123", exp: future() },
      KEY,
    );
    expect(verifyCallerToken(token, "some-other-key")).toBeNull();
  });

  test("rejects an expired token", () => {
    const token = mintCallerToken(
      { callerId: "user-a", spaceId: "dm-123", exp: past() },
      KEY,
    );
    expect(verifyCallerToken(token, KEY)).toBeNull();
  });

  test("rejects malformed tokens", () => {
    expect(verifyCallerToken("", KEY)).toBeNull();
    expect(verifyCallerToken("no-dot", KEY)).toBeNull();
    expect(verifyCallerToken(".", KEY)).toBeNull();
    expect(verifyCallerToken("abc.", KEY)).toBeNull();
    expect(verifyCallerToken(".abc", KEY)).toBeNull();
  });

  test("an attacker cannot forge a token without the key", () => {
    // Mint with the real key, then try to verify a self-made token that claims
    // a different caller but is signed with a guessed key.
    const guessed = mintCallerToken(
      { callerId: "victim", spaceId: "dm-123", exp: future() },
      "guessed-key",
    );
    expect(verifyCallerToken(guessed, KEY)).toBeNull();
  });

  test("ephemeral key round-trips within a process when no key configured", () => {
    const token = mintCallerToken({
      callerId: "user-a",
      spaceId: "dm-123",
      exp: future(),
    });
    // Same process → same lazily-generated ephemeral key → verifies.
    expect(verifyCallerToken(token)).toEqual({
      callerId: "user-a",
      spaceId: "dm-123",
    });
  });
});
