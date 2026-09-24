/**
 * Claude Desktop picker mode: narrowly rewrite the Code bootstrap catalog.
 * A failed or inapplicable transform leaves the upstream bytes untouched.
 */
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** One opencodex model offered in Desktop's Code-tab picker. */
export interface PickerModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
}

export const BOOTSTRAP_MAX_ENCODED_BYTES = 4 * 1024 * 1024;
export const BOOTSTRAP_MAX_DECODED_BYTES = 16 * 1024 * 1024;
export const PICKER_SURFACE_ID = "code";
const BOOTSTRAP_PATH = /^\/(?:edge-api|api)\/bootstrap(?:\/[A-Za-z0-9-]+\/app_start)?\/?$/;
const REWRITE_REMOVED_HEADERS = new Set([
  "content-encoding", "content-length", "etag", "digest", "content-md5", "transfer-encoding",
]);

export function isPickerBootstrapRequest(method: string, pathname: string): boolean {
  return method === "GET" && BOOTSTRAP_PATH.test(pathname);
}

export function narrowBootstrapAcceptEncoding(): string {
  return "gzip, deflate, br";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function injectPickerModels(bootstrap: unknown, models: readonly PickerModelEntry[]): number {
  const surfaces = record(bootstrap)?.model_selector_config;
  if (!Array.isArray(surfaces)) return 0;
  const surface = surfaces.map(record).find(entry => entry?.id === PICKER_SURFACE_ID);
  if (!surface || !Array.isArray(surface.models)) return 0;
  const entries = surface.models as unknown[];
  const template = entries.map(record).find(entry =>
    typeof entry?.id === "string" && entry.id.startsWith("claude-")
    && !entry.disabled && !entry.disabled_reason && entry.section !== "deprecated");
  if (!template) return 0;
  const existing = new Set(entries.map(record).map(entry => entry?.id));
  let added = 0;
  for (const model of models) {
    if (existing.has(model.id)) continue;
    const copy = structuredClone(template);
    copy.id = model.id;
    copy.name = model.name;
    copy.section = "main";
    if (model.contextWindow === undefined) delete copy.context_window;
    else copy.context_window = model.contextWindow;
    for (const key of Object.keys(copy)) {
      if (["disabled", "disabled_reason", "badge", "tooltip", "description", "fast_mode"].includes(key)
        || /version/i.test(key)) delete copy[key];
    }
    entries.push(copy);
    existing.add(model.id);
    added++;
  }
  return added;
}

export function rewriteBootstrapBody(
  encoded: Buffer, contentEncoding: string | undefined, models: readonly PickerModelEntry[],
): Buffer | null {
  if (encoded.length > BOOTSTRAP_MAX_ENCODED_BYTES) return null;
  const encoding = contentEncoding?.trim().toLowerCase() || "identity";
  let decoded: Buffer;
  try {
    switch (encoding) {
      case "identity": decoded = encoded; break;
      case "gzip":
      case "x-gzip": decoded = gunzipSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      case "deflate": decoded = inflateSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      case "br": decoded = brotliDecompressSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      default: return null;
    }
    if (decoded.length > BOOTSTRAP_MAX_DECODED_BYTES) return null;
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (injectPickerModels(parsed, models) === 0) return null;
    return Buffer.from(JSON.stringify(parsed), "utf8");
  } catch {
    return null;
  }
}

/** Rewritten payloads are identity encoded, so stale validators and sizes must go. */
export function rewrittenHeaders(raw: readonly string[], bodyLength: number): string[] {
  const result: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (!REWRITE_REMOVED_HEADERS.has(raw[i]!.toLowerCase())) result.push(raw[i]!, raw[i + 1]!);
  }
  result.push("Content-Length", String(bodyLength));
  return result;
}
