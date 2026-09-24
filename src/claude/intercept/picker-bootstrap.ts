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

/** Why a bootstrap was left unchanged, for the metadata-only picker log. Never carries values. */
export type PickerInjectionOutcome =
  | { kind: "rewritten"; added: number }
  | { kind: "unchanged"; reason: string };

export function injectPickerModels(
  bootstrap: unknown,
  models: readonly PickerModelEntry[],
  explain?: (outcome: PickerInjectionOutcome) => void,
): number {
  const unchanged = (reason: string): number => { explain?.({ kind: "unchanged", reason }); return 0; };
  const surfaces = record(bootstrap)?.model_selector_config;
  if (!Array.isArray(surfaces)) return unchanged("no_model_selector_config");
  const surface = surfaces.map(record).find(entry => entry?.id === PICKER_SURFACE_ID);
  if (!surface || !Array.isArray(surface.models)) {
    // Surface ids are Anthropic's fixed names (for example "code"), not user data.
    const ids = surfaces.map(record).map(entry => typeof entry?.id === "string" ? entry.id.slice(0, 32) : "?");
    return unchanged(`no_code_surface(${ids.join(",")})`);
  }
  const entries = surface.models as unknown[];
  const template = entries.map(record).find(entry =>
    typeof entry?.id === "string" && entry.id.startsWith("claude-")
    && !entry.disabled && !entry.disabled_reason && entry.section !== "deprecated");
  if (!template) return unchanged(`no_template(models=${entries.length})`);
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
  if (added === 0) return unchanged(models.length === 0 ? "no_routes" : "all_present");
  explain?.({ kind: "rewritten", added });
  return added;
}

export function rewriteBootstrapBody(
  encoded: Buffer,
  contentEncoding: string | undefined,
  models: readonly PickerModelEntry[],
  explain?: (outcome: PickerInjectionOutcome) => void,
): Buffer | null {
  const unchanged = (reason: string): null => { explain?.({ kind: "unchanged", reason }); return null; };
  if (encoded.length > BOOTSTRAP_MAX_ENCODED_BYTES) return unchanged("encoded_cap");
  const encoding = contentEncoding?.trim().toLowerCase() || "identity";
  let decoded: Buffer;
  try {
    switch (encoding) {
      case "identity": decoded = encoded; break;
      case "gzip":
      case "x-gzip": decoded = gunzipSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      case "deflate": decoded = inflateSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      case "br": decoded = brotliDecompressSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      default: return unchanged("unsupported_encoding");
    }
    if (decoded.length > BOOTSTRAP_MAX_DECODED_BYTES) return unchanged("decoded_cap");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (injectPickerModels(parsed, models, explain) === 0) return null;
    return Buffer.from(JSON.stringify(parsed), "utf8");
  } catch {
    return unchanged("decode_or_parse_failed");
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
