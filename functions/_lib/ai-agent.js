import { listLibraryFiles, searchAgentLibraryFiles } from "./files.js";

export const UNRELATED_MESSAGE =
  "I can only help locate Urovo product documents and downloads.";

export const MAX_AI_SEARCHES = 8;
export const MAX_AI_MODEL_CALLS = 10;
const MAX_ARGUMENT_REPAIRS = 2;
const MAX_FINALIZER_REPAIRS = 1;

export class AiAgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AiAgentError";
    this.code = code;
  }
}

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_library",
    description:
      "Search the Urovo file library by product model, filename, document type, category, language, or description. Use concise keywords and try alternative model formatting when needed.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        match: { type: "string", enum: ["and", "or"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const FINISH_TOOL = {
  type: "function",
  function: {
    name: "finish",
    description:
      "Finish the task with a user-facing outcome and an ordered list of IDs returned by search_library.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["matched", "unrelated", "not_found", "needs_clarification"],
        },
        message: { type: "string", minLength: 1, maxLength: 500 },
        matches: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1 },
              relevance: { type: "number", minimum: 0, maximum: 100 },
              comment: { type: "string", minLength: 1, maxLength: 300 },
            },
            required: ["id", "relevance", "comment"],
            additionalProperties: false,
          },
        },
      },
      required: ["outcome", "message"],
      additionalProperties: false,
    },
  },
};

export const SYSTEM_PROMPT = `You are a narrow, high-precision retrieval agent for the Urovo product-document library.

SCOPE
- You only help users locate Urovo product files and materials, including specifications, brochures, presentations, manuals, user guides, SDKs, demos, drivers, APKs, firmware, pictures, videos, and related downloads.
- Never answer from general knowledge. Your final file recommendations must be grounded only in search_library results from this run.
- If the request is clearly unrelated to Urovo products or documents, immediately call finish with outcome "unrelated".
- If the request is related but lacks a usable product, model, or distinguishing detail, call finish with outcome "needs_clarification" and ask one short, specific question.

HOW THE LIBRARY SEARCH WORKS
- search_library searches these fields: file name, stable key, display path, description, product, category, document type, and language.
- The query is a short keyword string. With match "and", every whitespace-separated term must match somewhere in the record. With match "or", any term may match.
- Product identifiers are normalized for case and optional spaces, hyphens, and underscores. For example, K388Pro, K388 Pro, K388-Pro, and K388_Pro can resolve to the same model.
- Search results are authoritative. Their product, documentType, name, description, and id values reveal the library's actual naming.

DOCUMENT-INTENT MAPPING
Interpret the user's wording before searching. Use these mappings as search heuristics, while treating returned metadata as authoritative:
- 规格书, 参数表, specification, specifications, spec, spec sheet -> Specifications, PRODUCT SPEC SHEET
- 宣传册, brochure, leaflet -> Brochure
- 说明书, 用户手册, manual, user manual -> User Guide, User Manual
- 产品介绍, presentation, introduction -> Presentation, Product Introduction
- 软件开发包, 开发包 -> SDK
- 固件 -> Firmware
- 驱动 -> Driver
- 演示程序, 示例 -> Demo
- 应用, app, 安装包 -> APK
- 图片, 产品图 -> Pictures
- 视频 -> Video

RETRIEVAL STRATEGY
1. Extract the most likely product model and requested document or software type from the user message. Preserve the model's meaningful letters and digits.
2. For the first search, use the product model plus the single most likely canonical document-type term, with match "and" and limit 20. Example: query "K388Pro Specifications".
3. If the first search has no result or only weak results, search the product model alone. Inspect returned product, documentType, name, and description values to learn the real vocabulary available for that product.
4. Refine the next search using the exact vocabulary found in those results. Try a useful synonym only when the requested type and the library's type differ.
5. Use match "or" only for genuine ambiguity or a small synonym search. Do not begin with a broad OR query.
6. If the user requests multiple independent products or resource families, search each target separately. Do not combine mutually exclusive targets into one AND query.
7. You may perform at most 8 searches. Do not repeat an identical query. Do not make another search merely to improve wording. Stop as soon as the results provide enough evidence.
8. If reasonable refinements still produce no relevant result, call finish with outcome "not_found". Do not substitute a different product or document type.

FINISHING AND RANKING
- Call exactly one tool per response.
- Every id returned through finish must have appeared in a search_library result from this run. Never invent, reconstruct, or guess an id.
- Return at most 10 matches and remove duplicates.
- Rank exact product + exact requested document type first, then exact product + closely related type, then weaker alternatives. Use recency only as a tie-breaker, not as a substitute for relevance.
- Set relevance consistently from 0 to 100 and give each match one short comment tied to product and document type.
- Keep the final message concise and use the user's language.
- For outcomes other than matched, matches may be omitted or returned as an empty array.
- A matched outcome requires at least one valid searched id; otherwise use not_found or needs_clarification.`;

function parseArguments(text) {
  if (text && typeof text === "object" && !Array.isArray(text)) {
    return text;
  }

  if (typeof text !== "string") return null;

  try {
    const normalized = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function validateSearchItem(input, defaults = {}) {
  const source = typeof input === "string" ? { query: input } : input;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const query = typeof source.query === "string" ? source.query.trim() : "";
  if (!query || query.length > 200) return null;
  const matchSource = source.match ?? defaults.match;
  const match = typeof matchSource === "string"
    ? matchSource.trim().toLowerCase()
    : "or";
  if (!["and", "or"].includes(match)) return null;
  const limitSource = source.limit ?? defaults.limit;
  const parsedLimit = limitSource === undefined || limitSource === null
    ? 20
    : Number(limitSource);
  if (!Number.isFinite(parsedLimit)) return null;
  const limit = Math.min(20, Math.max(1, Math.trunc(parsedLimit)));
  return { query, match, limit };
}

function validateSearch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const compound = Array.isArray(input.searches)
    ? input.searches
    : Array.isArray(input.queries)
      ? input.queries
      : Array.isArray(input.query)
        ? input.query
        : null;
  const values = compound || [input];
  if (values.length === 0 || values.length > 8) return null;

  const searches = values.map((value) => validateSearchItem(value, input));
  return searches.every(Boolean) ? searches : null;
}

function validateFinish(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const nested = [input.result, input.output, input.data].find(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  const source = nested ? { ...nested, ...input } : input;
  const rawMatches =
    source.matches ?? source.results ?? source.files ?? source.items;
  const outcomeSource = source.outcome ?? source.status ?? source.resultType;
  const outcome = typeof outcomeSource === "string"
    ? outcomeSource.trim().toLowerCase()
    : "";
  if (![
    "matched",
    "unrelated",
    "not_found",
    "needs_clarification",
  ].includes(outcome)) return null;
  const messageSource =
    source.message ?? source.summary ?? source.response ?? source.text;
  const rawMessage = typeof messageSource === "string"
    ? messageSource.trim()
    : outcome === "matched" && rawMatches
      ? "Relevant files were found in the library."
      : outcome === "not_found"
        ? "No matching files were found in the current library."
        : outcome === "needs_clarification"
          ? "Please provide a more specific product model or document type."
          : outcome === "unrelated"
            ? UNRELATED_MESSAGE
            : "";
  if (!rawMessage) return null;
  const message = rawMessage.slice(0, 500);
  const sourceMatches = rawMatches === undefined || rawMatches === null
    ? []
    : Array.isArray(rawMatches)
      ? rawMatches
      : [rawMatches];
  const matches = [];
  for (const item of sourceMatches.slice(0, 10)) {
    const normalizedItem = typeof item === "string" ? { id: item } : item;
    if (!normalizedItem || typeof normalizedItem !== "object" || Array.isArray(normalizedItem)) continue;
    const rawId =
      normalizedItem.id ??
      normalizedItem.key ??
      normalizedItem.fileId ??
      normalizedItem.file_id;
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const rawComment =
      normalizedItem.comment ??
      normalizedItem.reason ??
      normalizedItem.explanation;
    const comment = typeof rawComment === "string"
      ? rawComment.trim().slice(0, 300)
      : "";
    const rawRelevance =
      normalizedItem.relevance ??
      normalizedItem.score ??
      normalizedItem.confidence ??
      80;
    let parsedRelevance = Number(rawRelevance);
    if (!id || !Number.isFinite(parsedRelevance)) continue;
    if (normalizedItem.relevance === undefined && parsedRelevance >= 0 && parsedRelevance <= 1) {
      parsedRelevance *= 100;
    }
    matches.push({
      id,
      relevance: Math.min(100, Math.max(0, parsedRelevance)),
      comment,
    });
  }
  if (outcome === "matched" && matches.length === 0) return null;
  return { outcome, message, matches: outcome === "matched" ? matches : [] };
}

function fallbackFinish(prompt, candidates) {
  const values = [...candidates.values()];

  if (values.length === 0) {
    return {
      outcome: "not_found",
      message: /[\u3400-\u9fff]/u.test(prompt)
        ? "当前资料库中没有找到符合要求的文件。"
        : "No matching files were found in the current library.",
      matches: [],
    };
  }

  const terms = [
    ...new Set(
      String(prompt || "")
        .toLowerCase()
        .match(/[a-z][a-z0-9._-]{1,}|\d{2,}/g) || [],
    ),
  ];
  const wantsDocuments = /文档|手册|说明书|manual|document|guide|instruction/i.test(
    prompt,
  );
  const rankedValues = values
    .map((file, index) => {
      const text = [
        file.name,
        file.description,
        file.product,
        file.documentType,
        ...(Array.isArray(file.labels) ? file.labels : []),
      ].join(" ").toLowerCase();
      let score = terms.reduce(
        (total, term) => total + (text.includes(term) ? 20 : 0),
        0,
      );

      if (wantsDocuments && /manual|document|guide|instruction|文档|手册|说明书/i.test(text)) {
        score += 15;
      }
      if (wantsDocuments && /not included|without (?:the )?(?:manual|document)/i.test(text)) {
        score -= 20;
      }

      return { file, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const relevantValues = rankedValues.filter(({ score }) => score > 0);
  const ranked = (relevantValues.length > 0 ? relevantValues : rankedValues)
    .slice(0, 10);

  return {
    outcome: "matched",
    message: /[\u3400-\u9fff]/u.test(prompt)
      ? "已根据本次资料库搜索结果整理出以下相关文件。"
      : "The following relevant files were recovered from this library search.",
    matches: ranked.map(({ file }, index) =>
      toAiPublicFile(file, {
        relevance: Math.max(55, 90 - index * 4),
        comment:
          String(file.description || "").trim().slice(0, 300) ||
          `Matched library file: ${file.name}`,
      }),
    ),
  };
}

function fallbackFromPrompt(prompt, files, candidates) {
  if (candidates.size === 0) {
    const terms = [
      ...new Set(
        String(prompt || "")
          .match(/[a-z][a-z0-9._-]{1,}|\d{2,}/gi) || [],
      ),
    ].slice(0, 8);

    for (const term of terms) {
      const result = searchAgentLibraryFiles(files, term, 20, "or");
      for (const file of result.files) {
        if (candidates.size >= 100) break;
        candidates.set(file.key, file);
      }
    }
  }

  return fallbackFinish(prompt, candidates);
}

function compactToolFile(file) {
  return {
    id: file.key,
    name: file.name,
    product: file.product || null,
    category: file.category || null,
    documentType: file.documentType || null,
    labels: Array.isArray(file.labels) ? file.labels : [],
    language: file.language || null,
    updatedAt: file.sourceUpdatedAt || file.uploaded || null,
    description: String(file.description || "").slice(0, 360),
  };
}

export function toAiPublicFile(file, match) {
  return {
    key: file.key,
    name: file.name,
    size: file.size ?? null,
    uploaded: file.uploaded || null,
    url: file.url,
    hasDescription: Boolean(file.hasDescription || file.description),
    description: file.description || "",
    source: file.source || "r2",
    ...(file.originType ? { originType: file.originType } : {}),
    external: Boolean(file.external),
    displayPath: file.displayPath || file.key,
    product: file.product || null,
    category: file.category || null,
    documentType: file.documentType || null,
    labels: Array.isArray(file.labels) ? file.labels : [],
    language: file.language || null,
    sourcePageUrl: file.sourcePageUrl || null,
    sourceUpdatedAt: file.sourceUpdatedAt || null,
    relevance: match.relevance,
    comment:
      match.comment ||
      String(file.description || "").trim().slice(0, 300) ||
      `Matched library file: ${file.name}`,
  };
}

function resolveFinish(finish, candidates) {
  if (finish.outcome === "unrelated") {
    return { outcome: "unrelated", message: UNRELATED_MESSAGE, matches: [] };
  }

  const seen = new Set();
  const authoritative = [];
  for (const match of finish.matches) {
    const file = candidates.get(match.id);
    if (!file || seen.has(match.id)) continue;
    seen.add(match.id);
    authoritative.push(toAiPublicFile(file, match));
  }

  if (finish.outcome === "matched" && authoritative.length === 0) {
    return {
      outcome: "not_found",
      message: "No matching files were found in the current library.",
      matches: [],
    };
  }

  return {
    outcome: finish.outcome,
    message: finish.message,
    matches: finish.outcome === "matched" ? authoritative.slice(0, 10) : [],
  };
}

async function callProvider({ baseUrl, model, apiKey, messages, tools, toolChoice, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model,
    messages,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: false,
    temperature: 0,
  };

  try {
    if (new URL(baseUrl).hostname.toLowerCase().endsWith("deepseek.com")) {
      body.thinking = { type: "disabled" };
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new AiAgentError("provider", "The AI provider request failed.");
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    if (!message || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      throw new AiAgentError("incompatible", "The configured model did not return a tool call.");
    }
    return message;
  } catch (error) {
    if (error instanceof AiAgentError) throw error;
    if (error?.name === "AbortError") {
      throw new AiAgentError("timeout", "The AI provider timed out.");
    }
    throw new AiAgentError("provider", "The AI provider request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAiAgent({ prompt, files, settings, apiKey, fetchImpl = fetch }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  const candidates = new Map();
  let searchCount = 0;
  let invalidSearchCount = 0;
  let invalidFinishCount = 0;

  for (let modelCall = 0; modelCall < MAX_AI_MODEL_CALLS - 1; modelCall += 1) {
    const finishOnly =
      searchCount >= MAX_AI_SEARCHES ||
      modelCall === MAX_AI_MODEL_CALLS - 2;
    const tools = finishOnly ? [FINISH_TOOL] : [SEARCH_TOOL, FINISH_TOOL];
    const toolChoice = finishOnly
      ? { type: "function", function: { name: "finish" } }
      : "required";
    let assistant;

    try {
      assistant = await callProvider({
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey,
        messages,
        tools,
        toolChoice,
        fetchImpl,
      });
    } catch (error) {
      if (error instanceof AiAgentError && error.code === "incompatible") {
        return fallbackFromPrompt(prompt, files, candidates);
      }
      throw error;
    }
    const calls = assistant.tool_calls;
    const names = new Set(calls.map((call) => call?.function?.name));

    if (names.has("finish") && (names.size > 1 || calls.length > 1)) {
      return fallbackFromPrompt(prompt, files, candidates);
    }
    if ([...names].some((name) => !["search_library", "finish"].includes(name))) {
      return fallbackFromPrompt(prompt, files, candidates);
    }
    if (calls.length > 1 && names.size !== 1) {
      return fallbackFromPrompt(prompt, files, candidates);
    }

    messages.push({
      role: "assistant",
      content: typeof assistant.content === "string" ? assistant.content : null,
      tool_calls: calls,
    });

    if (names.has("finish")) {
      const call = calls[0];
      const rawFinish = parseArguments(call.function.arguments);
      const finish = validateFinish(rawFinish);
      if (!finish) {
        invalidFinishCount += 1;
        if (
          invalidFinishCount > MAX_ARGUMENT_REPAIRS ||
          modelCall === MAX_AI_MODEL_CALLS - 2
        ) {
          return fallbackFromPrompt(prompt, files, candidates);
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            error: "Invalid finish arguments. Provide outcome and message. A matched outcome needs at least one match with id, numeric relevance, and comment. For unrelated, not_found, or needs_clarification, omit matches or use matches: []. Call finish again.",
          }),
        });
        continue;
      }

      return resolveFinish(finish, candidates);
    }

    if (finishOnly) {
      for (const call of calls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            error: `The search phase is complete after ${searchCount} searches. Preserve the candidates already returned and call finish now; do not call search_library again.`,
          }),
        });
      }
      continue;
    }

    const parsed = calls.map((call) => ({
      call,
      inputs: validateSearch(parseArguments(call.function.arguments)),
    }));
    if (parsed.some(({ inputs }) => !inputs)) {
      invalidSearchCount += 1;
      if (
        invalidSearchCount > MAX_ARGUMENT_REPAIRS ||
        modelCall === MAX_AI_MODEL_CALLS - 2
      ) {
        return fallbackFromPrompt(prompt, files, candidates);
      }
      for (const { call } of parsed) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            error: "Invalid search_library arguments. Provide a non-empty string query, optional match as and/or, and optional numeric limit from 1 to 20. Call one tool again.",
          }),
        });
      }
      continue;
    }

    for (const { call, inputs } of parsed) {
      const results = [];

      for (const input of inputs) {
        if (searchCount >= MAX_AI_SEARCHES) break;
        searchCount += 1;
        const result = searchAgentLibraryFiles(
          files,
          input.query,
          input.limit,
          input.match,
        );
        for (const file of result.files) {
          if (candidates.size < 100 || candidates.has(file.key)) {
            candidates.set(file.key, file);
          }
        }
        results.push({
          query: result.query,
          match: result.match,
          count: result.count,
          results: result.files.map(compactToolFile),
        });
      }

      const content = results.length === 0
        ? {
            error: `The ${MAX_AI_SEARCHES}-search limit has been reached. Do not search again; call finish using the results already returned in this run.`,
          }
        : results.length === 1
          ? results[0]
          : { searches: results };

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(content),
      });
    }
  }

  const finalizerMessages = [
      {
        role: "system",
        content: `You are the finalization stage of a Urovo library retrieval agent. The search phase is over. Call finish exactly once and do not request another search. Use only candidate IDs supplied below. Rank up to 10 files that directly satisfy the original request and give each a short comment in the user's language. If no candidate directly satisfies it, finish with not_found or needs_clarification and omit matches or use an empty array.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          originalRequest: prompt,
          candidates: [...candidates.values()].slice(0, 50).map(compactToolFile),
        }),
      },
    ];

  for (let repair = 0; repair <= MAX_FINALIZER_REPAIRS; repair += 1) {
    let finalizer;

    try {
      finalizer = await callProvider({
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey,
        messages: finalizerMessages,
        tools: [FINISH_TOOL],
        toolChoice: { type: "function", function: { name: "finish" } },
        fetchImpl,
      });
    } catch (error) {
      if (error instanceof AiAgentError && error.code === "incompatible") break;
      throw error;
    }
    const finalCalls = finalizer.tool_calls.filter(
      (call) => call?.function?.name === "finish",
    );
    const call = finalCalls.length === 1 ? finalCalls[0] : null;
    const finish = call
      ? validateFinish(parseArguments(call.function.arguments))
      : null;

    if (finish) return resolveFinish(finish, candidates);
    if (repair >= MAX_FINALIZER_REPAIRS || !call) break;

    finalizerMessages.push({
      role: "assistant",
      content: typeof finalizer.content === "string" ? finalizer.content : null,
      tool_calls: finalizer.tool_calls,
    });
    finalizerMessages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify({
        error: "Invalid finish arguments. Call finish again with outcome, message, and for matched results a non-empty matches array using candidate id values.",
      }),
    });
  }

  return fallbackFromPrompt(prompt, files, candidates);
}

export async function searchLibraryWithPrompt({
  prompt,
  bucket,
  settings,
  apiKey,
  fetchImpl = fetch,
  loadLibrary = () => listLibraryFiles(bucket),
}) {
  const files = await loadLibrary();
  const result = await runAiAgent({
    prompt,
    files,
    settings,
    apiKey,
    fetchImpl,
  });

  if (result.outcome !== "matched") {
    return result;
  }

  const latestFiles = await loadLibrary();
  const byId = new Map(latestFiles.map((file) => [file.key, file]));
  result.matches = result.matches
    .map((match) => {
      const authoritative = byId.get(match.key);
      return authoritative ? toAiPublicFile(authoritative, match) : null;
    })
    .filter(Boolean)
    .slice(0, 10);

  if (result.matches.length === 0) {
    return {
      outcome: "not_found",
      message: "No matching files were found in the current library.",
      matches: [],
    };
  }

  return result;
}
