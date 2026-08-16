# Custom Request Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add custom request headers (with per-request dynamic-value tags and header-to-header references) to compatible provider nodes via the edit modal, sent to the upstream on every request.

**Architecture:** Headers are stored raw on the provider node (`customHeaders: [{name,value}]`), propagated into each connection's `providerSpecificData`, and resolved per-request by a new pure util (`open-sse/utils/headerTemplate.js`) inside `DefaultExecutor.buildHeaders()`, merged last (case-insensitive override of presets, fail-open).

**Tech Stack:** Next.js (JS/ESM, React), SQLite repos, `open-sse` engine, vitest.

## Global Constraints

- Plain JavaScript ESM. No TypeScript. `@/*` alias → `src/*`; `open-sse/*` alias → engine root (both resolved by vitest config).
- Config-driven, DRY, camelCase (per `open-sse/AGENTS.md`).
- Node data persists arbitrary keys via `nodesRepo.js` — NO schema/migration change.
- Resolver MUST be fail-open: any throw → skip custom headers, never break a request (matches `rtk/` convention).
- Custom headers apply LAST in `buildHeaders`, override any preset incl. auth/`Accept`, case-insensitive key match.
- Charsets: `lalpha`=a-z, `ualpha`=A-Z, `ralpha`=a-zA-Z, `num`=0-9, `symbol`=`-._~`. Tag grammar `{charset[_charset...][:length]}`, default length 1, max length 256. Header ref `{header:Name}` case-insensitive, missing→empty, cycle-guarded.
- Randomness via `crypto` with rejection sampling (no modulo bias).
- Tests: run with `npx vitest run <path>` from `tests/` dir.

---

### Task 1: Header template resolver

**Files:**
- Create: `open-sse/utils/headerTemplate.js`
- Test: `tests/unit/header-template.test.js`

**Interfaces:**
- Consumes: `crypto` (node builtin).
- Produces:
  - `resolveCustomHeaders(customHeaders)` — input `Array<{name:string,value:string}>`, output `{ [name:string]: string }`. Dedup by case-insensitive name (last wins), skips rows with empty/whitespace name. Dynamic tags resolved once (pass 1), then `{header:Name}` refs resolved against pass-1 values (pass 2, cycle-guarded).
  - `resolveTemplateValue(value, opts?)` — resolves ONLY dynamic tags in a single string (no header refs). Exported for unit testing. `opts.random` optional injectable RNG `(max:int)=>int` for deterministic tests.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/header-template.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { resolveCustomHeaders, resolveTemplateValue } from "open-sse/utils/headerTemplate.js";

// Deterministic RNG: always returns 0 → picks first char of any pool.
const zero = () => 0;

describe("resolveTemplateValue — charsets", () => {
  it("num pool only emits digits, honoring length", () => {
    const out = resolveTemplateValue("{num:5}");
    expect(out).toMatch(/^[0-9]{5}$/);
  });
  it("lalpha only lowercase", () => {
    expect(resolveTemplateValue("{lalpha:20}")).toMatch(/^[a-z]{20}$/);
  });
  it("ualpha only uppercase", () => {
    expect(resolveTemplateValue("{ualpha:20}")).toMatch(/^[A-Z]{20}$/);
  });
  it("ralpha mixes upper+lower only (no digits/symbols)", () => {
    expect(resolveTemplateValue("{ralpha:40}")).toMatch(/^[a-zA-Z]{40}$/);
  });
  it("symbol pool restricted to -._~", () => {
    expect(resolveTemplateValue("{symbol:30}")).toMatch(/^[-._~]{30}$/);
  });
  it("default length is 1", () => {
    expect(resolveTemplateValue("{num}")).toMatch(/^[0-9]$/);
  });
  it("combined charsets pool together", () => {
    expect(resolveTemplateValue("{ralpha_num:50}")).toMatch(/^[a-zA-Z0-9]{50}$/);
  });
  it("keeps literal prefix/suffix around tag", () => {
    expect(resolveTemplateValue("sess_{num:4}_end")).toMatch(/^sess_[0-9]{4}_end$/);
  });
  it("injectable RNG picks deterministic char", () => {
    // pool for num = "0123456789"; zero → "0"
    expect(resolveTemplateValue("{num:3}", { random: zero })).toBe("000");
  });
});

describe("resolveTemplateValue — edge cases", () => {
  it("unknown charset left literal", () => {
    expect(resolveTemplateValue("{foo}")).toBe("{foo}");
  });
  it("length over max (256) left literal", () => {
    expect(resolveTemplateValue("{num:9999}")).toBe("{num:9999}");
  });
  it("zero/negative length left literal", () => {
    expect(resolveTemplateValue("{num:0}")).toBe("{num:0}");
  });
  it("plain text unchanged", () => {
    expect(resolveTemplateValue("Mozilla/5.0 Chrome")).toBe("Mozilla/5.0 Chrome");
  });
});

describe("resolveCustomHeaders — header refs", () => {
  it("copies another header's resolved value", () => {
    const out = resolveCustomHeaders([
      { name: "X-Session", value: "abc123" },
      { name: "X-Copy", value: "{header:X-Session}" },
    ]);
    expect(out["X-Copy"]).toBe("abc123");
  });
  it("ref is case-insensitive on source name", () => {
    const out = resolveCustomHeaders([
      { name: "X-Session", value: "v1" },
      { name: "X-Copy", value: "{header:x-session}" },
    ]);
    expect(out["X-Copy"]).toBe("v1");
  });
  it("ref copies the SAME random as source (single generation)", () => {
    const out = resolveCustomHeaders([
      { name: "X-Session", value: "{ralpha_num:26}" },
      { name: "X-Copy", value: "{header:X-Session}" },
    ]);
    expect(out["X-Copy"]).toBe(out["X-Session"]);
    expect(out["X-Session"]).toMatch(/^[a-zA-Z0-9]{26}$/);
  });
  it("ref can be embedded with literal text", () => {
    const out = resolveCustomHeaders([
      { name: "A", value: "xyz" },
      { name: "B", value: "pre-{header:A}-post" },
    ]);
    expect(out["B"]).toBe("pre-xyz-post");
  });
  it("missing source ref → empty string substitution", () => {
    const out = resolveCustomHeaders([{ name: "B", value: "x{header:Nope}y" }]);
    expect(out["B"]).toBe("xy");
  });
  it("cycle does not hang and resolves without throwing", () => {
    const out = resolveCustomHeaders([
      { name: "A", value: "{header:B}" },
      { name: "B", value: "{header:A}" },
    ]);
    expect(typeof out["A"]).toBe("string");
    expect(typeof out["B"]).toBe("string");
  });
  it("dedupes by case-insensitive name, last wins", () => {
    const out = resolveCustomHeaders([
      { name: "User-Agent", value: "old" },
      { name: "user-agent", value: "new" },
    ]);
    const keys = Object.keys(out).filter((k) => k.toLowerCase() === "user-agent");
    expect(keys).toHaveLength(1);
    expect(out[keys[0]]).toBe("new");
  });
  it("skips rows with empty name", () => {
    const out = resolveCustomHeaders([
      { name: "  ", value: "x" },
      { name: "Keep", value: "y" },
    ]);
    expect(out).toEqual({ Keep: "y" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `tests/`): `npx vitest run unit/header-template.test.js`
Expected: FAIL — cannot resolve module `open-sse/utils/headerTemplate.js`.

- [ ] **Step 3: Write the resolver implementation**

Create `open-sse/utils/headerTemplate.js`:

```javascript
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
    out[name] = resolveRefs(value, lowerMap, 0);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `tests/`): `npx vitest run unit/header-template.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add open-sse/utils/headerTemplate.js tests/unit/header-template.test.js
git commit -m "feat(open-sse): header template resolver with dynamic tags + header refs"
```

---

### Task 2: Apply custom headers in DefaultExecutor.buildHeaders

**Files:**
- Modify: `open-sse/executors/default.js` (import at top; append merge block at end of `buildHeaders`, currently ends ~line 194-195)
- Test: `tests/unit/custom-headers-executor.test.js`

**Interfaces:**
- Consumes: `resolveCustomHeaders` from Task 1; `credentials.providerSpecificData.customHeaders`.
- Produces: `buildHeaders` output now includes/overrides headers from `customHeaders`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/custom-headers-executor.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { DefaultExecutor } from "open-sse/executors/default.js";

const BASE = "https://api.example.com/v1";
function creds(customHeaders, extra = {}) {
  return { apiKey: "sk-test", providerSpecificData: { baseUrl: BASE, apiType: "chat", customHeaders }, ...extra };
}

describe("DefaultExecutor buildHeaders — custom headers", () => {
  it("adds a new custom header", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h = ex.buildHeaders(creds([{ name: "X-Trace", value: "abc" }]), true);
    expect(h["X-Trace"]).toBe("abc");
  });

  it("overrides a preset header case-insensitively (no duplicate)", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h = ex.buildHeaders(creds([{ name: "content-type", value: "text/custom" }]), true);
    const keys = Object.keys(h).filter((k) => k.toLowerCase() === "content-type");
    expect(keys).toHaveLength(1);
    expect(h[keys[0]]).toBe("text/custom");
  });

  it("can override Authorization (auth override allowed by design)", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h = ex.buildHeaders(creds([{ name: "Authorization", value: "Bearer overridden" }]), true);
    const keys = Object.keys(h).filter((k) => k.toLowerCase() === "authorization");
    expect(keys).toHaveLength(1);
    expect(h[keys[0]]).toBe("Bearer overridden");
  });

  it("can override Accept (applied after stream Accept line)", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h = ex.buildHeaders(creds([{ name: "Accept", value: "application/json" }]), true);
    const keys = Object.keys(h).filter((k) => k.toLowerCase() === "accept");
    expect(keys).toHaveLength(1);
    expect(h[keys[0]]).toBe("application/json");
  });

  it("resolves a dynamic tag", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h = ex.buildHeaders(creds([{ name: "X-Session", value: "sess_{ralpha_num:26}" }]), true);
    expect(h["X-Session"]).toMatch(/^sess_[a-zA-Z0-9]{26}$/);
  });

  it("no customHeaders → base headers intact", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h = ex.buildHeaders(creds(undefined), true);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h.Authorization).toBe("Bearer sk-test");
  });

  it("fail-open: a resolver throw leaves base headers intact", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    // customHeaders not an array-of-objects in a shape the resolver can throw on:
    // pass a getter that throws when iterated.
    const bad = { get length() { throw new Error("boom"); } };
    const h = ex.buildHeaders(creds(bad), true);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h.Authorization).toBe("Bearer sk-test");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `tests/`): `npx vitest run unit/custom-headers-executor.test.js`
Expected: FAIL — custom headers not applied (`X-Trace` undefined, etc.).

- [ ] **Step 3: Add the import**

In `open-sse/executors/default.js`, after the existing imports (after line 9, the `stripUnsupportedParams` import), add:

```javascript
import { resolveCustomHeaders } from "../utils/headerTemplate.js";
```

- [ ] **Step 4: Append the merge block at the end of buildHeaders**

In `open-sse/executors/default.js`, `buildHeaders(...)` currently ends:

```javascript
    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }
```

Replace that with (custom headers applied AFTER the Accept line so they win over everything):

```javascript
    if (stream) headers["Accept"] = "text/event-stream";

    // Custom request headers (compatible nodes): applied last, override any
    // preset incl. auth/Accept, case-insensitive. Fail-open: a bad template
    // must never break the request.
    const customHeaders = credentials?.providerSpecificData?.customHeaders;
    if (customHeaders) {
      try {
        const resolved = resolveCustomHeaders(customHeaders);
        for (const [name, value] of Object.entries(resolved)) {
          const existing = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
          if (existing) delete headers[existing];
          headers[name] = value;
        }
      } catch {
        /* fail-open */
      }
    }

    return headers;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `tests/`): `npx vitest run unit/custom-headers-executor.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add open-sse/executors/default.js tests/unit/custom-headers-executor.test.js
git commit -m "feat(open-sse): apply custom headers in DefaultExecutor.buildHeaders"
```

---

### Task 3: Server-side validation/normalization util

**Files:**
- Create: `src/lib/customHeaders.js`
- Test: `tests/unit/custom-headers-normalize.test.js`

**Interfaces:**
- Produces: `normalizeCustomHeaders(input)` — accepts anything; returns `{ headers: Array<{name,value}>, error: string|null }`. Valid header-name regex `^[!#$%&'*+\-.^_\`|~0-9A-Za-z]+$`. Trims names; drops rows with empty name; keeps value as string (default `""`); dedupes by case-insensitive name (last wins). If any non-empty row has an invalid name → `error` set, `headers: []`. Non-array input → `{ headers: [], error: null }` (treated as "none").

- [ ] **Step 1: Write the failing test**

Create `tests/unit/custom-headers-normalize.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { normalizeCustomHeaders } from "@/lib/customHeaders.js";

describe("normalizeCustomHeaders", () => {
  it("passes valid headers through, trimming names", () => {
    const { headers, error } = normalizeCustomHeaders([{ name: " X-A ", value: "v" }]);
    expect(error).toBeNull();
    expect(headers).toEqual([{ name: "X-A", value: "v" }]);
  });
  it("drops empty-name rows", () => {
    const { headers } = normalizeCustomHeaders([{ name: "  ", value: "x" }, { name: "Keep", value: "y" }]);
    expect(headers).toEqual([{ name: "Keep", value: "y" }]);
  });
  it("defaults missing value to empty string", () => {
    const { headers } = normalizeCustomHeaders([{ name: "X" }]);
    expect(headers).toEqual([{ name: "X", value: "" }]);
  });
  it("dedupes case-insensitively, last wins", () => {
    const { headers } = normalizeCustomHeaders([{ name: "User-Agent", value: "a" }, { name: "user-agent", value: "b" }]);
    expect(headers).toEqual([{ name: "user-agent", value: "b" }]);
  });
  it("rejects invalid header name", () => {
    const { headers, error } = normalizeCustomHeaders([{ name: "Bad Header", value: "v" }]);
    expect(error).toBeTruthy();
    expect(headers).toEqual([]);
  });
  it("non-array input → none, no error", () => {
    expect(normalizeCustomHeaders(undefined)).toEqual({ headers: [], error: null });
    expect(normalizeCustomHeaders(null)).toEqual({ headers: [], error: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `tests/`): `npx vitest run unit/custom-headers-normalize.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the util**

Create `src/lib/customHeaders.js`:

```javascript
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function normalizeCustomHeaders(input) {
  if (!Array.isArray(input)) return { headers: [], error: null };

  const byLower = new Map();
  for (const row of input) {
    if (!row || typeof row.name !== "string") continue;
    const name = row.name.trim();
    if (!name) continue;
    if (!HEADER_NAME_RE.test(name)) {
      return { headers: [], error: `Invalid header name: "${name}"` };
    }
    const value = typeof row.value === "string" ? row.value : "";
    byLower.set(name.toLowerCase(), { name, value });
  }
  return { headers: [...byLower.values()], error: null };
}
```

- [ ] **Step 4: Run to verify it passes**

Run (from `tests/`): `npx vitest run unit/custom-headers-normalize.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/customHeaders.js tests/unit/custom-headers-normalize.test.js
git commit -m "feat: server-side custom header validation/normalization util"
```

---

### Task 4: Persist + propagate customHeaders through the node/connection API

**Files:**
- Modify: `src/lib/db/repos/nodesRepo.js` (`createProviderNode` whitelists fields — add `customHeaders`)
- Modify: `src/app/api/provider-nodes/route.js` (POST: accept + normalize `customHeaders`, pass to `createProviderNode`)
- Modify: `src/app/api/provider-nodes/[id]/route.js` (PUT: accept + normalize; store on node; include in the connection `providerSpecificData` fan-out)
- Modify: `src/app/api/providers/route.js` (POST connection: copy `node.customHeaders` into the built `providerSpecificData` for all three compatible branches)
- Test: `tests/unit/custom-headers-api.test.js`

**Interfaces:**
- Consumes: `normalizeCustomHeaders` from Task 3; `createProviderNode`/`updateProviderNode`/`getProviderConnections`/`updateProviderConnection` from `@/models`.
- Produces: node persists `customHeaders`; every connection of a compatible node carries `providerSpecificData.customHeaders`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/custom-headers-api.test.js` (mirrors `compatible-provider-connections.test.js` temp-DB pattern):

```javascript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setup() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-custom-headers-api-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
  const { POST: POST_CONN } = await import("@/app/api/providers/route.js");
  const { PUT } = await import("@/app/api/provider-nodes/[id]/route.js");
  const { createProviderNode, getProviderConnections, getProviderNodeById } =
    await import("@/models/index.js");
  return {
    POST_CONN, PUT, createProviderNode, getProviderConnections, getProviderNodeById,
    cleanup() { fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

let cleanup = () => {};
afterEach(() => {
  vi.doUnmock("next/server");
  vi.resetModules();
  vi.clearAllMocks();
  cleanup(); cleanup = () => {};
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function connReq(provider) {
  return new Request("https://9router.local/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey: "k", name: "C1" }),
  });
}
function putReq(body) {
  return new Request("https://9router.local/api/provider-nodes/x", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("customHeaders propagation", () => {
  it("new connection inherits node.customHeaders", async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    const node = await ctx.createProviderNode({
      id: "openai-compatible-chat-t1", type: "openai-compatible",
      name: "N", prefix: "n1", apiType: "chat", baseUrl: "https://x/v1",
      customHeaders: [{ name: "X-A", value: "v" }],
    });
    const res = await ctx.POST_CONN(connReq(node.id));
    expect(res.status).toBe(201);
    const conns = await ctx.getProviderConnections({ provider: node.id });
    expect(conns[0].providerSpecificData.customHeaders).toEqual([{ name: "X-A", value: "v" }]);
  });

  it("PUT stores customHeaders on node and fans out to existing connections", async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    const node = await ctx.createProviderNode({
      id: "openai-compatible-chat-t2", type: "openai-compatible",
      name: "N", prefix: "n2", apiType: "chat", baseUrl: "https://x/v1",
    });
    await ctx.POST_CONN(connReq(node.id)); // create a connection first (no headers yet)

    const res = await ctx.PUT(putReq({
      name: "N", prefix: "n2", apiType: "chat", baseUrl: "https://x/v1",
      customHeaders: [{ name: "User-Agent", value: "chrome" }],
    }), { params: Promise.resolve({ id: node.id }) });
    expect(res.status).toBe(200);

    const stored = await ctx.getProviderNodeById(node.id);
    expect(stored.customHeaders).toEqual([{ name: "User-Agent", value: "chrome" }]);

    const conns = await ctx.getProviderConnections({ provider: node.id });
    expect(conns[0].providerSpecificData.customHeaders).toEqual([{ name: "User-Agent", value: "chrome" }]);
  });

  it("PUT with invalid header name → 400", async () => {
    const ctx = await setup(); cleanup = ctx.cleanup;
    const node = await ctx.createProviderNode({
      id: "openai-compatible-chat-t3", type: "openai-compatible",
      name: "N", prefix: "n3", apiType: "chat", baseUrl: "https://x/v1",
    });
    const res = await ctx.PUT(putReq({
      name: "N", prefix: "n3", apiType: "chat", baseUrl: "https://x/v1",
      customHeaders: [{ name: "Bad Header", value: "v" }],
    }), { params: Promise.resolve({ id: node.id }) });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `tests/`): `npx vitest run unit/custom-headers-api.test.js`
Expected: FAIL — customHeaders not persisted/propagated (undefined).

- [ ] **Step 3: Persist customHeaders in the repo**

In `src/lib/db/repos/nodesRepo.js`, `createProviderNode` currently builds `node` from a whitelist (id/type/name/prefix/apiType/baseUrl). Add `customHeaders`:

```javascript
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    ...(data.customHeaders !== undefined ? { customHeaders: data.customHeaders } : {}),
    createdAt: now,
    updatedAt: now,
  };
```

(`updateProviderNode` already merges arbitrary `data` keys — no change needed there.)

- [ ] **Step 4: Accept customHeaders in POST /api/provider-nodes**

In `src/app/api/provider-nodes/route.js`, add the import at top:

```javascript
import { normalizeCustomHeaders } from "@/lib/customHeaders.js";
```

In `POST`, after destructuring `body`, normalize once:

```javascript
    const { headers: customHeaders, error: headerError } = normalizeCustomHeaders(body.customHeaders);
    if (headerError) {
      return NextResponse.json({ error: headerError }, { status: 400 });
    }
```

Then add `customHeaders` to each `createProviderNode({...})` call (all three branches):

```javascript
        customHeaders,
```

- [ ] **Step 5: Accept + fan out customHeaders in PUT /api/provider-nodes/[id]**

In `src/app/api/provider-nodes/[id]/route.js`, add the import at top:

```javascript
import { normalizeCustomHeaders } from "@/lib/customHeaders.js";
```

After destructuring `{ name, prefix, apiType, baseUrl }` from body, add:

```javascript
    const { headers: customHeaders, error: headerError } = normalizeCustomHeaders(body.customHeaders);
    if (headerError) {
      return NextResponse.json({ error: headerError }, { status: 400 });
    }
```

Add `customHeaders` to the `updates` object:

```javascript
    const updates = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
      customHeaders,
    };
```

And in the existing connection fan-out `Promise.all`, add `customHeaders` to the copied `providerSpecificData`:

```javascript
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          prefix: prefix.trim(),
          apiType: node.type === "openai-compatible" ? apiType : undefined,
          baseUrl: sanitizedBaseUrl,
          nodeName: updated.name,
          customHeaders,
        }
```

- [ ] **Step 6: Copy node.customHeaders into new connections (POST /api/providers)**

In `src/app/api/providers/route.js`, in each of the three compatible branches
(`isOpenAICompatibleProvider`, `isAnthropicCompatibleProvider`,
`isCustomEmbeddingProvider`), add `customHeaders` to the built
`providerSpecificData`. Example for the OpenAI branch:

```javascript
      providerSpecificData = {
        prefix: node.prefix,
        apiType: node.apiType,
        baseUrl: node.baseUrl,
        nodeName: node.name,
        ...(node.customHeaders !== undefined ? { customHeaders: node.customHeaders } : {}),
      };
```

Apply the same `...(node.customHeaders !== undefined ? { customHeaders: node.customHeaders } : {})` spread to the anthropic-compatible and custom-embedding branches.

- [ ] **Step 7: Run to verify it passes**

Run (from `tests/`): `npx vitest run unit/custom-headers-api.test.js`
Expected: PASS.

- [ ] **Step 8: Regression — existing compatible-connections test still green**

Run (from `tests/`): `npx vitest run unit/compatible-provider-connections.test.js`
Expected: PASS (customHeaders is additive; absent → not present).

- [ ] **Step 9: Commit**

```bash
git add src/lib/db/repos/nodesRepo.js src/app/api/provider-nodes/route.js src/app/api/provider-nodes/[id]/route.js src/app/api/providers/route.js tests/unit/custom-headers-api.test.js
git commit -m "feat: persist and propagate customHeaders across node/connection API"
```

---

### Task 5: Edit-modal UI for custom headers

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js` (`handleUpdateNode` already forwards the whole `formData` object as the PUT body — confirm `customHeaders` rides along; no change needed if modal includes it in payload)

**Interfaces:**
- Consumes: `node.customHeaders` (array) when hydrating; validation regex from Task 3 (duplicated client-side).
- Produces: `onSave` payload now includes `customHeaders: Array<{name,value}>`.

> Note: `handleUpdateNode(formData)` in `page.js` (line 347) does
> `body: JSON.stringify(formData)` — it forwards whatever the modal passes.
> `EditCompatibleNodeModal.handleSubmit` builds an explicit `payload` object, so
> the ONLY change needed is adding `customHeaders` to that `payload`. No `page.js`
> edit required. Verify this during implementation.

- [ ] **Step 1: Add customHeaders state + hydration**

In `EditCompatibleNodeModal.js`, add a separate state array (kept out of `formData` so header rows can hold transient empty rows):

```javascript
  const [customHeaders, setCustomHeaders] = useState([]);
```

In the `useEffect` that hydrates from `node`, seed it:

```javascript
      setCustomHeaders(Array.isArray(node.customHeaders) ? node.customHeaders.map((h) => ({ ...h })) : []);
```

- [ ] **Step 2: Add row handlers + client validation helper**

Add above `handleSubmit`:

```javascript
  const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const isInvalidHeaderName = (name) => name.trim() !== "" && !HEADER_NAME_RE.test(name.trim());
  const hasInvalidHeader = customHeaders.some((h) => isInvalidHeaderName(h.name));

  const updateHeader = (index, field, value) => {
    setCustomHeaders((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };
  const addHeader = () => setCustomHeaders((rows) => [...rows, { name: "", value: "" }]);
  const removeHeader = (index) => setCustomHeaders((rows) => rows.filter((_, i) => i !== index));
```

- [ ] **Step 3: Include customHeaders in the save payload**

In `handleSubmit`, before `await onSave(payload)`, add (drop empty-name rows, trim names):

```javascript
      payload.customHeaders = customHeaders
        .filter((h) => h.name.trim() !== "")
        .map((h) => ({ name: h.name.trim(), value: h.value }));
```

And extend the early-return guard / Save disabled condition to also block on `hasInvalidHeader`:

```javascript
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || hasInvalidHeader) return;
```

- [ ] **Step 4: Render the Request Headers section**

In the JSX, after the Base URL `<Input>` (and before the API Key Check block), add:

```javascript
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Request Headers</label>
            <Button type="button" variant="secondary" onClick={addHeader}>
              + Add Header
            </Button>
          </div>
          {customHeaders.map((h, i) => (
            <div key={i} className="flex gap-2 items-start">
              <Input
                placeholder="Header-Name"
                value={h.name}
                onChange={(e) => updateHeader(i, "name", e.target.value)}
                className="flex-1"
                error={isInvalidHeaderName(h.name) ? "Invalid header name" : undefined}
              />
              <Input
                placeholder="value or sess_{ralpha_num:26}"
                value={h.value}
                onChange={(e) => updateHeader(i, "value", e.target.value)}
                className="flex-1"
              />
              <div className="pt-1">
                <Button type="button" variant="ghost" onClick={() => removeHeader(i)}>
                  ×
                </Button>
              </div>
            </div>
          ))}
          <p className="text-xs text-neutral-500">
            Overrides preset headers of the same name. Dynamic tags:
            {" "}<code>{"{ralpha|lalpha|ualpha|num|symbol[_...][:length]}"}</code> generate random values per request
            (e.g. <code>{"sess_{ralpha_num:26}"}</code>). Copy another header:
            {" "}<code>{"{header:Other-Header}"}</code>.
          </p>
        </div>
```

> If `Input` does not accept an `error` prop, drop the `error={...}` line and
> instead conditionally add a red-border className. Verify the `Input` component's
> props (`src/shared/components`) during implementation.

- [ ] **Step 5: Update the Save button disabled condition**

The final Save `<Button>` `disabled` prop already checks name/prefix/baseUrl/saving. Add `|| hasInvalidHeader`:

```javascript
          <Button onClick={handleSubmit} fullWidth disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || saving || hasInvalidHeader}>
```

- [ ] **Step 6: Extend PropTypes**

In `EditCompatibleNodeModal.propTypes`, add to the `node` shape:

```javascript
    customHeaders: PropTypes.arrayOf(
      PropTypes.shape({ name: PropTypes.string, value: PropTypes.string })
    ),
```

- [ ] **Step 7: Manual verification (no automated UI test in this repo)**

Run the dashboard (`PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev`),
open a compatible provider detail page → Edit Node → add a header
`User-Agent: chrome` and `X-Session: sess_{ralpha_num:26}` and
`X-Copy: {header:X-Session}`, Save. Reopen the modal → headers persist.
Verify Save is blocked when a header name contains a space.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js"
git commit -m "feat(ui): custom request headers editor in compatible node modal"
```

---

### Task 6: Full suite regression check

- [ ] **Step 1: Run the new tests together**

Run (from `tests/`):
```bash
npx vitest run unit/header-template.test.js unit/custom-headers-executor.test.js unit/custom-headers-normalize.test.js unit/custom-headers-api.test.js unit/compatible-provider-connections.test.js unit/openai-compatible-apitype-resolution.test.js
```
Expected: all PASS.

- [ ] **Step 2: Baseline regression gate**

Run (from `tests/`): `node __baseline__/verify-no-regression.mjs`
Expected: no NEW failures vs. the committed baseline (per CLAUDE.md, the suite is
not all-green; only new regressions matter).

- [ ] **Step 3: Lint**

Run (from repo root): `npx eslint open-sse/utils/headerTemplate.js src/lib/customHeaders.js "src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js" src/app/api/provider-nodes/route.js "src/app/api/provider-nodes/[id]/route.js" src/app/api/providers/route.js`
Expected: no errors.
