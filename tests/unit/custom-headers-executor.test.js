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
