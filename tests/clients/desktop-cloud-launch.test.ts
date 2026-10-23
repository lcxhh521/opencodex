import { expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";
import { runInNewContext } from "node:vm";

const cases: [string, number, string[]][] = [
  ["existing-shim", 0, ["verify-bundle", "prepare-shim", "open-with-shim"]],
  ["inactive", 1, ["cloud-status"]],
  ["cloud-only", 0, ["cloud-status", "verify-bundle", "open-native"]],
  ["cloud-socks", 0, ["cloud-status", "verify-bundle", "open-native"]],
  ["cloud-no-proxy", 0, ["cloud-status", "verify-bundle", "open-native"]],
  ["cloud-pac", 0, ["cloud-status", "verify-bundle", "open-native"]],
  ["cloud-intercept-pac", 0, ["cloud-status", "verify-bundle", "open-intercept"]],
  ["cloud-intercept-system-pac", 0, ["cloud-status", "verify-bundle", "open-intercept"]],
  ["cloud-and-shim", 0, ["cloud-status", "verify-bundle", "prepare-shim", "open-with-shim"]],
  ["untrusted", 1, ["cloud-status", "verify-bundle"]],
  ["recovery-fails", 1, ["verify-bundle", "cloud-recover"]],
];
for (const [scenario, code, calls] of cases) test(`local desktop cloud launch: ${scenario}`, async () => {
  const child = Bun.spawn([process.execPath, "run", repoPath("tests/helpers/cloud-network-launch.ts"), scenario],
    { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, error: exit ? error : "" }).toEqual({ exit: 0, error: "" });
  const result = JSON.parse(out.trim().split("\n").at(-1)!);
  expect({ code: result.code, calls: result.calls, launchEnv: result.launchEnv }).toEqual({ code, calls,
    launchEnv: code === 0 && ["existing-shim", "cloud-and-shim"].includes(scenario) ? ["CODEX_CLI_PATH=<home>/launcher"] : [],
  });
  if (scenario.startsWith("cloud-intercept")) {
    expect(result.interceptCloud).toBe(true);
    const sandbox: Record<string, unknown> = {};
    runInNewContext(result.interceptPac, sandbox);
    const route = sandbox.FindProxyForURL as (url: string, host: string) => string;
    expect(route("https://codex-cloud-backend.chatgpt.com/", "codex-cloud-backend.chatgpt.com")).toBe("DIRECT");
    expect(route("https://chatgpt.com/", "chatgpt.com")).toBe(scenario === "cloud-intercept-pac" ? "PROXY 127.0.0.1:10301; PROXY 127.0.0.1:7892" : "DIRECT");
    expect(route("https://auth.openai.com/", "auth.openai.com")).toBe("PROXY 127.0.0.1:7892");
  } else if (scenario === "cloud-pac") {
    expect(result.launchArgs).toHaveLength(1);
    expect(result.launchArgs[0]).toStartWith("--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,");
    const sandbox: Record<string, unknown> = {};
    runInNewContext(Buffer.from(result.launchArgs[0].split("base64,")[1], "base64").toString(), sandbox);
    const route = sandbox.FindProxyForURL as (url: string, host: string) => string;
    expect(route("https://codex-cloud-backend.chatgpt.com/", "codex-cloud-backend.chatgpt.com")).toBe("DIRECT");
    expect(route("https://chatgpt.com/", "chatgpt.com")).toBe("PROXY 127.0.0.1:7892");
  } else {
    expect(result.launchArgs).toEqual(code === 0 && !["existing-shim", "cloud-no-proxy"].includes(scenario)
      ? [`--proxy-server=${scenario === "cloud-socks" ? "socks5" : "http"}://127.0.0.1:7892,direct://`, "--proxy-bypass-list=codex-cloud-backend.chatgpt.com"] : []);
  }
});
