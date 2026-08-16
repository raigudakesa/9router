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
  executor integration, edit-modal UI (table + nested add/edit popup, icon-only
  row actions), a small `disableEscape` addition to the shared `Modal`, unit
  tests.
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

## UI — table + nested header-form popup

The inline row-of-inputs editor is replaced by a **table view** with an
**add/edit popup**. Two React components:

### `EditCompatibleNodeModal.js` (host) — the Request Headers table

- A section header "Request Headers" with a **`+` Add** `Button` above the table.
- A styled HTML `<table>` (Tailwind, matching existing dashboard table styling)
  listing the current `customHeaders` rows. Columns:
  - **Name** — the header name.
  - **Value** — the raw template value (truncate long values with `title`
    tooltip / `truncate` class).
  - **Persist** — rendered from `ttlMinutes`: `null` → `—`; `0` → `∞` (or
    "Permanent"); `N` → `N min`.
  - **Actions** (icon-only) — an **Edit** `Button` (`icon="edit"`) and a
    **Delete** `Button` (`icon="delete"`, `variant="ghost"`), each wrapped in a
    `Tooltip`.
- Empty state: a muted "No custom headers" row when the list is empty.
- **Add** (`+`) opens the popup in "add" mode; **Edit** opens it in "edit" mode
  pre-filled with that row (tracked by index); **Delete** removes the row from
  local state immediately (the node only persists on the modal's Save, so no
  separate confirm needed).
- Row state is still `{ name, value, ttlMinutes }`; `handleSubmit` includes
  `ttlMinutes` per row unchanged.
- Client validation runs on the assembled list (same rules: valid header name,
  valid ttl) and blocks the modal's Save when any row is invalid — but since the
  popup validates on submit (below), invalid rows never enter the list in
  practice.
- Hint text below the table: "Persist reuses the resolved value per connection —
  0 minutes = permanent (until restart)."

### `HeaderFormModal.js` (new) — the add/edit popup

A small nested `<Modal>` (size `sm`) with the single-header form:

- **Name** `Input` (validated against the header-name regex; error shown
  inline).
- **Value** `Input` (placeholder `value or sess_{ralpha_num:26}`), with the
  dynamic-tag / `{header:...}` / `{opencode_session}` / `{remove}` hint text.
- **Persist** checkbox (`Toggle` or a checkbox `Input`).
- **Minutes** number input, enabled only when Persist is checked, placeholder
  `min (0 = ∞)`.
- Footer: **Save** (disabled while name invalid or ttl invalid) + **Cancel**.
- On Save: assembles `{ name: name.trim(), value, ttlMinutes }` (persist
  unchecked → `null`; checked + empty/0 → `0`; checked + N → `N`) and calls
  `onSubmit(row)`; the host inserts (add) or replaces at index (edit).
- Props: `isOpen`, `mode` ("add" | "edit"), `initial` (the row or defaults),
  `existingNames` (lowercased, minus the row being edited) to warn on duplicate
  names, `onSubmit`, `onClose`.

### Nested-modal Escape / stacking fix

The shared `Modal` registers a document-level `Escape` listener and uses
`z-50`; a naive nested modal would (a) let one Escape close both, and (b) stack
two dim overlays at the same z-index. Fix:

- Extend the shared `Modal` component with an optional **`disableEscape`** prop
  (default `false`): when true, the component skips registering its Escape
  handler. This is a small, backward-compatible addition useful for any nested
  modal.
- While `HeaderFormModal` is open, the host passes `disableEscape` to its own
  `EditCompatibleNodeModal`'s `<Modal>` (and `closeOnOverlay={false}`), so
  Escape and overlay-click only affect the top popup.
- Render `HeaderFormModal` with a higher stacking context via a `className`
  that raises its wrapper z-index above `z-50` (e.g. pass `className` that sets
  `z-[60]` on the fixed wrapper, or add a `zClass` prop) so the popup and its
  overlay sit above the host modal.

> Implementation note: verify the exact mechanism against `Modal.js` during
> implementation — the two needed hooks are "don't close the parent on Escape
> while a child is open" and "paint the child above the parent". The
> `disableEscape` prop on the parent + a higher z-index on the child satisfy
> both without breaking existing single-modal usage.

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
- **UI:** No automated UI test harness in this repo (consistent with the base
  feature). Verification is manual + eslint: the table renders rows with correct
  Persist column formatting (`—`/`∞`/`N min`); `+` opens the add popup; Edit
  pre-fills; Delete removes the row; the popup validates name/ttl and blocks its
  Save; while the popup is open, Escape closes only the popup (not the host
  modal) and the popup paints above the host. Extend `Modal`'s existing usage
  without regressing single-modal Escape (spot-check another modal still closes
  on Escape).

## Non-goals / risks

- In-memory only: "permanent" values and all TTLs reset on server restart.
  Accepted per product decision (no DB dependency).
- Unbounded growth mitigated by a 5000-entry cap with oldest-eviction; not an
  LRU — adequate for the expected small header count per connection.
