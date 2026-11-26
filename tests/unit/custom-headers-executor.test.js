import { describe, it, expect } from "vitest";
import { DefaultExecutor } from "open-sse/executors/default.js";
import { applyHeaderOverrides, collectRemoveHeaders } from "open-sse/utils/headerTemplate.js";
import { __clearHeaderCache } from "open-sse/utils/headerCache.js";
import { beforeEach } from "vitest";
beforeEach(() => __clearHeaderCache());

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

  it("{remove} deletes a preset header entirely (case-insensitive, nothing sent)", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h = ex.buildHeaders(creds([{ name: "content-type", value: "{remove}" }]), true);
    const keys = Object.keys(h).filter((k) => k.toLowerCase() === "content-type");
    expect(keys).toHaveLength(0);
  });

  it("{remove} on a non-existent header is a no-op (header simply absent)", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const h = ex.buildHeaders(creds([{ name: "X-Absent", value: "{remove}" }]), true);
    const keys = Object.keys(h).filter((k) => k.toLowerCase() === "x-absent");
    expect(keys).toHaveLength(0);
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
    // An array whose element access throws → forces resolveCustomHeaders to throw
    // inside buildHeaders' try, exercising the fail-open catch.
    const bad = [];
    Object.defineProperty(bad, 0, { enumerable: true, get() { throw new Error("boom"); } });
    bad.length = 1;
    const h = ex.buildHeaders(creds(bad), true);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h.Authorization).toBe("Bearer sk-test");
  });
});

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

  it("does not cache a persistent header when connection identity is absent (connId=default)", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    // creds() default extra has no connectionId/email/id
    const c = creds([{ name: "X-Session", value: "{ralpha_num:26}", ttlMinutes: 0 }]);
    const a = ex.buildHeaders(c, true)["X-Session"];
    const b = ex.buildHeaders(c, true)["X-Session"];
    expect(a).not.toBe(b);
  });

  it("timed-expiry regenerates through the executor with an injected clock", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    let t = 1000;
    const mk = () => creds([{ name: "X-Session", value: "{ralpha_num:26}", ttlMinutes: 5 }], { connectionId: "conn-exp", _nowForTest: () => t });
    const a = ex.buildHeaders(mk(), true)["X-Session"];
    t = 1000 + 4 * 60000; // within 5 min → cached
    const b = ex.buildHeaders(mk(), true)["X-Session"];
    expect(b).toBe(a);
    t = 1000 + 6 * 60000; // past 5 min → regenerate
    const c2 = ex.buildHeaders(mk(), true)["X-Session"];
    expect(c2).not.toBe(a);
  });
});

describe("applyHeaderOverrides — provider settings overrides", () => {
  it("replaces Accept case-insensitively instead of duplicating it", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const built = ex.buildHeaders(creds(undefined), true);
    applyHeaderOverrides(built, { accept: "application/json" });
    const keys = Object.keys(built).filter((k) => k.toLowerCase() === "accept");
    expect(keys).toHaveLength(1);
    expect(built[keys[0]]).toBe("application/json");
  });

  it("drops a header when the override value is {remove}", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-x");
    const built = ex.buildHeaders(creds(undefined), true);
    applyHeaderOverrides(built, { Accept: "{remove}" });
    expect(Object.keys(built).filter((k) => k.toLowerCase() === "accept")).toHaveLength(0);
  });
});

describe("collectRemoveHeaders — {remove} names for transport stripping", () => {
  it("reads node customHeaders rows", () => {
    expect(collectRemoveHeaders([{ name: "sec-fetch-mode", value: "{remove}" }, { name: "X-Keep", value: "1" }]))
      .toEqual(["sec-fetch-mode"]);
  });

  it("reads a provider override map, trimming surrounding whitespace", () => {
    expect(collectRemoveHeaders({ Accept: " {remove} ", "X-Keep": "1" })).toEqual(["Accept"]);
  });

  it("returns nothing for a non-remove set", () => {
    expect(collectRemoveHeaders([{ name: "X", value: "pre {remove}" }])).toEqual([]);
    expect(collectRemoveHeaders(undefined)).toEqual([]);
  });
});

describe("transport strip — headers fetch injects itself", () => {
  it("removes sec-fetch-mode and accept from the outgoing header set", async () => {
    const { stripHeadersForTest } = await import("open-sse/utils/proxyFetch.js");
    const out = stripHeadersForTest({ "sec-fetch-mode": "cors", accept: "*/*", "user-agent": "undici" }, ["Sec-Fetch-Mode", "accept"]);
    expect(out).toEqual({ "user-agent": "undici" });
  });

  it("is a no-op with no names", async () => {
    const { stripHeadersForTest } = await import("open-sse/utils/proxyFetch.js");
    const input = { accept: "*/*" };
    expect(stripHeadersForTest(input, [])).toBe(input);
  });
});

describe("DefaultExecutor buildHeaders — {forward:Name}", () => {
  const ex = () => new DefaultExecutor("openai-compatible-chat-x");

  it("forwards the inbound client header value upstream", () => {
    const c = creds([{ name: "X-Trace", value: "{forward:x-session-id}" }], { rawHeaders: { "x-session-id": "abc-123" } });
    expect(ex().buildHeaders(c, true)["X-Trace"]).toBe("abc-123");
  });

  it("omits the header entirely when the source is absent", () => {
    const c = creds([{ name: "X-Trace", value: "{forward:x-session-id}" }], { rawHeaders: {} });
    const h = ex().buildHeaders(c, true);
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("x-trace");
  });

  it("is not persisted/cached even with ttlMinutes set (per-request value)", () => {
    const mk = (sid) => creds([{ name: "X-Trace", value: "{forward:x-session-id}", ttlMinutes: 0 }], {
      connectionId: "conn-1",
      rawHeaders: { "x-session-id": sid },
    });
    const h1 = ex().buildHeaders(mk("a"), true);
    const h2 = ex().buildHeaders(mk("b"), true);
    expect(h1["X-Trace"]).toBe("a");
    expect(h2["X-Trace"]).toBe("b");
  });
});

describe("DefaultExecutor buildHeaders — fallbackHeaders", () => {
  const ex = () => new DefaultExecutor("openai-compatible-chat-x");

  it("sends the fallback when the forwarded source header is absent", () => {
    const c = {
      apiKey: "sk-test",
      providerSpecificData: {
        baseUrl: BASE,
        apiType: "chat",
        customHeaders: [{ name: "X-Trace", value: "{forward:x-session-id}" }],
        fallbackHeaders: [{ name: "X-Trace", value: "default-trace" }],
      },
      rawHeaders: {},
    };
    expect(ex().buildHeaders(c, true)["X-Trace"]).toBe("default-trace");
  });

  it("prefers the primary forwarded value when present", () => {
    const c = {
      apiKey: "sk-test",
      providerSpecificData: {
        baseUrl: BASE,
        apiType: "chat",
        customHeaders: [{ name: "X-Trace", value: "{forward:x-session-id}" }],
        fallbackHeaders: [{ name: "X-Trace", value: "default-trace" }],
      },
      rawHeaders: { "x-session-id": "abc" },
    };
    expect(ex().buildHeaders(c, true)["X-Trace"]).toBe("abc");
  });

  it("works with no customHeaders at all (fallback-only list)", () => {
    const c = {
      apiKey: "sk-test",
      providerSpecificData: { baseUrl: BASE, apiType: "chat", fallbackHeaders: [{ name: "X-Default", value: "d" }] },
    };
    expect(ex().buildHeaders(c, true)["X-Default"]).toBe("d");
  });
});
