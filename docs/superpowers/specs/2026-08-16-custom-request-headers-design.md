# Custom Request Headers for Compatible Provider Nodes — Design

Date: 2026-08-16
Status: Approved (pending implementation)

## Summary

Add a "Request Headers" section to the Custom Provider Details edit modal
(`EditCompatibleNodeModal`). Users add arbitrary `Name: Value` request headers
that are sent to the upstream on every request. Values support:

1. **Preset override** — a custom header replaces any preset header of the same
   name (case-insensitive), e.g. `User-Agent` overrides the default UA instead
   of duplicating it.
2. **Dynamic tags** — templated random-value generators resolved fresh per
   request, e.g. `sess_{ralpha_num:26}` → `sess_ffa37e3a7ffe2bvfTEUuFBTg4N`.
3. **Header references** — one header value can copy another header's final
   resolved value via `{header:Other-Header}`.

Applies to all compatible node types: `openai-compatible`,
`anthropic-compatible`, `custom-embedding`. Custom headers are applied LAST and
may override any header including auth headers (`Authorization`, `x-api-key`),
`Content-Type`, and `Accept` — full user control by design.

## Scope

- **In scope:** edit modal UI, node persistence, connection propagation,
  per-request resolver, executor merge, unit tests for the resolver.
- **Out of scope:** the `new/page.js` create-node form (v1 = edit modal only;
  user creates a node then edits to add headers). Special executors
  (kiro/cursor/etc.) — compatible nodes always route through `DefaultExecutor`.

## Data model

Header list shape (stored raw, templates unresolved):

```js
customHeaders: [ { name: "X-Session", value: "sess_{ralpha_num:26}" }, ... ]
```

Persistence:

- **Node**: `customHeaders` lives as an extra key inside `providerNodes.data`
  JSON. `nodesRepo.js` already persists arbitrary rest-keys via
  `nodeToRow`/`rowToNode` — **no schema or migration change needed**.
- **Connection**: copied into `connection.providerSpecificData.customHeaders`
  so it reaches the executor at runtime (executor only sees `credentials`, which
  carries `providerSpecificData`).

Validation rules (server + client):

- `name` required, non-empty, must match HTTP header-token regex
  `^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$`.
- Empty rows (no name) dropped silently.
- Dedupe by case-insensitive name — last occurrence wins.
- Invalid non-empty name → reject with HTTP 400 (server) / block Save (client).

## Template resolver — `open-sse/utils/headerTemplate.js`

New pure, side-effect-free, unit-testable module.

### Charsets

```
lalpha  = a-z
ualpha  = A-Z
ralpha  = a-z + A-Z
num     = 0-9
symbol  = - . _ ~        (URL/header-safe subset)
```

### Dynamic tag grammar

`{<charset>[_<charset>...][:<length>]}`

- Charsets joined by `_` are pooled into one set; each output char is picked
  uniformly at random from the pool.
- `:<length>` optional; default `1`. Length must be a positive integer; cap at
  **256** to prevent abuse. Invalid/zero/negative length → treated as literal
  (fail-safe).
- Unknown charset token (e.g. `{foo}`) → left **literal**, not resolved, so
  ordinary braces in text are preserved.
- Examples:
  - `{ralpha_num:26}` → 26 chars from `[a-zA-Z0-9]`
  - `{ualpha_symbol}` → 1 char
  - `sess_{ralpha_num:26}` → `sess_` + 26 random chars

### Header reference

`{header:<Name>}`

- Replaced with the **final resolved value** of header `<Name>`
  (case-insensitive match).
- Missing source header → replaced with empty string.
- Chained refs (`A → B → C`) resolved; cycles (`A → B → A`) are broken by a
  visited-set / max-depth guard, missing link resolves to empty. No infinite
  loop.

### Randomness

Use `crypto.randomBytes` / `crypto.getRandomValues` with rejection sampling to
avoid modulo bias.

### Two-pass algorithm

Input: ordered `[{name, value}]`. Output: `{ [name]: value }`.

1. **Pass 1** — resolve all dynamic tags in every value → intermediate map
   `{name: valueWithHeaderRefsOnly}`. Dynamic randoms are generated exactly once
   here, so a `{header:X}` ref copies the SAME random `X`, not a fresh one.
2. **Pass 2** — resolve `{header:...}` refs against the pass-1 map, with the
   cycle guard.

## Executor integration — `open-sse/executors/default.js`

In `buildHeaders(credentials, stream, url, model)`, at the **very end** of the
function (after auth, quirks, and the `Accept` line — so custom headers win over
everything including `Accept`):

```js
const customHeaders = credentials?.providerSpecificData?.customHeaders;
if (Array.isArray(customHeaders) && customHeaders.length) {
  try {
    const resolved = resolveCustomHeaders(customHeaders); // {name: value}
    for (const [name, value] of Object.entries(resolved)) {
      const existing = Object.keys(headers).find(
        (k) => k.toLowerCase() === name.toLowerCase()
      );
      if (existing) delete headers[existing];
      headers[name] = value;
    }
  } catch {
    /* fail-open: bad template must never break the request */
  }
}
```

Semantics:

- Applied last → overrides any preset header, including auth and `Accept`.
- Case-insensitive replace → no duplicate `User-Agent` etc.
- Fail-open (matches `rtk/` convention): any resolver throw skips custom headers;
  the request still goes out with base headers.

## API changes

- `POST /api/provider-nodes` (create) — accept + validate `customHeaders`, store
  on node. (Note: create form UI stays untouched; the field is accepted if sent
  but the v1 UI only sets it via edit.)
- `PUT /api/provider-nodes/[id]` (update) — accept + validate `customHeaders`,
  store on node, AND include it in the `providerSpecificData` fan-out to each
  existing connection of that node (the existing `Promise.all` block).
- `POST /api/providers` (create connection) — in the
  `isOpenAICompatibleProvider` / `isAnthropicCompatibleProvider` /
  `isCustomEmbeddingProvider` branches, add
  `customHeaders: node.customHeaders` to the built `providerSpecificData` so new
  connections inherit the node's headers.

## UI — `EditCompatibleNodeModal.js` + `providers/[id]/page.js`

Modal, new "Request Headers" section below Base URL:

- Row list: `Name` input + `Value` input + remove (×) per row.
- `+ Add Header` button appends an empty row.
- Hydrated from `node.customHeaders` in the `useEffect` that seeds `formData`.
- `handleSubmit` includes `customHeaders` in the payload (trim names, drop empty
  rows).
- Hint text documenting tags: charset list, `{charset[_charset][:length]}`, and
  `{header:Name}`.
- Client validation: mark invalid non-empty header-name rows; block Save while
  any invalid row exists.

`page.js`: the edit-modal `onSave` handler (~line 1793) must forward
`customHeaders` in the `PUT /api/provider-nodes/[id]` request body (currently
sends `{name, prefix, apiType, baseUrl}`).

## Testing

- Unit tests for `headerTemplate.js`:
  - each charset produces only allowed chars; length honored; default length 1
  - combined charsets pool correctly
  - length cap enforced; invalid length left literal
  - unknown charset left literal
  - `{header:X}` copies resolved value; missing → empty; cycle guarded
  - `{header:X}` copies the same random as source (pass ordering)
- Executor test: custom `User-Agent` replaces preset (no dup, case-insensitive);
  custom `Authorization` overrides auth; resolver throw → base headers intact
  (fail-open).
- API test: PUT propagates `customHeaders` into connection
  `providerSpecificData`; invalid header name → 400.

## Non-goals / risks

- Full ASCII symbol set intentionally excluded (avoids `{ } :` colliding with tag
  syntax and header-breaking chars).
- Allowing auth override is deliberate; a user can break their own auth. Acceptable
  per product decision (full control).
