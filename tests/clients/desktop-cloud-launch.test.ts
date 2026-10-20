import { expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const cases: [string, number, string[]][] = [
  ["existing-shim", 0, ["prepare-shim", "open-with-shim"]],
  ["inactive", 1, ["cloud-status"]],
  ["cloud-only", 0, ["cloud-status", "verify-bundle", "open-native"]],
  ["cloud-and-shim", 0, ["cloud-status", "prepare-shim", "open-with-shim"]],
  ["untrusted", 1, ["cloud-status", "verify-bundle"]],
  ["recovery-fails", 1, ["cloud-recover"]],
];
for (const [scenario, code, calls] of cases) test(`local desktop cloud launch: ${scenario}`, async () => {
  const child = Bun.spawn([process.execPath, "run", repoPath("tests/helpers/cloud-network-launch.ts"), scenario],
    { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, error: exit ? error : "" }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ code, calls });
});
