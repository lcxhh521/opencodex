import { isIPv4 } from "node:net";
import { configuredOutboundFetch, type ProxyCapableRequestInit } from "../../lib/proxy-env";
import { CLOUD_HOST, CloudNetworkError } from "./contract";

const CLOUD_DNS_URL = `https://1.1.1.1/dns-query?name=${CLOUD_HOST}&type=A`;
interface DnsRecord { type: number; data: string; TTL: number }
interface AddressCache { addresses: string[]; expires: number }

/** Resolve outside the local hosts mapping and the proxy's ordinary DNS path. */
export function createCloudAddressResolver(proxy: string, options: {
  signal?: AbortSignal;
  fetch?: typeof configuredOutboundFetch;
  now?: () => number;
} = {}): () => Promise<string> {
  const fetchDns = options.fetch ?? configuredOutboundFetch;
  const now = options.now ?? Date.now;
  let cache: AddressCache | undefined;
  let pending: Promise<AddressCache> | undefined;
  let next = 0;
  const lookup = async (): Promise<AddressCache> => {
    const timeout = AbortSignal.timeout(12_000);
    const response = await fetchDns(CLOUD_DNS_URL, {
      proxy,
      headers: { accept: "application/dns-json" },
      redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    } as ProxyCapableRequestInit);
    if (!response.ok) throw new CloudNetworkError("cloud_dns_failed");
    const answer = await response.json() as { Status: number; Answer?: DnsRecord[] };
    const records = (Array.isArray(answer.Answer) ? answer.Answer : []).filter(record =>
      record.type === 1 && isIPv4(record.data) && Number.isFinite(record.TTL) && record.TTL >= 0);
    if (answer.Status !== 0 || !records.length) throw new CloudNetworkError("cloud_dns_no_ipv4_answer");
    return { addresses: records.map(record => record.data), expires: now() + Math.min(...records.map(record => record.TTL)) * 1000 };
  };
  return async () => {
    if (!cache || now() >= cache.expires) {
      pending ??= lookup().then(result => { cache = result; return result; }).finally(() => { pending = undefined; });
      cache = await pending;
    }
    return cache.addresses[next++ % cache.addresses.length]!;
  };
}
