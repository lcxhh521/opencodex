import { expect, test } from "bun:test";
import { connect, createServer, type Server, type AddressInfo } from "node:net";
import { once } from "node:events";
import { CLOUD_HOST, CLOUD_NETWORK_PROTOCOL } from "../../src/chatgpt/cloud-network/contract";
import { startPrivilegedCloudRelay, privilegedCloudMapping } from "../../src/chatgpt/cloud-network/privileged-relay";
import { serveCloudMapping } from "../../src/chatgpt/cloud-network/helper";
import { acquireCloudMapping, cloudHelperRequest } from "../../src/chatgpt/cloud-network/helper-client";
import { cloudFixture } from "../helpers/cloud-network-fixture";

async function listen(server: Server, host = "127.0.0.1", port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, ipv6Only: host === "::1" }, () => { server.off("error", reject); resolve(); });
  });
  return (server.address() as AddressInfo).port;
}
const closeServer = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
async function refused(endpoint: { host: string; port: number }) {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(endpoint);
    socket.once("error", () => resolve());
    socket.once("connect", () => { socket.destroy(); reject(new Error("released listener is still accepting")); });
  });
}

// Ports are ephemeral here; the real macOS acceptance checks fixed 443 under the installed helper.
test.skipIf(process.platform === "win32")("the helper lease owns forwarding and releases both address families", async () => {
  const f = cloudFixture();
  const original = f.read();
  const echo = createServer(socket => { socket.on("error", () => {}); socket.pipe(socket); });
  const target = await listen(echo);
  let relay: Awaited<ReturnType<typeof startPrivilegedCloudRelay>> | undefined;
  const mapping = privilegedCloudMapping(f.mapping, async () => relay = await startPrivilegedCloudRelay(0, target));
  const helper = await serveCloudMapping({ socketPath: f.socketPath, mapping, uid: process.getuid!(), gid: process.getgid!() });
  try {
    const lease = await acquireCloudMapping(f.socketPath);
    expect(f.read()).toContain(CLOUD_HOST);
    for (const endpoint of relay!.endpoints) {
      const socket = connect(endpoint);
      const received = once(socket, "data");
      socket.write("opaque fixture bytes");
      expect((await received)[0].toString()).toBe("opaque fixture bytes");
      socket.destroy();
    }
    await lease.release();
    expect(f.read()).toBe(original);
    for (const endpoint of relay!.endpoints) await refused(endpoint);
    expect((await cloudHelperRequest("status", f.socketPath)).state).toBe("idle");
  } finally { await helper.stop(); await closeServer(echo); f.cleanup(); }
});

test.skipIf(process.platform === "win32")("a conflicting IPv6 port leaves no hosts mapping or partial IPv4 listener", async () => {
  const f = cloudFixture();
  const original = f.read();
  const blocker = createServer();
  const port = await listen(blocker, "::1");
  const mapping = privilegedCloudMapping(f.mapping, () => startPrivilegedCloudRelay(port, 1));
  const helper = await serveCloudMapping({ socketPath: f.socketPath, mapping, uid: process.getuid!(), gid: process.getgid!() });
  try {
    await expect(acquireCloudMapping(f.socketPath)).rejects.toThrow("cloud_privileged_listener_failed");
    expect(f.read()).toBe(original);
    expect((await cloudHelperRequest("status", f.socketPath)).state).toBe("idle");
    const available = createServer();
    await listen(available, "127.0.0.1", port);
    await closeServer(available);
  } finally { await helper.stop(); await closeServer(blocker); f.cleanup(); }
});

test.skipIf(process.platform === "win32")("disconnect during async activation recovers before the next lease", async () => {
  const f = cloudFixture();
  const original = f.read();
  let begin!: () => void, finish!: () => void;
  const began = new Promise<void>(resolve => { begin = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let first = true;
  let relay: Awaited<ReturnType<typeof startPrivilegedCloudRelay>> | undefined;
  const mapping = privilegedCloudMapping(f.mapping, async () => {
    if (first) { first = false; begin(); await gate; }
    return relay = await startPrivilegedCloudRelay(0, 1);
  });
  const helper = await serveCloudMapping({ socketPath: f.socketPath, mapping, uid: process.getuid!(), gid: process.getgid!() });
  const abandoned = connect(f.socketPath);
  abandoned.on("error", () => {});
  try {
    abandoned.write(JSON.stringify({ protocol: CLOUD_NETWORK_PROTOCOL, action: "acquire" }) + "\n");
    await began;
    abandoned.destroy();
    await Bun.sleep(10); // Deliver the actual Unix-socket close while activation is awaiting its gate.
    finish();
    expect((await cloudHelperRequest("status", f.socketPath)).state).toBe("idle");
    expect(f.read()).toBe(original);
    for (const endpoint of relay!.endpoints) await refused(endpoint);
    const lease = await acquireCloudMapping(f.socketPath);
    await expect(acquireCloudMapping(f.socketPath)).rejects.toThrow("mapping_busy");
    await lease.release();
    expect(f.read()).toBe(original);
  } finally { finish(); abandoned.destroy(); await helper.stop(); f.cleanup(); }
});

test.skipIf(process.platform === "win32")("v2 runtime rejects a v1 helper that cannot own privileged listeners", async () => {
  const f = cloudFixture();
  const legacy = createServer(socket => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end('{"protocol":1,"ok":true,"state":"idle"}\n'));
  });
  await new Promise<void>(resolve => legacy.listen(f.socketPath, resolve));
  try { await expect(cloudHelperRequest("status", f.socketPath)).rejects.toThrow("helper_disconnected"); }
  finally { await closeServer(legacy); f.cleanup(); }
});
