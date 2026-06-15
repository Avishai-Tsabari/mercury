import { describe, expect, test } from "bun:test";
import { AgentContainerRunner } from "../src/agent/container-runner.js";
import type { AppConfig } from "../src/config.js";

/**
 * resolveApiHost runs in the constructor and stores the result in the private
 * `resolvedApiHost`. We read it back via a narrow cast. The key security property:
 * in runsc mode the host resolves to a dummy ("localhost") and the constructor
 * performs NO docker side effects — inner containers reach the API over the unix
 * socket, not over docker0. (The old code shelled out `docker network connect
 * bridge $(hostname)` here; that is gone.)
 */
function resolvedApiHost(config: Partial<AppConfig>): string {
  const runner = new AgentContainerRunner({
    agentContainerImage: "mercury-agent:latest",
    containerRuntime: "runc",
    ...config,
  } as AppConfig);
  return (runner as unknown as { resolvedApiHost: string }).resolvedApiHost;
}

describe("AgentContainerRunner.resolveApiHost", () => {
  test("no containerApiHost → host.docker.internal", () => {
    expect(resolvedApiHost({ containerApiHost: undefined })).toBe(
      "host.docker.internal",
    );
  });

  test("runc + containerApiHost → the configured hostname (unchanged)", () => {
    expect(
      resolvedApiHost({
        containerRuntime: "runc",
        containerApiHost: "mercury-agent-abc",
      }),
    ).toBe("mercury-agent-abc");
  });

  test("runsc + containerApiHost → dummy localhost (socket transport)", () => {
    expect(
      resolvedApiHost({
        containerRuntime: "runsc",
        containerApiHost: "mercury-agent-abc",
      }),
    ).toBe("localhost");
  });
});
