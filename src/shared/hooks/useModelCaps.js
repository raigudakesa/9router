"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
let cache = null; // { byFull, byId } | null
let inflight = null;

function buildMaps(models, customModels) {
  const byFull = {};
  const byId = {};
  for (const m of models || []) {
    if (!m.caps) continue;
    if (m.fullModel) byFull[m.fullModel] = m.caps;
    if (m.routedModel) byFull[m.routedModel] = m.caps;
    if (m.model) byId[m.model] = m.caps;
  }
  // User-added custom models carry their own declared caps (vision/reasoning/…).
  // /api/models only lists built-ins, so without this a custom combo member
  // resolves to registry-default caps and its badges are wrong/empty.
  for (const m of customModels || []) {
    if (!m?.caps || !m?.providerAlias || !m?.id) continue;
    byFull[`${m.providerAlias}/${m.id}`] = m.caps;
    if (!byId[m.id]) byId[m.id] = m.caps;
  }
  return { byFull, byId };
}

function loadModelCaps() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = Promise.all([
    fetch("/api/models").then((r) => (r.ok ? r.json() : { models: [] })).catch(() => ({ models: [] })),
    fetch("/api/models/custom", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { models: [] })).catch(() => ({ models: [] })),
  ])
    .then(([data, customData]) => {
      cache = buildMaps(data.models, customData.models);
      return cache;
    })
    .catch(() => {
      // Keep null so a later mount can retry
      return { byFull: {}, byId: {} };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Resolve caps from a "provider/model" string or a bare model id.
function resolveCaps(byFull, byId, key) {
  if (!key) return null;
  if (byFull[key]) return byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (byId[bare]) return byId[bare];
  const provider = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const c = getCapabilitiesForModel(provider, bare);
  return {
    vision: c.vision,
    search: c.search,
    reasoning: c.reasoning,
    contextWindow: c.contextWindow,
    maxOutput: c.maxOutput,
  };
}

export function useModelCaps() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});

  useEffect(() => {
    let alive = true;
    const load = () => {
      loadModelCaps().then((maps) => {
        if (alive) { setByFull(maps.byFull); setById(maps.byId); }
      });
    };
    // cache-hit is already seeded by the useState initializers; only fetch on miss
    if (!cache) load();
    // Adding/removing a custom model (with new caps) should refresh badges
    // without a full reload — the providers page fires this on change.
    const onCustomModelChanged = () => { cache = null; load(); };
    if (typeof window !== "undefined") window.addEventListener("customModelChanged", onCustomModelChanged);
    return () => {
      alive = false;
      if (typeof window !== "undefined") window.removeEventListener("customModelChanged", onCustomModelChanged);
    };
  }, []);

  const getCaps = useCallback(
    (key) => resolveCaps(byFull, byId, key),
    [byFull, byId],
  );

  return { getCaps };
}
