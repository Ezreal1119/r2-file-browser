import assert from "node:assert/strict";
import test from "node:test";
import {
  getVisitor,
  verifyTurnstile,
} from "../functions/_lib/ai-security.js";

test("visitor cookie is signed and a tampered cookie is replaced", async () => {
  const first = await getVisitor(
    new Request("https://tool-files.patrick-shenzhen.org/"),
    "session-secret",
    1_800_000_000_000,
  );
  const cookieValue = first.setCookie.split(";")[0];
  const second = await getVisitor(
    new Request("https://tool-files.patrick-shenzhen.org/", {
      headers: { Cookie: cookieValue },
    }),
    "session-secret",
    1_800_000_001_000,
  );
  const tampered = await getVisitor(
    new Request("https://tool-files.patrick-shenzhen.org/", {
      headers: { Cookie: `${cookieValue}x` },
    }),
    "session-secret",
    1_800_000_001_000,
  );

  assert.equal(second.id, first.id);
  assert.equal(second.setCookie, null);
  assert.notEqual(tampered.id, first.id);
  assert.match(tampered.setCookie, /HttpOnly; Secure; SameSite=Lax/);
});

test("Turnstile validation requires the expected hostname and action", async () => {
  const originalFetch = globalThis.fetch;
  const request = new Request(
    "https://tool-files.patrick-shenzhen.org/api/ai-search",
    { headers: { "CF-Connecting-IP": "203.0.113.1" } },
  );

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: "tool-files.patrick-shenzhen.org",
      action: "ai_search",
    }));
    assert.equal(await verifyTurnstile({ request, token: "token", secret: "secret" }), true);

    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: "attacker.example",
      action: "ai_search",
    }));
    assert.equal(await verifyTurnstile({ request, token: "token", secret: "secret" }), false);

    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: "tool-files.patrick-shenzhen.org",
      action: "other_action",
    }));
    assert.equal(await verifyTurnstile({ request, token: "token", secret: "secret" }), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
