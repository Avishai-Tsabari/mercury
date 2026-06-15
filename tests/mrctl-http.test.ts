import { describe, expect, test } from "bun:test";
import { buildRequestInit } from "../src/cli/mrctl-http.js";

const headers = {
  "x-mercury-caller": "u1",
  "x-mercury-space": "s1",
  "content-type": "application/json",
  authorization: "Bearer secret",
};

describe("buildRequestInit", () => {
  test("runc/local: no unix field when API_SOCKET is undefined", () => {
    const init = buildRequestInit("GET", headers, undefined, undefined);
    expect("unix" in init).toBe(false);
    expect(init.method).toBe("GET");
    expect(init.headers).toBe(headers);
  });

  test("gVisor: sets unix to the socket path when API_SOCKET is set", () => {
    const init = buildRequestInit(
      "POST",
      headers,
      { a: 1 },
      "/run/mercury/api-abc.sock",
    );
    expect(init.unix).toBe("/run/mercury/api-abc.sock");
    expect(init.method).toBe("POST");
  });

  test("serializes a body to JSON, omits body when absent", () => {
    expect(buildRequestInit("POST", headers, { a: 1 }, undefined).body).toBe(
      JSON.stringify({ a: 1 }),
    );
    expect(
      buildRequestInit("GET", headers, undefined, undefined).body,
    ).toBeUndefined();
  });

  test("empty-string socket is treated as no socket (falls back to TCP)", () => {
    // An empty API_SOCKET must not produce unix:"" — that would be an invalid
    // transport. The runsc env injection drops empty values, but guard anyway.
    const init = buildRequestInit("GET", headers, undefined, "");
    expect("unix" in init).toBe(false);
  });
});
