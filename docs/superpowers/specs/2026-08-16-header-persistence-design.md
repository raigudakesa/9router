# Custom Request Header Persistence — Design

Date: 2026-08-16
Status: Approved (pending implementation)

## Summary

Extend custom request headers so a header's resolved value can be **persisted**
(cached and reused) instead of regenerated on every request. Two modes:

- **Permanent** — cached for the process lifetime (until the server restarts).
- **Timed** — cached for N minutes, then regenerated on the next request.

Persistence is set per header row via a "Persist" checkbox + a minutes number
in the Edit modal. It applies to any header value, most usefully to dynamic
ones (`sess_{ralpha_num:26}`, `{opencode_session}`) that would otherwise change
every request but should stay stable (e.g. a stable session id per connection).

Cache scope is **per connection**. Storage is **in-memory** in the `open-sse`
engine — "permanent" means for the life of the process, and all cached values
are lost on restart (accepted tradeoff; no DB persistence).

## Scope

- **In scope:** data-model field, in-memory cache module, resolver hook,
  executor integration, edit-modal UI, unit tests.
- **Out of scope:** DB-backed durability across restarts; cross-connection or
  client-session cache scopes; the `new/page.js` create form (edit-modal only,
  consistent with the base feature).

## Data model

Header row gains one optional field:

```js
{ name: string, value: string, ttlMinutes: number | null }
```

Semantics of `ttlMinutes`:

- `null` (or absent) → **not persistent**; regenerate every request (current
  behavior, backward compatible).
- `0` → **permanent** for the process lifetime.
- `N > 0` → cached for N minutes, then regenerated.

Stored on the node's `customHeaders[]` (JSON `data` column, no schema change)
and propagated to each connection's `providerSpecificData.customHeaders[]` via
the existing wholesale-array fan-out — `ttlMinutes` rides along with zero route
changes.

`normalizeCustomHeaders` (`src/lib/customHeaders.js`) normalizes `ttlMinutes`:
coerce to a non-negative integer; `null`/absent stays null; negative, NaN, or
non-integer → coerced to `null` (lenient fallback, no 400 — matches existing
lenient value handling). The client blocks Save on invalid ttl as a UX guard,
but the server never rejects on it.

## Cache module — `open-sse/utils/headerCache.js`

Isolated, testable, in-memory. Single `Map`.

```
cacheKey = connectionId + "\0" + lowerHeaderName + "\0" + rawValue
entry    = { value: string, expiresAt: number | null }   // null = permanent
```

API:

```
getOrResolvePersistent(cacheKey, ttlMinutes, resolveFn, now = Date.now()) -> string
```

- Lookup `cacheKey`. If an entry exists and (`expiresAt === null` OR
  `now < expiresAt`) → return cached `value`.
- Otherwise call `resolveFn()` (produces a fresh resolved value), store
  `{ value, expiresAt: ttlMinutes > 0 ? now + ttlMinutes * 60000 : null }`,
  return the fresh value.
- `now` is injectable for deterministic tests.
- Including `rawValue` in the key auto-busts the cache when the header template
  text is edited.
- Lazy expiry (checked on read). A simple size guard evicts the oldest entry
  when the map exceeds a cap (5000) to bound growth.
- Also export a `__clearHeaderCache()` test helper to reset the map between
  tests.

Never throws for normal inputs; the caller's existing `buildHeaders` try/catch
provides the fail-open boundary regardless.

## Resolver integration — `open-sse/utils/headerTemplate.js`

The `{header:X}` ref feature requires all header values resolved together
(pass 2 resolves refs against pass-1 values). Persistence is per-header, so
`resolveCustomHeaders` gains an optional per-header resolve hook:

```
resolveCustomHeaders(customHeaders, { resolveValue } = {}) -> { [name]: value }
```

- `resolveValue(name, rawValue, defaultResolve)` — invoked once per header
  during **pass 1**. Default (no hook) = `defaultResolve()` =
  `resolveTemplateValue(rawValue)` (today's behavior, fully backward
  compatible).
- The `{remove}` directive is detected on the raw value BEFORE the hook and
  short-circuits to the `REMOVE_HEADER` sentinel — **removed headers are never
  cached**.
- **Pass 2 unchanged:** `{header:X}` refs resolve against the pass-1 values, so
  a ref copies the header's *cached* value when the source is persistent (a
  stable session id stays stable, and headers copying it stay consistent).

## Executor integration — `open-sse/executors/default.js`

In `buildHeaders`, build the hook and pass it to `resolveCustomHeaders`:

- Resolve a connection id: `credentials?.connectionId || credentials?.email ||
  credentials?.id || "default"`.
- For each header, look up its `ttlMinutes` (from the same `customHeaders`
  array). The hook:
  - if `ttlMinutes == null` → `defaultResolve()` (no caching);
  - else → `getOrResolvePersistent(connId + "\0" + name.toLowerCase() + "\0" +
    rawValue, ttlMinutes, defaultResolve)`.
- The rest of the merge block (case-insensitive override, `REMOVE_HEADER`
  delete, CRLF strip) is unchanged. Whole thing stays inside the existing
  fail-open try/catch.

## UI — `EditCompatibleNodeModal.js`

Each header row gains, after the Value input:

- A **"Persist"** checkbox.
- A **minutes** number input, enabled only when Persist is checked, placeholder
  like `min (0 = ∞)`.

State/derivation:

- Row state carries `{ name, value, ttlMinutes }`.
- On hydration: `persist = ttlMinutes !== null`; minutes field shows
  `ttlMinutes ?? ""` (0 rendered as `0`).
- On change:
  - Persist unchecked → `ttlMinutes = null`.
  - Persist checked, minutes empty or `0` → `ttlMinutes = 0` (permanent).
  - Persist checked, minutes `N` → `ttlMinutes = N`.
- `handleSubmit` includes `ttlMinutes` per row (empty→null; else `Number`).
- Client validation: a persistent row with a negative or non-integer minutes
  value is marked invalid and blocks Save. (Server still coerces to null if it
  somehow arrives.)
- Hint text gains one line: "Persist reuses the resolved value per connection —
  0 minutes = permanent (until restart)."

## Testing

- **headerCache.js:** miss→resolve→store; hit-fresh reuse (same value,
  `resolveFn` called exactly once); timed expiry after `now` passes ttl;
  permanent (`ttlMinutes 0`) never expires; raw-value change produces a
  different key (busts cache); different connection id → different key;
  size-cap eviction; `__clearHeaderCache` resets.
- **resolveCustomHeaders hook:** persistent header reuses the cached value
  across two calls; non-persistent regenerates; `{header:X}` ref copies the
  cached value of a persistent source; `{remove}` is never cached; no-hook
  path identical to current behavior.
- **executor:** two `buildHeaders` calls, same connection → persistent header
  identical; different `connectionId` → different value; timed expiry
  regenerates (injected clock); non-persistent still varies.
- **normalizeCustomHeaders:** `ttlMinutes` null/0/N preserved; negative / NaN /
  non-integer → null; existing name/value validation unchanged.

## Non-goals / risks

- In-memory only: "permanent" values and all TTLs reset on server restart.
  Accepted per product decision (no DB dependency).
- Unbounded growth mitigated by a 5000-entry cap with oldest-eviction; not an
  LRU — adequate for the expected small header count per connection.
