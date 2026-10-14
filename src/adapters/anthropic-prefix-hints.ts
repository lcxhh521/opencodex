import type { AdapterEvent, AnthropicPrefixHint } from "../types";

// Neither events nor provider blocks expose these observations in public JSON/log surfaces.
const observations = new WeakMap<object, AnthropicPrefixHint>();
const locallyIssued = new WeakMap<object, object>();
export function getAnthropicPrefixHint(value: object): AnthropicPrefixHint | undefined { return observations.get(value); }
export function setAnthropicPrefixHint(value: object, hint: AnthropicPrefixHint): void { observations.set(value, hint); }
export function issueAnthropicPrefixHint(event: AdapterEvent, hint: AnthropicPrefixHint, generation: object = hint): void {
  locallyIssued.set(hint, generation); observations.set(event, hint);
}
export function isLocallyIssuedAnthropicPrefixHint(hint: AnthropicPrefixHint, generation?: object): boolean { return generation ? locallyIssued.get(hint) === generation : locallyIssued.has(hint); }
