import { describe, it, expect } from "vitest";
import { resolveCustomHeaders, resolveTemplateValue, generateOpencodeSessionId, REMOVE_HEADER } from "open-sse/utils/headerTemplate.js";

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
  it("strips CR/LF from resolved value", () => {
    const out = resolveCustomHeaders([{ name: "X", value: "a\r\nb" }]);
    expect(out).toEqual({ X: "ab" });
  });
});

describe("special token {opencode_session}", () => {
  // opencode Identifier: "ses_" + 12 hex + 14 base62 = "ses_" + 26 chars.
  const SES_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

  it("generateOpencodeSessionId matches opencode ses_ format", () => {
    expect(generateOpencodeSessionId()).toMatch(SES_RE);
  });

  it("resolves {opencode_session} to a ses_ id", () => {
    expect(resolveTemplateValue("{opencode_session}")).toMatch(SES_RE);
  });

  it("resolves inside a larger value", () => {
    const out = resolveTemplateValue("sid={opencode_session}");
    expect(out).toMatch(/^sid=ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("is NOT combinable and takes no length (any variation left literal)", () => {
    // With a length param it is not the special token; falls through to
    // charset logic where "opencode"/"session" are unknown → left literal.
    expect(resolveTemplateValue("{opencode_session:5}")).toBe("{opencode_session:5}");
    // Combined with a real charset is likewise not the special token.
    expect(resolveTemplateValue("{opencode_session_num}")).toBe("{opencode_session_num}");
  });

  it("generates a fresh id each call (uniqueness)", () => {
    const a = generateOpencodeSessionId();
    const b = generateOpencodeSessionId();
    expect(a).not.toBe(b);
  });

  it("works as a full custom header value and can be copied via {header:...}", () => {
    const out = resolveCustomHeaders([
      { name: "X-Session", value: "{opencode_session}" },
      { name: "X-Copy", value: "{header:X-Session}" },
    ]);
    expect(out["X-Session"]).toMatch(SES_RE);
    expect(out["X-Copy"]).toBe(out["X-Session"]);
  });
});

describe("{remove} directive", () => {
  it("emits the REMOVE_HEADER sentinel for value {remove}", () => {
    const out = resolveCustomHeaders([{ name: "User-Agent", value: "{remove}" }]);
    expect(out["User-Agent"]).toBe(REMOVE_HEADER);
  });

  it("tolerates surrounding whitespace", () => {
    const out = resolveCustomHeaders([{ name: "X-App", value: "  {remove}  " }]);
    expect(out["X-App"]).toBe(REMOVE_HEADER);
  });

  it("only exact {remove} triggers removal (embedded text is literal-ish)", () => {
    // "{remove}" with extra text is not the directive; {remove} is an unknown
    // charset tag so it is left literal by the resolver.
    const out = resolveCustomHeaders([{ name: "X", value: "pre {remove}" }]);
    expect(out["X"]).toBe("pre {remove}");
  });

  it("a {header:...} ref to a removed header resolves to empty string", () => {
    const out = resolveCustomHeaders([
      { name: "A", value: "{remove}" },
      { name: "B", value: "x{header:A}y" },
    ]);
    expect(out["A"]).toBe(REMOVE_HEADER);
    expect(out["B"]).toBe("xy");
  });
});

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

describe("{forward:Name} — client request header forwarding", () => {
  const req = { "X-Session-Id": "abc-123", empty: "", mixedcase: "Val" };

  it("forwards the source header value", () => {
    const out = resolveCustomHeaders([{ name: "X-Out", value: "{forward:x-session-id}" }], { requestHeaders: req });
    expect(out["X-Out"]).toBe("abc-123");
  });

  it("matches the source header case-insensitively", () => {
    const out = resolveCustomHeaders(
      [{ name: "A", value: "{forward:X-SESSION-ID}" }, { name: "B", value: "{forward:mixedCase}" }],
      { requestHeaders: { "x-session-id": "abc-123", "MIXEDCASE": "Val" } }
    );
    expect(out).toEqual({ A: "abc-123", B: "Val" });
  });

  it("drops the header (sentinel) when the source is missing, empty or blank", () => {
    const out = resolveCustomHeaders(
      [{ name: "A", value: "{forward:Nope}" }, { name: "B", value: "{forward:empty}" }, { name: "C", value: "{forward:blank}" }],
      { requestHeaders: { ...req, blank: "   " } }
    );
    expect(out.A).toBe(REMOVE_HEADER);
    expect(out.B).toBe(REMOVE_HEADER);
    expect(out.C).toBe(REMOVE_HEADER);
  });

  it("drops the header when no request headers are supplied at all", () => {
    const out = resolveCustomHeaders([{ name: "A", value: "{forward:X-Session-Id}" }]);
    expect(out.A).toBe(REMOVE_HEADER);
  });

  it("supports wrapping text and other dynamic tags around the ref", () => {
    const out = resolveCustomHeaders(
      [{ name: "A", value: "sid-{forward:x-session-id}-{num:2}" }],
      { requestHeaders: req }
    );
    expect(out.A).toMatch(/^sid-abc-123-[0-9]{2}$/);
  });

  it("accepts a Headers-like object", () => {
    const out = resolveCustomHeaders([{ name: "A", value: "{forward:x-session-id}" }], { requestHeaders: new Headers(req) });
    expect(out.A).toBe("abc-123");
  });
});

describe("fallbackHeaders — defaults when the primary value is unavailable", () => {
  const req = { "x-session-id": "abc-123" };

  it("primary value wins when it resolves", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-Trace", value: "primary" }],
      { requestHeaders: req, fallbackHeaders: [{ name: "X-Trace", value: "fallback" }] }
    );
    expect(out["X-Trace"]).toBe("primary");
  });

  it("uses the fallback when the primary {forward:...} source is absent", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-Trace", value: "{forward:x-missing}" }],
      { requestHeaders: req, fallbackHeaders: [{ name: "X-Trace", value: "fallback" }] }
    );
    expect(out["X-Trace"]).toBe("fallback");
  });

  it("uses the fallback when the primary value is empty", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-Trace", value: "" }],
      { fallbackHeaders: [{ name: "X-Trace", value: "fallback" }] }
    );
    expect(out["X-Trace"]).toBe("fallback");
  });

  it("matches names case-insensitively", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-Trace", value: "{forward:nope}" }],
      { fallbackHeaders: [{ name: "x-trace", value: "fallback" }] }
    );
    expect(out["X-Trace"]).toBe("fallback");
  });

  it("fallback entries with no primary counterpart are sent", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-A", value: "a" }],
      { fallbackHeaders: [{ name: "X-Default", value: "d" }] }
    );
    expect(out).toEqual({ "X-A": "a", "X-Default": "d" });
  });

  it("fallback supports {forward:...} and dynamic tags too", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-S", value: "{forward:nope}" }],
      { requestHeaders: req, fallbackHeaders: [{ name: "X-S", value: "sid-{forward:x-session-id}" }] }
    );
    expect(out["X-S"]).toBe("sid-abc-123");
  });

  it("drops the header when both primary and fallback are unavailable", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-S", value: "{forward:nope}" }],
      { fallbackHeaders: [{ name: "X-S", value: "{forward:also-nope}" }] }
    );
    expect(out["X-S"]).toBe(REMOVE_HEADER);
  });

  it("primary {remove} is not resurrected by a fallback", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-S", value: "{remove}" }],
      { fallbackHeaders: [{ name: "X-S", value: "fallback" }] }
    );
    expect(out["X-S"]).toBe(REMOVE_HEADER);
  });

  it("a {header:Name} ref can read a fallback-only header", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-Copy", value: "{header:X-Default}" }],
      { fallbackHeaders: [{ name: "X-Default", value: "d" }] }
    );
    expect(out["X-Copy"]).toBe("d");
  });
});

describe("{forward:User-Agent} — runtime-default UA is not a client identity", () => {
  it("treats Node's own default UA (node / undici/N.x) as absent", () => {
    for (const ua of ["node", "Node", "undici", "undici/6.19.2"]) {
      const out = resolveCustomHeaders(
        [{ name: "X-S", value: "{forward:user-agent}" }],
        { requestHeaders: { "user-agent": ua }, fallbackHeaders: [{ name: "X-S", value: "fallback-ua" }] }
      );
      expect(out["X-S"]).toBe("fallback-ua");
    }
  });

  it("still forwards a real client UA", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-S", value: "{forward:User-Agent}" }],
      { requestHeaders: { "user-agent": "omp/19.2.1" }, fallbackHeaders: [{ name: "X-S", value: "fallback-ua" }] }
    );
    expect(out["X-S"]).toBe("omp/19.2.1");
  });

  it("only applies to User-Agent — other headers named node are forwarded", () => {
    const out = resolveCustomHeaders(
      [{ name: "X-S", value: "{forward:x-node}" }],
      { requestHeaders: { "x-node": "node" } }
    );
    expect(out["X-S"]).toBe("node");
  });
});
