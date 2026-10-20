import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { CLOUD_ENTRY_PORT, CloudNetworkError } from "./contract";
import type { CloudMappingOperations } from "./helper";

/** Root binds only loopback 443 and forwards opaque bytes to the fixed ordinary-user entry. */
export async function startPrivilegedCloudRelay(port = 443, targetPort = CLOUD_ENTRY_PORT) {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  })();
  const accept = (client: Socket) => {
    client.pause();
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(client); sockets.add(upstream);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("error", close); upstream.on("error", close);
    client.once("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
    upstream.setTimeout(5_000, close);
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      client.pipe(upstream).pipe(client);
      client.resume();
    });
  };
  try {
    const endpoints = [];
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(accept);
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port, ipv6Only: host === "::1" }, () => {
          server.off("error", reject); resolve();
        });
      });
      endpoints.push({ host, port: (server.address() as AddressInfo).port });
    }
    return { endpoints, stop };
  } catch {
    await stop();
    throw new CloudNetworkError("cloud_privileged_listener_failed");
  }
}

/** The control-socket lease owns both listeners and mapping; recovery removes the mapping first. */
export function privilegedCloudMapping(mapping: CloudMappingOperations,
  start = () => startPrivilegedCloudRelay()): CloudMappingOperations {
  let relay: Awaited<ReturnType<typeof startPrivilegedCloudRelay>> | undefined;
  const recover = async () => {
    try { await mapping.recover(); }
    finally {
      const previous = relay;
      relay = undefined;
      await previous?.stop();
    }
  };
  return {
    async apply() {
      await recover();
      relay = await start();
      await mapping.apply();
    },
    recover,
  };
}
