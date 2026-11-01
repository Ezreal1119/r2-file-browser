import assert from "node:assert/strict";
import test from "node:test";
import {
  runAiAgent,
  UNRELATED_MESSAGE,
} from "../functions/_lib/ai-agent.js";

const files = [
  {
    key: "urovo-en/388/specs/k388-pro.pdf",
    name: "K388 Pro Specifications.pdf",
    size: 2048,
    uploaded: "2026-08-20T00:00:00.000Z",
    url: "https://downloads.example.com/K388-Pro-Specifications.pdf",
    description: "Product: K388 Pro; Type: Specifications.",
    hasDescription: true,
    source: "urovo-en",
    external: true,
    displayPath: "K388 Pro / Specifications / K388 Pro Specifications.pdf",
    product: "K388 Pro",
    category: "Mobile Computers",
    documentType: "Specifications",
    language: "English",
  },
];

const settings = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
};

function toolResponse(name, args, id = crypto.randomUUID()) {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function multiToolResponse(calls) {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map(({ name, args, id = crypto.randomUUID() }) => ({
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })),
      },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("agent searches once and returns only an authoritative matched file", async () => {
  const bodies = [];
  const responses = [
    toolResponse("search_library", { query: "K388Pro specifications", match: "and", limit: 20 }, "search-1"),
    toolResponse("finish", {
      outcome: "matched",
      message: "Found the specification sheet.",
      matches: [
        { id: files[0].key, relevance: 99, comment: "Exact product and document type." },
        { id: "invented/id.pdf", relevance: 100, comment: "Invented." },
      ],
    }, "finish-1"),
  ];
  const result = await runAiAgent({
    prompt: "我要K388Pro的规格书",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return responses.shift();
    },
  });

  assert.equal(result.outcome, "matched");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].key, files[0].key);
  assert.equal(result.matches[0].url, files[0].url);
  assert.equal(result.matches[0].comment, "Exact product and document type.");
  assert.match(bodies[0].messages[0].content, /RETRIEVAL STRATEGY/);
  assert.deepEqual(bodies[0].messages[1], {
    role: "user",
    content: "我要K388Pro的规格书",
  });
  assert.deepEqual(bodies[0].tools.map((tool) => tool.function.name), ["search_library", "finish"]);
  assert.equal(bodies[0].tool_choice, "required");
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.equal(JSON.stringify(bodies[1]).includes(files[0].url), false);
});

test("agent returns a fixed refusal for unrelated requests", async () => {
  const result = await runAiAgent({
    prompt: "Write me a poem",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => toolResponse("finish", {
      outcome: "unrelated",
      message: "A model-controlled refusal that must not be shown.",
      matches: [],
    }),
  });

  assert.equal(result.outcome, "unrelated");
  assert.equal(result.message, UNRELATED_MESSAGE);
});

test("agent accepts clarification outcomes without a matches array", async () => {
  const result = await runAiAgent({
    prompt: "PC tool",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => toolResponse("finish", {
      outcome: "needs_clarification",
      message: "Which product model or PC tool do you need?",
    }),
  });

  assert.deepEqual(result, {
    outcome: "needs_clarification",
    message: "Which product model or PC tool do you need?",
    matches: [],
  });
});

test("agent safely normalizes common matched argument variations", async () => {
  const responses = [
    toolResponse("search_library", {
      query: "K388Pro specifications",
      match: "AND",
      limit: "20",
      harmlessExtraField: true,
    }, "search-normalized"),
    toolResponse("finish", {
      outcome: "MATCHED",
      message: "Found it.",
      matches: {
        key: files[0].key,
        score: "0.98",
        explanation: "Exact product specification.",
        harmlessExtraField: true,
      },
    }, "finish-normalized"),
  ];
  const result = await runAiAgent({
    prompt: "K388Pro spec",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.outcome, "matched");
  assert.equal(result.matches[0].relevance, 98);
  assert.equal(result.matches[0].comment, "Exact product specification.");
});

test("agent normalizes wrapped final results and string file IDs", async () => {
  const responses = [
    toolResponse("search_library", {
      query: "K388Pro specifications",
      match: "and",
    }),
    toolResponse("finish", {
      output: {
        status: "matched",
        response: "Found it.",
        files: [files[0].key],
      },
    }),
  ];
  const result = await runAiAgent({
    prompt: "K388Pro spec",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.outcome, "matched");
  assert.equal(result.matches[0].key, files[0].key);
});

test("agent accepts compound search queries in one tool call", async () => {
  const responses = [
    toolResponse("search_library", {
      query: ["K388Pro specifications", "PDA SDK"],
      match: "and",
      limit: 20,
    }, "compound-search"),
    toolResponse("finish", {
      outcome: "matched",
      message: "F".repeat(600),
      matches: [{ id: files[0].key, relevance: 99 }],
    }, "compound-finish"),
  ];
  const bodies = [];
  const result = await runAiAgent({
    prompt: "Send both resources",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return responses.shift();
    },
  });

  assert.equal(result.outcome, "matched");
  assert.equal(result.message.length, 500);
  assert.equal(result.matches[0].key, files[0].key);
  assert.match(result.matches[0].comment, /Product: K388 Pro/);
  const toolMessage = bodies[1].messages.find(
    (message) => message.role === "tool",
  );
  assert.equal(JSON.parse(toolMessage.content).searches.length, 2);
});

test("agent forces finish after eight valid searches", async () => {
  const bodies = [];
  let calls = 0;
  const result = await runAiAgent({
    prompt: "Find an unknown Urovo document",
    files,
    settings: { baseUrl: "https://api.example.com/v1", model: "model" },
    apiKey: "secret",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      calls += 1;
      if (calls <= 8) {
        return toolResponse("search_library", { query: `missing-${calls}`, limit: 1 });
      }
      return toolResponse("finish", {
        outcome: "not_found",
        message: "No matching file was found.",
        matches: [],
      });
    },
  });

  assert.equal(result.outcome, "not_found");
  assert.deepEqual(bodies[8].tool_choice, {
    type: "function",
    function: { name: "finish" },
  });
  assert.deepEqual(bodies[8].tools.map((tool) => tool.function.name), ["finish"]);
  assert.equal("thinking" in bodies[0], false);
});

test("agent keeps remaining search capacity when one turn exceeds the limit", async () => {
  const bodies = [];
  const batchedSearches = Array.from({ length: 9 }, (_, index) => ({
    name: "search_library",
    args: {
      query: index === 0 ? "K388Pro specifications" : `unused-${index}`,
      match: "and",
      limit: 20,
    },
    id: `batched-${index}`,
  }));
  const responses = [
    multiToolResponse(batchedSearches),
    toolResponse("search_library", {
      query: "one-more-search",
      match: "and",
      limit: 20,
    }, "search-after-limit"),
    toolResponse("finish", {
      outcome: "matched",
      message: "Found the specification sheet.",
      matches: [{
        id: files[0].key,
        relevance: 99,
        comment: "Exact product specification.",
      }],
    }, "finish-after-limit"),
  ];
  const result = await runAiAgent({
    prompt: "K388Pro spec",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return responses.shift();
    },
  });

  assert.equal(result.outcome, "matched");
  assert.equal(result.matches[0].key, files[0].key);
  assert.deepEqual(bodies[1].tools.map((tool) => tool.function.name), ["finish"]);
  assert.deepEqual(bodies[2].tools.map((tool) => tool.function.name), ["finish"]);
  assert.match(
    JSON.stringify(bodies[2].messages),
    /search phase is complete after 8 searches/,
  );
});

test("agent uses a fresh finalizer when the main loop does not finish", async () => {
  const bodies = [];
  const responses = [];
  for (let index = 0; index < 8; index += 1) {
    responses.push(toolResponse("search_library", {
      query: index === 0 ? "K388Pro specifications" : `missing-${index}`,
      match: "and",
      limit: 20,
    }, `search-${index}`));
  }
  responses.push(toolResponse("search_library", {
    query: "search-after-finish-only",
    match: "and",
    limit: 20,
  }, "stuck-search"));
  responses.push(toolResponse("finish", {
    outcome: "matched",
    message: "Found the specification sheet.",
    matches: [{
      id: files[0].key,
      relevance: 97,
      comment: "Exact product specification.",
    }],
  }, "fresh-finalizer"));

  const result = await runAiAgent({
    prompt: "K388Pro spec",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return responses.shift();
    },
  });

  assert.equal(result.outcome, "matched");
  assert.equal(bodies.length, 10);
  assert.equal(bodies[9].messages.length, 2);
  assert.deepEqual(bodies[9].tools.map((tool) => tool.function.name), ["finish"]);
  assert.match(bodies[9].messages[0].content, /finalization stage/);
});

test("fresh finalizer repairs one invalid finish without changing the normal path", async () => {
  const responses = [];
  for (let index = 0; index < 8; index += 1) {
    responses.push(toolResponse("search_library", {
      query: index === 0 ? "K388Pro specifications" : `missing-${index}`,
      match: "and",
    }, `repair-search-${index}`));
  }
  responses.push(toolResponse("search_library", {
    query: "stuck-search",
  }, "repair-stuck"));
  responses.push(toolResponse("finish", {
    outcome: "matched",
    message: "Found it.",
    matches: [],
  }, "repair-invalid-finish"));
  responses.push(toolResponse("finish", {
    outcome: "matched",
    message: "Found it after correction.",
    matches: [files[0].key],
  }, "repair-valid-finish"));
  let calls = 0;

  const result = await runAiAgent({
    prompt: "K388Pro spec",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => {
      calls += 1;
      return responses.shift();
    },
  });

  assert.equal(calls, 11);
  assert.equal(result.outcome, "matched");
  assert.equal(result.matches[0].key, files[0].key);
});

test("fresh finalizer falls back to authoritative candidates after repeated invalid output", async () => {
  const responses = [];
  for (let index = 0; index < 8; index += 1) {
    responses.push(toolResponse("search_library", {
      query: index === 0 ? "K388Pro specifications" : `missing-${index}`,
      match: "and",
    }, `fallback-search-${index}`));
  }
  responses.push(toolResponse("search_library", {
    query: "stuck-search",
  }, "fallback-stuck"));
  responses.push(toolResponse("finish", {
    outcome: "matched",
    message: "Missing matches.",
    matches: [],
  }, "fallback-invalid-1"));
  responses.push(toolResponse("finish", {
    outcome: "matched",
    message: "Still missing matches.",
    matches: [],
  }, "fallback-invalid-2"));

  const result = await runAiAgent({
    prompt: "我要K388Pro的规格书",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.outcome, "matched");
  assert.equal(result.matches[0].key, files[0].key);
  assert.match(result.message, /资料库搜索结果/);
});

test("agent allows two invalid argument repairs and then falls back locally", async () => {
  let calls = 0;
  const result = await runAiAgent({
    prompt: "Find K388",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => {
      calls += 1;
      return toolResponse("search_library", { query: "", extra: true });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.outcome, "matched");
  assert.equal(result.matches[0].key, files[0].key);
});

test("agent falls back locally when the model omits tool calls", async () => {
  const result = await runAiAgent({
    prompt: "Find K388Pro specifications",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Plain text" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  assert.equal(result.outcome, "matched");
  assert.equal(result.matches[0].key, files[0].key);
});

test("agent keeps search and finish argument repair budgets separate", async () => {
  const responses = [
    toolResponse("search_library", { query: "" }, "bad-search"),
    toolResponse("search_library", {
      query: "K388Pro specifications",
      match: "and",
    }, "good-search"),
    toolResponse("finish", {
      outcome: "matched",
      message: "Found it.",
      matches: [],
    }, "bad-finish"),
    toolResponse("finish", {
      outcome: "matched",
      message: "Found it.",
      matches: [{ id: files[0].key, relevance: 99 }],
    }, "good-finish"),
  ];
  const result = await runAiAgent({
    prompt: "K388Pro spec",
    files,
    settings,
    apiKey: "secret",
    fetchImpl: async () => responses.shift(),
  });

  assert.equal(result.outcome, "matched");
  assert.equal(result.matches[0].key, files[0].key);
});
