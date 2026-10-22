import { expect, mock, test } from "bun:test";
import type { Server } from "bun";
import { LINK_CHILD_PARITY_PATH } from "../../src/link/child-parity";
import { linkPeerReportHeaders } from "../../src/link/peer-report";
import { LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_VERSION, linkRelayChallenge } from "../../src/link/relay-auth";
import type { LinkStore } from "../../src/link/store";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { createOptionalListenerSet } from "../../src/server/index/optional-listeners";
import type { OcxConfig } from "../../src/types";
import { createTempHome } from "../helpers/temp-home";

test("optional listeners compose cloud lifecycle, peer observations and only the Child parity write", async () => {
  const home = createTempHome("ocx-cloud-link-composition-");
  const linkId = "lnk_0123456789abcdef", keyId = "composition-key";
  const key = `ocx_data_${"c".repeat(40)}`, createdAt = "2026-10-01T00:00:00.000Z";
  let store: LinkStore = { version: 1, listenerPort: null, links: [{
    id: linkId, alias: "fixture-child", direction: "client-initiated", hostKeyFingerprint: null,
    tunnelPort: 22222, apiKeyId: keyId, createdAt,
  }] };
  // Invoke the captured listener in memory: no TCP bind, SSH, helper or system mapping.
  let handle!: NonNullable<Parameters<typeof Bun.serve>[0]["fetch"]>;
  const server = { port: 19123, stop: mock(async () => {}),
    requestIP: () => ({ address: "127.0.0.1", port: 32123, family: "IPv4" }),
  } as unknown as Server<unknown>;
  const cloudStart = mock(async () => ({ endpoints: [], stop: async () => {}, lost: new Promise<boolean>(() => {}) }));
  const listeners = createOptionalListenerSet({
    storePath: home.path("links.json"), readStore: () => store, writeStore: (_path, next) => { store = next; },
    serve: options => { handle = options.fetch!; return server; },
  }, { platform: "darwin", start: cloudStart, recover: async () => {}, warn: () => {} });
  listeners.linkSupervisor().start = () => {};
  const config: OcxConfig = { port: 0, providers: {}, defaultProvider: "openai", chatgptDesktop: { cloudNetwork: true },
    claudeCode: { enabled: false, intercept: { enabled: false } }, apiKeys: [{ id: keyId, name: "fixture", key, createdAt }] };
  try {
    const cloud = listeners.cloudNetwork();
    expect(listeners.cloudNetwork()).toBe(cloud);
    listeners.start({ config, publicPort: 0, requestedPort: 0, maxRequestBodySize: 1024,
      dispatch: async () => new Response(null, { status: 204 }) });
    await cloud.settled();
    expect(cloudStart).toHaveBeenCalledTimes(1);
    expect(cloud.status()).toMatchObject({ configured: true, state: "active" });
    expect(listeners.ingressOf(server)).toBe("hub-link");
    expect(listeners.peerObservation(linkId)).toEqual({ observed: null, refused: null });

    const proof = linkRelayChallenge(serviceApiTokenFingerprint(key), keyId, linkId);
    const challenge = new URL(LINK_RELAY_AUTH_PATH, "http://opencodex-link.invalid");
    challenge.search = new URLSearchParams({ version: LINK_RELAY_AUTH_VERSION, key: keyId, link: linkId,
      nonce: proof.nonce, proof: proof.caller }).toString();
    const features = [`relay-auth/${LINK_RELAY_AUTH_VERSION}`];
    const response = await handle.call(server, new Request(challenge, { headers: linkPeerReportHeaders("2.91.0", features) }), server);
    expect(response?.status).toBe(204);
    expect(response?.headers.get("x-opencodex-link-proof")).toBe(proof.expected);
    expect(listeners.peerObservation(linkId)).toMatchObject({
      observed: { reported: true, relayAuth: LINK_RELAY_AUTH_VERSION, version: "2.91.0", features }, refused: null,
    });
    expect(listeners.peerObservation("lnk_fedcba9876543210")).toEqual({ observed: null, refused: null });

    const allowed = (path: string, method: string, headers?: HeadersInit) => {
      const req = new Request(new URL(path, "http://opencodex-link.invalid"), { method, headers });
      return listeners.linkRouteAllowed(new URL(req.url), req);
    };
    expect(LINK_CHILD_PARITY_PATH).toBe("/v1/link-management/child-parity");
    expect(allowed(LINK_CHILD_PARITY_PATH, "POST")).toBe(true);
    expect(allowed("/v1/models", "GET")).toBe(true);
    expect(allowed("/v1/link-management/api/settings", "GET")).toBe(true);
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(allowed(LINK_CHILD_PARITY_PATH, method)).toBe(false);
    }
    for (const path of [`${LINK_CHILD_PARITY_PATH}?extra=1`, `${LINK_CHILD_PARITY_PATH}/`,
      "/v1/link-management/api/settings", "/v1/link-management/codex-settings", "/api/settings"]) {
      expect(allowed(path, "POST")).toBe(false);
    }
    expect(allowed(LINK_CHILD_PARITY_PATH, "POST", { upgrade: "websocket" })).toBe(false);
    expect(allowed(LINK_CHILD_PARITY_PATH, "POST", { upgrade: "" })).toBe(false);
  } finally {
    try { await listeners.stop(); } finally { home.remove(); }
  }
});
