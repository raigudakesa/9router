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
