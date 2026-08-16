# Custom Request Header Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a custom request header's resolved value be persisted (cached) per connection — permanently (process lifetime) or for N minutes — instead of regenerating every request, with a table UI + nested add/edit popup.

**Architecture:** Header rows gain `ttlMinutes` (null=off, 0=permanent, N=minutes). An in-memory per-connection cache (`open-sse/utils/headerCache.js`) memoizes resolved values. `resolveCustomHeaders` gains an optional per-header `resolveValue` hook; `DefaultExecutor.buildHeaders` supplies a hook routing persistent headers through the cache. The modal editor becomes a table + a nested `HeaderFormModal` popup; the shared `Modal` gains a `disableEscape` prop for clean nesting.

**Tech Stack:** Next.js (JS/ESM, React), `open-sse` engine, vitest, Tailwind.

## Global Constraints

- Plain JavaScript ESM. No TypeScript. `@/*` alias → `src/*`; `open-sse/*` alias → engine root (both resolved by vitest config at repo root).
- Config-driven, DRY, camelCase (per `open-sse/AGENTS.md`).
- `ttlMinutes` semantics: `null`/absent = not persistent (regenerate every request); `0` = permanent (process lifetime); `N > 0` = N minutes. Backward compatible — absent field behaves exactly as today.
- Cache is IN-MEMORY, per connection. "Permanent" survives only until server restart. No DB/schema change.
- Cache key = `connectionId + "\0" + lowerHeaderName + "\0" + rawValue`. Including rawValue auto-busts on template edit.
- `{remove}` directive is detected on raw value BEFORE any caching and is NEVER cached.
- `resolveCustomHeaders` core stays pure; caching/time is injected via the `resolveValue` hook. Executor `buildHeaders` remains fail-open (existing try/catch).
- Invalid `ttlMinutes` (negative / NaN / non-integer): client blocks Save; server (`normalizeCustomHeaders`) coerces to `null` — never a 400.
- connectionId in executor: `credentials?.connectionId || credentials?.email || credentials?.id || "default"`.
- Tests: run with `npx vitest run <path>` from the `tests/` dir. There is no automated UI test harness — UI tasks verify via eslint + manual reasoning.
- Do NOT stage unrelated pre-existing dirty files: `.env.example`, `open-sse/utils/proxyFetch.js`. Use `--no-verify` on commits.

---

### Task 1: In-memory header cache module

**Files:**
- Create: `open-sse/utils/headerCache.js`
- Test: `tests/unit/header-cache.test.js`

**Interfaces:**
- Produces:
  - `getOrResolvePersistent(cacheKey, ttlMinutes, resolveFn, now = Date.now())` → string. On fresh hit returns cached value; on miss/expiry calls `resolveFn()`, stores `{ value, expiresAt: ttlMinutes > 0 ? now + ttlMinutes*60000 : null }`, returns fresh value. `now` injectable.
  - `__clearHeaderCache()` — test helper, empties the map.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/header-cache.test.js`:

```javascript
import { describe, it, expect, beforeEach } from "vitest";
import { getOrResolvePersistent, __clearHeaderCache } from "open-sse/utils/headerCache.js";

beforeEach(() => __clearHeaderCache());

describe("getOrResolvePersistent", () => {
  it("miss → calls resolveFn, stores, returns fresh value", () => {
    let n = 0;
    const v = getOrResolvePersistent("k1", 5, () => `v${++n}`, 1000);
    expect(v).toBe("v1");
    expect(n).toBe(1);
  });

  it("fresh hit → returns cached value, resolveFn NOT called again", () => {
    let n = 0;
    getOrResolvePersistent("k1", 5, () => `v${++n}`, 1000);
    const v2 = getOrResolvePersistent("k1", 5, () => `v${++n}`, 1000 + 4 * 60000);
    expect(v2).toBe("v1");
    expect(n).toBe(1);
  });

  it("timed expiry → regenerates after ttl passes", () => {
    let n = 0;
    getOrResolvePersistent("k1", 5, () => `v${++n}`, 1000);
    // 5 min = 300000ms; now well past expiry
    const v2 = getOrResolvePersistent("k1", 5, () => `v${++n}`, 1000 + 6 * 60000);
    expect(v2).toBe("v2");
    expect(n).toBe(2);
  });

  it("permanent (ttlMinutes 0) never expires", () => {
    let n = 0;
    getOrResolvePersistent("k1", 0, () => `v${++n}`, 1000);
    const v2 = getOrResolvePersistent("k1", 0, () => `v${++n}`, 1000 + 10 * 365 * 24 * 60 * 60000);
    expect(v2).toBe("v1");
    expect(n).toBe(1);
  });

  it("different key → independent entry", () => {
    getOrResolvePersistent("a", 0, () => "A", 1000);
    const b = getOrResolvePersistent("b", 0, () => "B", 1000);
    expect(b).toBe("B");
  });

  it("__clearHeaderCache resets", () => {
    let n = 0;
    getOrResolvePersistent("k1", 0, () => `v${++n}`, 1000);
    __clearHeaderCache();
    const v2 = getOrResolvePersistent("k1", 0, () => `v${++n}`, 1000);
    expect(v2).toBe("v2");
  });

  it("size cap evicts oldest beyond limit (no unbounded growth)", () => {
    // Insert cap+10 distinct permanent keys; map must not exceed the cap.
    for (let i = 0; i < 5010; i++) {
      getOrResolvePersistent(`key${i}`, 0, () => `v${i}`, 1000);
    }
    // The earliest keys should have been evicted; a fresh resolve for key0
    // therefore calls resolveFn again (returns the NEW value).
    const again = getOrResolvePersistent("key0", 0, () => "NEW", 1000);
    expect(again).toBe("NEW");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `tests/`): `npx vitest run unit/header-cache.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cache**

Create `open-sse/utils/headerCache.js`:

```javascript
// In-memory, per-connection cache for persistent custom header values.
// Values live for the process lifetime (permanent) or a TTL in minutes.
// Not durable — everything is lost on restart (by design).

const MAX_ENTRIES = 5000;
const store = new Map(); // cacheKey → { value, expiresAt }  (insertion-ordered)

export function getOrResolvePersistent(cacheKey, ttlMinutes, resolveFn, now = Date.now()) {
  const hit = store.get(cacheKey);
  if (hit && (hit.expiresAt === null || now < hit.expiresAt)) {
    return hit.value;
  }
  const value = resolveFn();
  const expiresAt = ttlMinutes > 0 ? now + ttlMinutes * 60000 : null;
  // Refresh insertion order: delete before set so re-inserts move to the end.
  store.delete(cacheKey);
  store.set(cacheKey, { value, expiresAt });
  // Bound growth: evict oldest (first inserted) entries beyond the cap.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  return value;
}

export function __clearHeaderCache() {
  store.clear();
}
```

- [ ] **Step 4: Run to verify it passes**

Run (from `tests/`): `npx vitest run unit/header-cache.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add open-sse/utils/headerCache.js tests/unit/header-cache.test.js
git commit --no-verify -m "feat(open-sse): in-memory per-connection header value cache"
```

---

### Task 2: Add per-header resolveValue hook to resolveCustomHeaders

**Files:**
- Modify: `open-sse/utils/headerTemplate.js` (`resolveCustomHeaders` gains an optional 2nd arg)
- Test: `tests/unit/header-template.test.js` (append a describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveCustomHeaders(customHeaders, { resolveValue } = {})`. `resolveValue(name, rawValue, defaultResolve)` is called once per header during pass 1 (except `{remove}`, which short-circuits before the hook). No hook → behaves exactly as today. Pass 2 (`{header:X}` refs) resolves against pass-1 values unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/header-template.test.js` (end of file):

```javascript
describe("resolveCustomHeaders — resolveValue hook", () => {
  it("no hook → behaves like default", () => {
    const out = resolveCustomHeaders([{ name: "X", value: "abc" }]);
    expect(out).toEqual({ X: "abc" });
  });

  it("hook is called once per header with (name, rawValue, defaultResolve)", () => {
    const calls = [];
    const out = resolveCustomHeaders(
      [{ name: "X-A", value: "raw-a" }, { name: "X-B", value: "raw-b" }],
      {
        resolveValue: (name, rawValue, defaultResolve) => {
          calls.push([name, rawValue]);
          return `wrapped(${defaultResolve()})`;
        },
      }
    );
    expect(calls).toEqual([["X-A", "raw-a"], ["X-B", "raw-b"]]);
    expect(out).toEqual({ "X-A": "wrapped(raw-a)", "X-B": "wrapped(raw-b)" });
  });

  it("hook can memoize (same value across two resolves)", () => {
    let n = 0;
    const memo = {};
    const hook = (name, rawValue, defaultResolve) => {
      const key = name + rawValue;
      if (!(key in memo)) memo[key] = defaultResolve() + ++n;
      return memo[key];
    };
    const a = resolveCustomHeaders([{ name: "S", value: "x" }], { resolveValue: hook });
    const b = resolveCustomHeaders([{ name: "S", value: "x" }], { resolveValue: hook });
    expect(a["S"]).toBe(b["S"]);
  });

  it("{remove} short-circuits BEFORE the hook (never wrapped, never cached)", () => {
    let called = false;
    const out = resolveCustomHeaders(
      [{ name: "User-Agent", value: "{remove}" }],
      { resolveValue: () => { called = true; return "SHOULD_NOT"; } }
    );
    expect(called).toBe(false);
    expect(out["User-Agent"]).toBe(REMOVE_HEADER);
  });

  it("{header:X} ref copies the hook-resolved (e.g. memoized) value of its source", () => {
    const hook = (name, rawValue, defaultResolve) =>
      name === "X-Session" ? "STABLE" : defaultResolve();
    const out = resolveCustomHeaders(
      [{ name: "X-Session", value: "{ralpha_num:26}" }, { name: "X-Copy", value: "{header:X-Session}" }],
      { resolveValue: hook }
    );
    expect(out["X-Session"]).toBe("STABLE");
    expect(out["X-Copy"]).toBe("STABLE");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `tests/`): `npx vitest run unit/header-template.test.js`
Expected: FAIL — the new hook tests fail (hook ignored), existing tests still pass.

- [ ] **Step 3: Wire the hook into pass 1**

In `open-sse/utils/headerTemplate.js`, change the signature and the pass-1 loop. Current:

```javascript
export function resolveCustomHeaders(customHeaders) {
  if (!Array.isArray(customHeaders)) return {};
```

becomes:

```javascript
export function resolveCustomHeaders(customHeaders, { resolveValue } = {}) {
  if (!Array.isArray(customHeaders)) return {};
```

Current pass-1 loop:

```javascript
  for (const { name, value } of byLower.values()) {
    if (value.trim() === "{remove}") {
      pass1.push({ name, value: REMOVE_HEADER });
      lowerMap[name.toLowerCase()] = ""; // a {header:...} ref to a removed header → ""
      continue;
    }
    const resolved = resolveTemplateValue(value);
    pass1.push({ name, value: resolved });
    lowerMap[name.toLowerCase()] = resolved;
  }
```

becomes (hook wraps the default per-header resolution; `{remove}` still first):

```javascript
  for (const { name, value } of byLower.values()) {
    if (value.trim() === "{remove}") {
      pass1.push({ name, value: REMOVE_HEADER });
      lowerMap[name.toLowerCase()] = ""; // a {header:...} ref to a removed header → ""
      continue;
    }
    const defaultResolve = () => resolveTemplateValue(value);
    const resolved = resolveValue ? resolveValue(name, value, defaultResolve) : defaultResolve();
    pass1.push({ name, value: resolved });
    lowerMap[name.toLowerCase()] = resolved;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run (from `tests/`): `npx vitest run unit/header-template.test.js`
Expected: PASS (all existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add open-sse/utils/headerTemplate.js tests/unit/header-template.test.js
git commit --no-verify -m "feat(open-sse): resolveCustomHeaders per-header resolveValue hook"
```

---

### Task 3: Route persistent headers through the cache in buildHeaders

**Files:**
- Modify: `open-sse/executors/default.js` (import cache; build the hook; pass to resolveCustomHeaders)
- Test: `tests/unit/custom-headers-executor.test.js` (append)

**Interfaces:**
- Consumes: `getOrResolvePersistent` (Task 1); `resolveCustomHeaders(customHeaders, { resolveValue })` (Task 2); per-header `ttlMinutes`.
- Produces: persistent headers reuse cached values per connection.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/custom-headers-executor.test.js`. First ensure the cache is cleared between tests — add at the top of the file (after imports):

```javascript
import { __clearHeaderCache } from "open-sse/utils/headerCache.js";
import { beforeEach } from "vitest";
beforeEach(() => __clearHeaderCache());
```

Then append:

```javascript
describe("DefaultExecutor buildHeaders — persistence", () => {
  it("persistent header (ttlMinutes 0) is identical across two calls, same connection", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const c = creds([{ name: "X-Session", value: "{ralpha_num:26}", ttlMinutes: 0 }], { connectionId: "conn-1" });
    const h1 = ex.buildHeaders(c, true);
    const h2 = ex.buildHeaders(c, true);
    expect(h1["X-Session"]).toMatch(/^[a-zA-Z0-9]{26}$/);
    expect(h2["X-Session"]).toBe(h1["X-Session"]);
  });

  it("non-persistent header (no ttlMinutes) varies across calls", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const c = creds([{ name: "X-Session", value: "{ralpha_num:26}" }], { connectionId: "conn-1" });
    const a = ex.buildHeaders(c, true)["X-Session"];
    const b = ex.buildHeaders(c, true)["X-Session"];
    expect(a).not.toBe(b); // 26 random chars colliding is effectively impossible
  });

  it("different connectionId → different persistent value", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h1 = ex.buildHeaders(creds([{ name: "X-Session", value: "{ralpha_num:26}", ttlMinutes: 0 }], { connectionId: "conn-1" }), true);
    const h2 = ex.buildHeaders(creds([{ name: "X-Session", value: "{ralpha_num:26}", ttlMinutes: 0 }], { connectionId: "conn-2" }), true);
    expect(h2["X-Session"]).not.toBe(h1["X-Session"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `tests/`): `npx vitest run unit/custom-headers-executor.test.js`
Expected: FAIL — persistence tests fail (values vary / not cached); existing tests still pass.

- [ ] **Step 3: Add the import**

In `open-sse/executors/default.js`, after the existing `resolveCustomHeaders` import (currently `import { resolveCustomHeaders, REMOVE_HEADER } from "../utils/headerTemplate.js";`), add:

```javascript
import { getOrResolvePersistent } from "../utils/headerCache.js";
```

- [ ] **Step 4: Build the hook and pass it to resolveCustomHeaders**

In `buildHeaders`, the current block is:

```javascript
    const customHeaders = credentials?.providerSpecificData?.customHeaders;
    if (customHeaders) {
      try {
        const resolved = resolveCustomHeaders(customHeaders);
        for (const [name, value] of Object.entries(resolved)) {
```

Replace the `const resolved = resolveCustomHeaders(customHeaders);` line with a hook-aware call:

```javascript
        const connId = credentials?.connectionId || credentials?.email || credentials?.id || "default";
        // Map lower header name → ttlMinutes for O(1) lookup in the hook.
        const ttlByName = new Map();
        for (const h of customHeaders) {
          if (h && typeof h.name === "string") ttlByName.set(h.name.trim().toLowerCase(), h.ttlMinutes);
        }
        const resolveValue = (name, rawValue, defaultResolve) => {
          const ttl = ttlByName.get(name.toLowerCase());
          if (ttl == null) return defaultResolve(); // not persistent
          const key = connId + "\0" + name.toLowerCase() + "\0" + rawValue;
          return getOrResolvePersistent(key, ttl, defaultResolve);
        };
        const resolved = resolveCustomHeaders(customHeaders, { resolveValue });
```

(The `for...of Object.entries(resolved)` loop, `REMOVE_HEADER` handling, case-insensitive override, and the `catch { /* fail-open */ }` all stay unchanged.)

- [ ] **Step 5: Run to verify it passes**

Run (from `tests/`): `npx vitest run unit/custom-headers-executor.test.js`
Expected: PASS (all existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add open-sse/executors/default.js tests/unit/custom-headers-executor.test.js
git commit --no-verify -m "feat(open-sse): cache persistent custom headers per connection in buildHeaders"
```

---

### Task 4: Normalize ttlMinutes server-side

**Files:**
- Modify: `src/lib/customHeaders.js`
- Test: `tests/unit/custom-headers-normalize.test.js` (append)

**Interfaces:**
- Produces: `normalizeCustomHeaders` output rows include `ttlMinutes` (a non-negative integer or `null`). Invalid ttl (negative / NaN / non-integer / other type) → `null`. Never returns an error for ttl.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/custom-headers-normalize.test.js`:

```javascript
describe("normalizeCustomHeaders — ttlMinutes", () => {
  it("preserves null (absent) as null", () => {
    const { headers } = normalizeCustomHeaders([{ name: "X", value: "v" }]);
    expect(headers[0].ttlMinutes).toBeNull();
  });
  it("preserves 0 (permanent)", () => {
    const { headers } = normalizeCustomHeaders([{ name: "X", value: "v", ttlMinutes: 0 }]);
    expect(headers[0].ttlMinutes).toBe(0);
  });
  it("preserves a positive integer", () => {
    const { headers } = normalizeCustomHeaders([{ name: "X", value: "v", ttlMinutes: 30 }]);
    expect(headers[0].ttlMinutes).toBe(30);
  });
  it("coerces negative / NaN / non-integer / wrong-type to null (no error)", () => {
    for (const bad of [-5, 1.5, NaN, "abc", "10", {}]) {
      const { headers, error } = normalizeCustomHeaders([{ name: "X", value: "v", ttlMinutes: bad }]);
      expect(error).toBeNull();
      expect(headers[0].ttlMinutes).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `tests/`): `npx vitest run unit/custom-headers-normalize.test.js`
Expected: FAIL — `ttlMinutes` not present on output rows.

- [ ] **Step 3: Add ttl normalization**

In `src/lib/customHeaders.js`, add a helper and include `ttlMinutes` in each stored row. Above `normalizeCustomHeaders`:

```javascript
function normalizeTtl(ttl) {
  if (ttl === null || ttl === undefined) return null;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0) return null;
  return ttl;
}
```

Then in the loop, where the row is stored:

```javascript
    byLower.set(name.toLowerCase(), { name, value });
```

becomes:

```javascript
    byLower.set(name.toLowerCase(), { name, value, ttlMinutes: normalizeTtl(row.ttlMinutes) });
```

- [ ] **Step 4: Run to verify it passes**

Run (from `tests/`): `npx vitest run unit/custom-headers-normalize.test.js`
Expected: PASS (existing + 4 new).


- [ ] **Step 5: Regression — API propagation still green**

Run (from `tests/`): `npx vitest run unit/custom-headers-api.test.js`
Expected: assertions pass (a Windows `EPERM` in `afterEach` temp-dir teardown may appear — pre-existing env artifact, NOT a regression; the untouched baseline `compatible-provider-connections.test.js` fails identically).


- [ ] **Step 6: Commit** (Task 4)

```bash
git add src/lib/customHeaders.js tests/unit/custom-headers-normalize.test.js
git commit --no-verify -m "feat: normalize ttlMinutes on custom headers (invalid ttl → null)"
```

---

### Task 5: Modal disableEscape prop + HeaderFormModal popup

**Files:**
- Modify: `src/shared/components/Modal.js` (add optional `disableEscape` prop)
- Create: `src/app/(dashboard)/dashboard/providers/[id]/HeaderFormModal.js`

**Interfaces:**
- Modal: `disableEscape` (bool, default false). When true, the component does NOT register its document-level Escape listener. All existing usages (no prop) keep current behavior.
- HeaderFormModal: props `isOpen`, `mode` ("add"|"edit"), `initial` ({name,value,ttlMinutes} or defaults), `existingNames` (array of lowercased names excluding the row being edited), `onSubmit(row)`, `onClose`. Emits a normalized row `{ name: name.trim(), value, ttlMinutes }`.

- [ ] **Step 1: Add `disableEscape` to Modal**

In `src/shared/components/Modal.js`, add `disableEscape = false` to the destructured props (alongside `closeOnOverlay`). The Escape effect currently is:

```javascript
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);
```

Change it to early-return when disabled:

```javascript
  useEffect(() => {
    if (disableEscape) return;
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, disableEscape]);
```

- [ ] **Step 2: Create HeaderFormModal**

Create `src/app/(dashboard)/dashboard/providers/[id]/HeaderFormModal.js`:

```javascript
"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal, Toggle } from "@/shared/components";

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const DEFAULTS = { name: "", value: "", ttlMinutes: null };

export default function HeaderFormModal({ isOpen, mode, initial, existingNames = [], onSubmit, onClose }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [persist, setPersist] = useState(false);
  const [minutes, setMinutes] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const src = initial || DEFAULTS;
    setName(src.name || "");
    setValue(src.value || "");
    const ttl = src.ttlMinutes;
    setPersist(ttl !== null && ttl !== undefined);
    setMinutes(ttl === null || ttl === undefined ? "" : String(ttl));
  }, [isOpen, initial]);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName !== "" && !HEADER_NAME_RE.test(trimmedName);
  const duplicate = trimmedName !== "" && existingNames.includes(trimmedName.toLowerCase());
  const minutesInvalid = persist && minutes !== "" && (!/^\d+$/.test(minutes) || Number(minutes) < 0);
  const canSave = trimmedName !== "" && !nameInvalid && !minutesInvalid;

  const handleSubmit = () => {
    if (!canSave) return;
    let ttlMinutes = null;
    if (persist) ttlMinutes = minutes === "" ? 0 : Number(minutes);
    onSubmit({ name: trimmedName, value, ttlMinutes });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === "edit" ? "Edit Header" : "Add Header"}
      size="sm"
      closeOnOverlay={false}
      className="z-[60]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSave}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Header-Name"
          error={nameInvalid ? "Invalid header name" : (duplicate ? "A header with this name already exists (will replace it)" : undefined)}
        />
        <Input
          label="Value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value or sess_{ralpha_num:26}"
          hint="Dynamic tags {ralpha|lalpha|ualpha|num|symbol[_...][:length]}, {opencode_session}, copy via {header:Other}, or {remove} to delete a preset."
        />
        <Toggle checked={persist} onChange={setPersist} label="Persist (reuse value per connection)" />
        {persist && (
          <Input
            label="Minutes (0 = permanent until restart)"
            type="number"
            min="0"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="0"
            error={minutesInvalid ? "Enter a non-negative whole number" : undefined}
          />
        )}
      </div>
    </Modal>
  );
}

HeaderFormModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  mode: PropTypes.oneOf(["add", "edit"]).isRequired,
  initial: PropTypes.shape({ name: PropTypes.string, value: PropTypes.string, ttlMinutes: PropTypes.number }),
  existingNames: PropTypes.arrayOf(PropTypes.string),
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
```

- [ ] **Step 3: Lint**

Run (from repo root): `npx eslint src/shared/components/Modal.js "src/app/(dashboard)/dashboard/providers/[id]/HeaderFormModal.js"`
Expected: no NEW errors. (The `Input` `error` prop and `Toggle` `checked/onChange/label` props are confirmed to exist.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/components/Modal.js "src/app/(dashboard)/dashboard/providers/[id]/HeaderFormModal.js"
git commit --no-verify -m "feat(ui): HeaderFormModal popup + Modal disableEscape prop for nesting"
```

### Task 6: Table UI + popup wiring in EditCompatibleNodeModal

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js`

**Interfaces:**
- Consumes: `HeaderFormModal` (Task 5); `Tooltip`, `Button` (icon prop).
- Produces: header list rendered as a table; add/edit via popup; delete via icon.

- [ ] **Step 1: Update imports + state**

In `EditCompatibleNodeModal.js`, extend the import to add `Tooltip`:

```javascript
import { Button, Badge, Input, Modal, Select, Tooltip } from "@/shared/components";
import HeaderFormModal from "./HeaderFormModal";
```

Add popup state near the other `useState`s:

```javascript
  const [headerForm, setHeaderForm] = useState({ open: false, mode: "add", index: null });
```

- [ ] **Step 2: Replace the row handlers**

Remove `updateHeader` and `addHeader` (the inline-editing helpers) and replace with popup-driven handlers. Keep `removeHeader`. Replace lines 42-46 (the block starting `const updateHeader =` through `const removeHeader = ...`) with:

```javascript
  const removeHeader = (index) => setCustomHeaders((rows) => rows.filter((_, i) => i !== index));

  const openAddHeader = () => setHeaderForm({ open: true, mode: "add", index: null });
  const openEditHeader = (index) => setHeaderForm({ open: true, mode: "edit", index });
  const closeHeaderForm = () => setHeaderForm({ open: false, mode: "add", index: null });

  const submitHeaderForm = (row) => {
    setCustomHeaders((rows) => {
      if (headerForm.mode === "edit" && headerForm.index != null) {
        return rows.map((r, i) => (i === headerForm.index ? row : r));
      }
      // add: replace an existing same-name (case-insensitive) row, else append
      const lower = row.name.toLowerCase();
      const existingIdx = rows.findIndex((r) => r.name.trim().toLowerCase() === lower);
      if (existingIdx >= 0) return rows.map((r, i) => (i === existingIdx ? row : r));
      return [...rows, row];
    });
    closeHeaderForm();
  };

  const formatPersist = (ttl) => (ttl === null || ttl === undefined ? "-" : ttl === 0 ? "Permanent" : `${ttl} min`);
```

`hasInvalidHeader` stays (rows entering via the popup are already valid; keep the guard as a safety net). `handleSubmit`'s `customHeaders` payload mapping must now also carry `ttlMinutes`:

```javascript
      payload.customHeaders = customHeaders
        .filter((h) => h.name.trim() !== "")
        .map((h) => ({ name: h.name.trim(), value: h.value, ttlMinutes: h.ttlMinutes ?? null }));
```

- [ ] **Step 3: Replace the header section JSX with a table**

Replace the entire Request Headers `<div className="flex flex-col gap-2">...</div>` block (currently lines 125-164, from the `<label>Request Headers</label>` container through the closing `</div>` after the hint `<p>`) with:

```javascript
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Request Headers</label>
            <Button type="button" variant="secondary" onClick={openAddHeader}>
              + Add
            </Button>
          </div>
          <div className="border border-border-subtle rounded-[10px] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-text-muted">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Name</th>
                  <th className="text-left font-medium px-3 py-2">Value</th>
                  <th className="text-left font-medium px-3 py-2">Persist</th>
                  <th className="text-right font-medium px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {customHeaders.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-text-muted">No custom headers</td>
                  </tr>
                )}
                {customHeaders.map((h, i) => (
                  <tr key={i} className="border-t border-border-subtle">
                    <td className="px-3 py-2 font-mono">{h.name}</td>
                    <td className="px-3 py-2 max-w-[180px] truncate" title={h.value}>{h.value}</td>
                    <td className="px-3 py-2">{formatPersist(h.ttlMinutes)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip text="Edit" position="top">
                          <Button type="button" variant="ghost" size="sm" icon="edit" onClick={() => openEditHeader(i)} />
                        </Tooltip>
                        <Tooltip text="Delete" position="top">
                          <Button type="button" variant="ghost" size="sm" icon="delete" onClick={() => removeHeader(i)} />
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-neutral-500">
            Overrides preset headers of the same name. Persist reuses the resolved
            value per connection (0 minutes = permanent, until restart).
          </p>
        </div>
```

- [ ] **Step 4: Disable Escape on the host modal while the popup is open, and render the popup**

Change the host `<Modal ...>` opening tag to pass `disableEscape` and `closeOnOverlay` guarded by the popup:

```javascript
    <Modal isOpen={isOpen} title={`Edit ${isAnthropic ? "Anthropic" : "OpenAI"} Compatible`} onClose={onClose} disableEscape={headerForm.open} closeOnOverlay={!headerForm.open}>
```

(If the current `<Modal>` opening tag doesn't already set `closeOnOverlay`, add it as shown; keep the existing `title`/`onClose`.)

Then render `HeaderFormModal` just before the closing `</Modal>` (after the Save/Cancel button `<div>`):

```javascript
        <HeaderFormModal
          isOpen={headerForm.open}
          mode={headerForm.mode}
          initial={headerForm.index != null ? customHeaders[headerForm.index] : null}
          existingNames={customHeaders
            .filter((_, i) => i !== headerForm.index)
            .map((h) => h.name.trim().toLowerCase())}
          onSubmit={submitHeaderForm}
          onClose={closeHeaderForm}
        />
```

- [ ] **Step 5: Update PropTypes**

Extend the `customHeaders` shape in `EditCompatibleNodeModal.propTypes` to include ttlMinutes:

```javascript
    customHeaders: PropTypes.arrayOf(
      PropTypes.shape({ name: PropTypes.string, value: PropTypes.string, ttlMinutes: PropTypes.number })
    ),
```

- [ ] **Step 6: Lint + manual verification**

Run (from repo root): `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js"`
Expected: only the PRE-EXISTING `react-hooks/set-state-in-effect` error on the `setFormData` hydration effect (present at base) — no NEW errors. Re-read the final file: table renders rows, `+` opens add popup, edit pre-fills, delete removes, popup validates and blocks its own Save, host modal gets `disableEscape` while popup open.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js"
git commit --no-verify -m "feat(ui): table view + add/edit popup + icon actions for custom headers"
```

---

### Task 7: Full regression + lint gate

- [ ] **Step 1: Run the feature test bundle**

Run (from `tests/`):
```bash
npx vitest run unit/header-cache.test.js unit/header-template.test.js unit/custom-headers-executor.test.js unit/custom-headers-normalize.test.js unit/custom-headers-api.test.js
```
Expected: all assertion-bearing tests PASS. `custom-headers-api.test.js` may show a Windows `EPERM` in `afterEach` teardown (pre-existing env artifact, not a regression).

- [ ] **Step 2: Lint all changed non-UI files**

Run (from repo root):
```bash
npx eslint open-sse/utils/headerCache.js open-sse/utils/headerTemplate.js open-sse/executors/default.js src/lib/customHeaders.js src/shared/components/Modal.js
```
Expected: exit 0.

- [ ] **Step 3: Confirm no cross-feature regression**

Run (from `tests/`): `npx vitest run unit/openai-compatible-apitype-resolution.test.js unit/compatible-provider-connections.test.js`
Expected: assertions pass (EPERM teardown on the compatible-connections file is pre-existing). No new failures attributable to this feature.

