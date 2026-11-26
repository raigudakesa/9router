import crypto from "node:crypto";

const CHARSETS = {
  lalpha: "abcdefghijklmnopqrstuvwxyz",
  ualpha: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ralpha: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  num: "0123456789",
  symbol: "-._~",
};

const MAX_LENGTH = 256;
const MAX_REF_DEPTH = 20;

// Uniform random int in [0, max) via rejection sampling (no modulo bias).
function secureRandomInt(max) {
  if (max <= 0) return 0;
  const limit = Math.floor(0xffffffff / max) * max;
  let x;
  do {
    x = crypto.randomBytes(4).readUInt32BE(0);
  } while (x >= limit);
  return x % max;
}

// --- opencode session id --------------------------------------------------
// Mirrors anomalyco/opencode's Identifier: create("ses", "descending").
// Format: "ses_" + 12 hex (descending-encoded Date.now()*0x1000 + counter,
// 6 big-endian bytes) + 14 base62 random chars = "ses_" + 26 chars.
// Ref: packages/opencode/src/id/id.ts (LENGTH = 26, prefix session = "ses").
const OPENCODE_ID_LENGTH = 26;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Module-local monotonic counter (matches opencode's per-timestamp counter).
let ocLastTimestamp = 0;
let ocCounter = 0;

function randomBase62(length) {
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) result += BASE62[bytes[i] % 62];
  return result;
}

// Generate a fresh opencode-style session id ("ses_...").
export function generateOpencodeSessionId(timestamp = Date.now()) {
  if (timestamp !== ocLastTimestamp) {
    ocLastTimestamp = timestamp;
    ocCounter = 0;
  }
  ocCounter++;

  // descending direction: bit-inverted, so newer ids sort first
  let now = BigInt(timestamp) * BigInt(0x1000) + BigInt(ocCounter);
  now = ~now;

  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }

  return "ses_" + timeBytes.toString("hex") + randomBase62(OPENCODE_ID_LENGTH - 12);
}

// Special standalone tokens: exact-match only, not combinable, no length param.
const SPECIAL_TOKENS = {
  opencode_session: () => generateOpencodeSessionId(),
};

// Resolve one {charset[_charset...][:length]} token → string, or null if invalid.
function resolveDynamicToken(inner, random) {
  const [charsetPart, lengthPart] = inner.split(":");
  const names = charsetPart.split("_");
  let pool = "";
  for (const n of names) {
    const set = CHARSETS[n];
    if (!set) return null; // unknown charset → leave literal
    pool += set;
  }
  let length = 1;
  if (lengthPart !== undefined) {
    if (!/^\d+$/.test(lengthPart)) return null;
    length = parseInt(lengthPart, 10);
    if (length < 1 || length > MAX_LENGTH) return null;
  }
  let out = "";
  for (let i = 0; i < length; i++) out += pool[random(pool.length)];
  return out;
}

// Resolve ONLY dynamic tags in a string. Header refs left untouched.
export function resolveTemplateValue(value, opts = {}) {
  if (typeof value !== "string") return "";
  const random = opts.random || secureRandomInt;
  return value.replace(/\{([^{}:]+(?::\d+)?)\}/g, (match, inner) => {
    if (inner.startsWith("header:")) return match; // header ref handled later
    // Special standalone tokens (exact match, not combinable, no length).
    const special = SPECIAL_TOKENS[inner];
    if (special) return special();
    const resolved = resolveDynamicToken(inner, random);
    return resolved === null ? match : resolved;
  });
}

// Resolve {header:Name} refs against a resolved-value map (case-insensitive).
function resolveRefs(value, lowerMap, depth) {
  if (depth > MAX_REF_DEPTH) return value.replace(/\{header:[^{}]+\}/g, "");
  return value.replace(/\{header:([^{}]+)\}/g, (_m, name) => {
    const target = lowerMap[name.trim().toLowerCase()];
    if (target === undefined) return "";
    return resolveRefs(target, lowerMap, depth + 1);
  });
}
// Sentinel emitted for a header whose value cannot be produced — {remove}, or a
// {forward:Name} reference whose source header is absent/blank. Consumers
// (buildHeaders) must delete the header and NOT send it.
export const REMOVE_HEADER = "\u0000__9R_REMOVE__";

// Lowercase a request-header bag (plain object from Node, or Headers-like).
function lowerHeaderMap(source) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  const entries = typeof source.entries === "function" ? [...source.entries()] : Object.entries(source);
  for (const [name, value] of entries) {
    if (typeof name !== "string") continue;
    const v = Array.isArray(value) ? value.join(", ") : value;
    if (v === undefined || v === null) continue;
    out[name.toLowerCase()] = String(v);
  }
  return out;
}

// Node's fetch/undici add a User-Agent of their own ("node", "undici/6.x") when
// the caller set none — a transport default, not a client identity. Forwarding it
// would shadow the configured fallback with the runtime's name.
const SYNTHETIC_UA_RE = /^(?:node|undici)(?:\/[\d.]+)?$/i;

// Resolve {forward:Name} refs from the inbound client request headers.
// Returns null when any referenced header is absent or blank: a forwarded value
// must never be sent empty, so the caller drops the whole header.
function resolveForwardRefs(value, lowerRequestHeaders) {
  if (value.indexOf("{forward:") === -1) return value;
  let missing = false;
  const out = value.replace(/\{forward:([^{}]+)\}/g, (_m, name) => {
    const key = name.trim().toLowerCase();
    const v = lowerRequestHeaders[key];
    if (v === undefined || v.trim() === "" || (key === "user-agent" && SYNTHETIC_UA_RE.test(v.trim()))) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : out;
}
// Resolve {forward:...} from the request, then dynamic tags. Null = cannot be
// produced (a forwarded source header is absent/blank).
function resolveRawValue(raw, lowerReq) {
  const forwarded = resolveForwardRefs(raw, lowerReq);
  return forwarded === null ? null : resolveTemplateValue(forwarded);
}

// Resolve custom headers for one request.
//   customHeaders (primary) — sent as-is.
//   fallbackHeaders (defaults) — per-name fallbacks: used when the primary value
//   is absent/empty/unresolvable ({remove} or a {forward:...} miss), and added
//   outright when the primary list has no row of that name. Both accept the same
//   tags ({forward:Name}, dynamic tags, {header:Name}).
// `resolveValue(name, rawValue, defaultResolve)` is the persistence hook; it is
// only consulted for the effective (primary or fallback) raw value.
export function resolveCustomHeaders(customHeaders, { resolveValue, requestHeaders, fallbackHeaders } = {}) {
  if (!Array.isArray(customHeaders) && !Array.isArray(fallbackHeaders)) return {};
  const lowerReq = lowerHeaderMap(requestHeaders);

  // Dedup by case-insensitive name, last wins; skip empty names.
  const dedupe = (rows) => {
    const byLower = new Map(); // lowerName → {name, value}
    if (!Array.isArray(rows)) return byLower;
    for (const h of rows) {
      if (!h || typeof h.name !== "string") continue;
      const name = h.name.trim();
      if (!name) continue;
      byLower.set(name.toLowerCase(), { name, value: typeof h.value === "string" ? h.value : "" });
    }
    return byLower;
  };
  const primary = dedupe(customHeaders);
  const fallback = dedupe(fallbackHeaders);

  // Resolve one row: {remove} short-circuits to the sentinel, then the hook
  // (persist cache) wraps the raw-value resolution. null/'' → not sendable.
  const resolveRow = (name, raw) => {
    const defaultResolve = () => resolveRawValue(raw, lowerReq);
    const resolved = resolveValue ? resolveValue(name, raw, defaultResolve) : defaultResolve();
    return resolved === null || resolved === undefined || String(resolved).trim() === ""
      ? REMOVE_HEADER
      : resolved;
  };

  const pass1 = [];
  const lowerMap = {};
  for (const [key, { name, value }] of primary) {
    if (value.trim() === "{remove}") {
      pass1.push({ name, value: REMOVE_HEADER });
      lowerMap[key] = ""; // a {header:...} ref to a removed header → ""
      continue;
    }
    let finalValue = resolveRow(name, value);
    // Primary unavailable → its fallback (same name) takes over.
    const fb = fallback.get(key);
    if (finalValue === REMOVE_HEADER && fb && fb.value.trim() && fb.value.trim() !== "{remove}") {
      finalValue = resolveRow(name, fb.value);
    }
    pass1.push({ name, value: finalValue });
    lowerMap[key] = finalValue === REMOVE_HEADER ? "" : finalValue;
  }

  // Fallback-only names (no primary row) are always sent.
  for (const [key, { name, value }] of fallback) {
    if (primary.has(key)) continue;
    const finalValue = value.trim() === "{remove}" ? REMOVE_HEADER : resolveRow(name, value);
    pass1.push({ name, value: finalValue });
    lowerMap[key] = finalValue === REMOVE_HEADER ? "" : finalValue;
  }

  // Final pass: resolve {header:Name} refs against resolved values.
  const out = {};
  for (const { name, value } of pass1) {
    out[name] = value === REMOVE_HEADER ? REMOVE_HEADER : resolveRefs(value, lowerMap, 0).replace(/[\r\n]/g, "");
  }
  return out;
}

// Apply a name→value override map (dashboard "Custom Headers" card / provider
// settings) onto a built header set. Case-insensitive replace: a plain
// Object.assign leaves `Accept` and `accept` side by side, and fetch merges
// duplicates into "a, b" instead of replacing. `{remove}` drops the header.
export function applyHeaderOverrides(headers, overrides) {
  if (!headers || !overrides) return headers;
  for (const [name, rawValue] of Object.entries(overrides)) {
    const existing = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    if (existing) delete headers[existing];
    if (typeof rawValue === "string" && rawValue.trim() === "{remove}") continue;
    headers[name] = rawValue;
  }
  return headers;
}
// Names whose value is the {remove} directive, from either shape we store:
// node customHeaders rows ([{name, value}]) or a provider override map
// ({name: value}). Used to strip headers that only exist after fetch injects
// them (sec-fetch-mode, the default accept) — those cannot be deleted from the
// header set handed to fetch, only from the dispatcher payload.
export function collectRemoveHeaders(source) {
  const out = [];
  if (Array.isArray(source)) {
    for (const h of source) {
      if (h && typeof h.name === "string" && h.name.trim() && typeof h.value === "string" && h.value.trim() === "{remove}") {
        out.push(h.name.trim());
      }
    }
  } else if (source && typeof source === "object") {
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === "string" && value.trim() === "{remove}") out.push(name);
    }
  }
  return out;
}
