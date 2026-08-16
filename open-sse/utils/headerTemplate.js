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

export function resolveCustomHeaders(customHeaders) {
  if (!Array.isArray(customHeaders)) return {};

  // Dedup by case-insensitive name, last wins; skip empty names.
  const byLower = new Map(); // lowerName → {name, value}
  for (const h of customHeaders) {
    if (!h || typeof h.name !== "string") continue;
    const name = h.name.trim();
    if (!name) continue;
    byLower.set(name.toLowerCase(), { name, value: typeof h.value === "string" ? h.value : "" });
  }

  // Pass 1: resolve dynamic tags once per header.
  const pass1 = [];
  const lowerMap = {};
  for (const { name, value } of byLower.values()) {
    const resolved = resolveTemplateValue(value);
    pass1.push({ name, value: resolved });
    lowerMap[name.toLowerCase()] = resolved;
  }

  // Pass 2: resolve {header:Name} refs against pass-1 values.
  const out = {};
  for (const { name, value } of pass1) {
    out[name] = resolveRefs(value, lowerMap, 0).replace(/[\r\n]/g, "");
  }
  return out;
}
