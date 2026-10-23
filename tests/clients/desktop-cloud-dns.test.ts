import { expect, mock, test } from "bun:test";
import { createCloudAddressResolver } from "../../src/chatgpt/cloud-network/dns";
import { startCloudNetwork } from "../../src/chatgpt/cloud-network/runtime";
import { CLOUD_HOST } from "../../src/chatgpt/cloud-network/contract";
import { cloudFixture } from "../helpers/cloud-network-fixture";

const answer = (addresses = ["203.0.113.10", "203.0.113.11"], ttl = 30) => Response.json({
  Status: 0, Answer: addresses.map(data => ({ type: 1, data, TTL: ttl })),
});

test("cloud DNS uses the selected proxy and fixed HTTPS IP endpoint, coalesces lookups and refreshes at TTL", async () => {
  let now = 0;
  const fetchDns = mock(async () => answer(now ? ["203.0.113.20"] : undefined));
  const proxy = "socks5h://127.0.0.1:1080";
  const resolve = createCloudAddressResolver(proxy, { fetch: fetchDns, now: () => now });
  expect(await Promise.all([resolve(), resolve()])).toEqual(["203.0.113.10", "203.0.113.11"]);
  expect(fetchDns).toHaveBeenCalledTimes(1);
  const [url, init] = fetchDns.mock.calls[0]! as unknown as [string, RequestInit & { proxy: string }];
  expect(url).toBe(`https://1.1.1.1/dns-query?name=${CLOUD_HOST}&type=A`);
  expect(init).toMatchObject({ proxy, headers: { accept: "application/dns-json" }, redirect: "error" });
  now = 29_999;
  expect(await resolve()).toBe("203.0.113.10");
  now = 30_000;
  expect(await resolve()).toBe("203.0.113.20");
  expect(fetchDns).toHaveBeenCalledTimes(2);
});

test("DNS failure never reuses an expired answer; a later request can recover", async () => {
  let now = 0, failing = false;
  const fetchDns = mock(async () => failing ? new Response(null, { status: 503 }) : answer(["203.0.113.10"], 1));
  const resolve = createCloudAddressResolver("http://127.0.0.1:8123", { fetch: fetchDns, now: () => now });
  expect(await resolve()).toBe("203.0.113.10");
  now = 1000; failing = true;
  await expect(resolve()).rejects.toThrow("cloud_dns_failed");
  failing = false;
  expect(await resolve()).toBe("203.0.113.10");
  expect(fetchDns).toHaveBeenCalledTimes(3);
});

test("non-answer and non-IP records never become a CONNECT target", async () => {
  for (const response of [
    { Status: 2, Answer: [{ type: 1, data: "203.0.113.10", TTL: 30 }] },
    { Status: 0, Answer: [{ type: 5, data: "alias.example", TTL: 30 }] },
    { Status: 0, Answer: [{ type: 1, data: CLOUD_HOST, TTL: 30 }] },
  ]) {
    const resolve = createCloudAddressResolver("http://127.0.0.1:8123", { fetch: async () => Response.json(response) });
    await expect(resolve()).rejects.toThrow("cloud_dns_no_ipv4_answer");
  }
});

test("runtime shutdown signal cancels an outstanding DNS request", async () => {
  const stop = new AbortController();
  const resolve = createCloudAddressResolver("http://127.0.0.1:8123", {
    signal: stop.signal,
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  });
  const pending = resolve();
  stop.abort();
  await expect(pending).rejects.toThrow("cancelled");
});

test.skipIf(process.platform === "win32")("failed DNS preflight leaves the hosts mapping untouched", async () => {
  const f = cloudFixture(), helper = await f.startHelper();
  const original = f.read();
  try {
    await expect(startCloudNetwork({ helperSocket: f.socketPath, listenPort: 0,
      env: { HTTPS_PROXY: "http://127.0.0.1:1" },
      resolveAddress: async () => { throw new Error("DNS unavailable"); },
    })).rejects.toThrow("cloud_listener_or_upstream_failed");
    expect(f.read()).toBe(original);
  } finally { await helper.stop(); f.cleanup(); }
});
