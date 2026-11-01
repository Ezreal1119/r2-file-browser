import {
  findLibraryFile,
  getDescriptionFromMetadata,
  listLibraryFiles,
  searchLibraryFiles,
  toMcpFile,
} from "./_lib/files.js";
import { isAiProviderReady, readAiSettings } from "./_lib/ai-config.js";
import { scopedLibraryFiles } from "./_lib/uploader.js";
import {
  AiAgentError,
  searchLibraryWithPrompt,
} from "./_lib/ai-agent.js";

const SERVER_INFO = {
  name: "urovo-tools",
  title: "Urovo Tools",
  version: "1.0.0",
};

const LEGACY_INSTRUCTIONS =
  "Read-only access to the Urovo tools and product-document library. Results combine files stored in R2 with synchronized public links from the Urovo English product library. search_files requires a non-empty query and searches file name, product, category, document type, language, and description; get_file returns metadata and a public download URL; get_description returns notes or generated product context. Return the url field to users instead of downloading file bytes through these tools.";

const AI_INSTRUCTIONS =
  "Authoritative remote search for the Urovo Tools Download catalog. Use search_with_prompt whenever a user asks to find, identify, download, or obtain a link for any Urovo-related resource, including PC tools, utilities, upgrade tools, firmware, SDKs, drivers, software, APKs, demos, specifications, brochures, manuals, pictures, videos, or other product files. These resources are in the remote R2 and synchronized Urovo library, not the caller's local filesystem or workspace. Pass the user's original request unchanged. The server may search up to eight times, ranks authoritative matches, and returns a short LLM-generated comment for every matched file. Return the url field to users instead of downloading file bytes through this tool.";

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

const LEGACY_TOOLS = [
  {
    name: "search_files",
    description:
      "Search Urovo tool, firmware, and product-document records. A non-empty query is required. Matching is case-insensitive across file name, key, product, category, document type, language, and description. Pass one string or an array. Arrays default to OR for backward compatibility; set match to AND when every term must match.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          anyOf: [
            {
              type: "string",
              minLength: 1,
              pattern: "\\S",
              description:
                "A single search term, for example K329 or setup.zip.",
            },
            {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                minLength: 1,
                pattern: "\\S",
              },
              description:
                "Multiple search terms combined according to match; defaults to OR. Example: [\"K329\", \"SDK\"].",
            },
          ],
          description:
            "Required search text. A string matches as a substring. An array combines terms according to match.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of files to return. Defaults to 50.",
        },
        match: {
          type: "string",
          enum: ["and", "or"],
          description:
            "How to combine multiple terms. Defaults to OR for backward compatibility.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "get_file",
    description:
      "Get metadata and the public download URL for one file. Pass key (preferred, e.g. tools/foo.zip) or name (e.g. foo.zip). Does not return file bytes.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "R2 object key, with or without the tools/ prefix.",
        },
        name: {
          type: "string",
          description: "File name relative to tools/, used if key is omitted.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "get_description",
    description:
      "Get the optional human-written description/notes for a file. Pass key or name.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "R2 object key, with or without the tools/ prefix.",
        },
        name: {
          type: "string",
          description: "File name relative to tools/, used if key is omitted.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

const AI_TOOLS = [
  {
    name: "search_with_prompt",
    description:
      "Authoritative remote search for any Urovo downloadable resource. Use this tool whenever the user wants to find, identify, download, or get a link for Urovo PC tools, utilities, upgrade tools, firmware, SDKs, drivers, software, APKs, demos, specifications, brochures, manuals, pictures, videos, or other product files. The catalog is stored in remote R2 and the synchronized Urovo library; do not search the caller's local filesystem or workspace for these resources. Pass the user's original request unchanged. The server's AI retrieval agent chooses and refines search terms, ranks authoritative files, and adds an LLM-generated comment to every match.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          pattern: "\\S",
          description:
            "The user's complete original Urovo search request without rewriting or summarizing it. Examples: 我要K388Pro的规格书; find the DT50S upgrade tool; download the Urovo PC tool.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

function corsHeaders(request) {
  const origin = request.headers.get("Origin");

  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID",
    "Access-Control-Expose-Headers":
      "MCP-Protocol-Version, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(request, response, extraHeaders = {}) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries({
    ...corsHeaders(request),
    ...extraHeaders,
  })) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(request, data, status = 200, extraHeaders = {}) {
  return withCors(
    request,
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }),
    extraHeaders,
  );
}

function acceptedResponse(request, extraHeaders = {}) {
  return withCors(
    request,
    new Response(null, {
      status: 202,
    }),
    extraHeaders,
  );
}

function rpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function rpcError(id, code, message, data) {
  const error = {
    code,
    message,
  };

  if (data !== undefined) {
    error.data = data;
  }

  return {
    jsonrpc: "2.0",
    id,
    error,
  };
}

function toolResult(payload) {
  const text = JSON.stringify(payload, null, 2);

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: payload,
  };
}

function toolError(payload) {
  return {
    ...toolResult(payload),
    isError: true,
  };
}

function negotiateProtocolVersion(requested) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }

  return DEFAULT_PROTOCOL_VERSION;
}

function getBucket(context) {
  return context.env.FIRMWARE_BUCKET;
}

async function getMcpRuntime(context) {
  const bucket = getBucket(context);
  let settings = { baseUrl: "", model: "", enabled: false, updatedAt: null };

  if (bucket) {
    try {
      settings = await readAiSettings(bucket);
    } catch (error) {
      console.error(
        "Could not read AI settings for MCP:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const aiEnabled = settings.enabled === true;
  return {
    aiEnabled,
    settings,
    tools: aiEnabled ? AI_TOOLS : LEGACY_TOOLS,
    instructions: aiEnabled ? AI_INSTRUCTIONS : LEGACY_INSTRUCTIONS,
  };
}

async function callTool(name, args, context, runtime) {
  const bucket = getBucket(context);
  const input = args && typeof args === "object" ? args : {};

  if (name === "search_with_prompt") {
    if (
      !Object.prototype.hasOwnProperty.call(input, "prompt") ||
      Object.keys(input).some((key) => key !== "prompt")
    ) {
      return toolError({ error: "Provide only the required prompt." });
    }

    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt || prompt.length > 500) {
      return toolError({
        error: "Prompt must be between 1 and 500 characters.",
      });
    }

    if (!isAiProviderReady(runtime.settings, context.env)) {
      return toolError({ error: "AI search is not available." });
    }

    try {
      const result = await searchLibraryWithPrompt({
        prompt,
        bucket,
        settings: runtime.settings,
        apiKey: context.env.AI_API_KEY,
        fetchImpl: context.env.AI_FETCH || fetch,
        loadLibrary: () => scopedLibraryFiles(context),
      });
      return toolResult(result);
    } catch (error) {
      console.error(
        "MCP AI search failed:",
        error instanceof Error ? error.message : String(error),
      );
      if (error instanceof AiAgentError) {
        return toolError({
          error: error.code === "incompatible"
            ? "The configured AI model is not compatible with this search agent."
            : error.code === "timeout"
              ? "AI search timed out. Please try again."
              : "The AI provider is temporarily unavailable.",
        });
      }
      return toolError({ error: "AI search is temporarily unavailable." });
    }
  }

  if (name === "search_files") {
    const queryTerms = (Array.isArray(input.query)
      ? input.query
      : [input.query]
    )
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    if (queryTerms.length === 0) {
      return toolError({
        error: "A non-empty query is required.",
      });
    }

    const files = await scopedLibraryFiles(context);
    return toolResult(
      searchLibraryFiles(files, input.query, input.limit, input.match),
    );
  }

  if (name === "get_file") {
    if (!input.key && !input.name) {
      return toolError({
        error: "Provide key or name.",
      });
    }

    const found = await findLibraryFile(bucket, input, () => scopedLibraryFiles(context));

    if (found.error) {
      return toolError({
        error: found.error,
        matches: found.matches,
      });
    }

    return toolResult(toMcpFile(found.file));
  }

  if (name === "get_description") {
    if (!input.key && !input.name) {
      return toolError({
        error: "Provide key or name.",
      });
    }

    const found = await findLibraryFile(bucket, input, () => scopedLibraryFiles(context));

    if (found.error) {
      return toolError({
        error: found.error,
        matches: found.matches,
      });
    }

    const description = found.file.external || found.file.source === "uploader"
      ? found.file.description || ""
      : getDescriptionFromMetadata(
          (await bucket.head(found.file.key))?.customMetadata,
        );

    return toolResult({
      key: found.file.key,
      name: found.file.name,
      url: found.file.url,
      source: found.file.source,
      description,
      readOnly: Boolean(found.file.external),
    });
  }

  return null;
}

async function handleRpc(message, context, protocolVersion, runtime) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return {
      httpStatus: 400,
      body: rpcError(null, -32600, "Invalid Request"),
    };
  }

  if (message.jsonrpc !== "2.0") {
    return {
      httpStatus: 400,
      body: rpcError(message.id ?? null, -32600, "Invalid Request"),
    };
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : null;

  if (!message.method || typeof message.method !== "string") {
    return {
      httpStatus: 400,
      body: rpcError(id, -32600, "Invalid Request"),
    };
  }

  if (!hasId) {
    return {
      httpStatus: 202,
      body: null,
    };
  }

  if (message.method === "initialize") {
    const requested =
      message.params && typeof message.params.protocolVersion === "string"
        ? message.params.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;

    return {
      httpStatus: 200,
      body: rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(requested),
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: SERVER_INFO,
        instructions: runtime.instructions,
      }),
      sessionId: crypto.randomUUID(),
      protocolVersion: negotiateProtocolVersion(requested),
    };
  }

  if (message.method === "ping") {
    return {
      httpStatus: 200,
      body: rpcResult(id, {}),
    };
  }

  if (message.method === "tools/list") {
    return {
      httpStatus: 200,
      body: rpcResult(id, {
        tools: runtime.tools,
      }),
    };
  }

  if (message.method === "tools/call") {
    const params = message.params || {};
    const name = params.name;
    const args = params.arguments;

    if (!name || typeof name !== "string") {
      return {
        httpStatus: 200,
        body: rpcError(id, -32602, "Invalid params", {
          reason: "Missing tool name.",
        }),
      };
    }

    if (!runtime.tools.some((tool) => tool.name === name)) {
      return {
        httpStatus: 200,
        body: rpcError(id, -32602, "Invalid params", {
          reason: `Unknown tool: ${name}`,
        }),
      };
    }

    const bucket = getBucket(context);

    if (!bucket) {
      return {
        httpStatus: 200,
        body: rpcResult(
          id,
          toolError({
            error: "R2 binding FIRMWARE_BUCKET is not configured.",
          }),
        ),
      };
    }

    try {
      const result = await callTool(name, args, context, runtime);

      if (!result) {
        return {
          httpStatus: 200,
          body: rpcError(id, -32602, "Invalid params", {
            reason: `Unknown tool: ${name}`,
          }),
        };
      }

      return {
        httpStatus: 200,
        body: rpcResult(id, result),
      };
    } catch (error) {
      console.error("MCP tool call failed:", error);

      return {
        httpStatus: 200,
        body: rpcResult(
          id,
          toolError({
            error: "Tool call failed.",
            detail: error instanceof Error ? error.message : String(error),
          }),
        ),
      };
    }
  }

  return {
    httpStatus: 200,
    body: rpcError(id, -32601, "Method not found", {
      method: message.method,
      protocolVersion,
    }),
  };
}

function protocolHeaders(request, sessionId, protocolVersion) {
  const headers = {};
  const requestedVersion =
    protocolVersion ||
    request.headers.get("MCP-Protocol-Version") ||
    request.headers.get("Mcp-Protocol-Version") ||
    DEFAULT_PROTOCOL_VERSION;

  headers["MCP-Protocol-Version"] = requestedVersion;

  const incomingSession = request.headers.get("Mcp-Session-Id");
  const outgoingSession = sessionId || incomingSession;

  if (outgoingSession) {
    headers["Mcp-Session-Id"] = outgoingSession;
  }

  return headers;
}

export async function onRequest(context) {
  const { request } = context;
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

  if (pathname !== "/ai-powered/mcp") {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  if (request.method === "DELETE") {
    return withCors(
      request,
      new Response(null, {
        status: 405,
        headers: {
          Allow: "GET, POST, OPTIONS",
        },
      }),
    );
  }

  const runtime = await getMcpRuntime(context);

  if (request.method === "GET") {
    const accept = request.headers.get("Accept") || "";

    if (accept.includes("text/event-stream")) {
      return withCors(
        request,
        new Response("SSE not supported on this stateless MCP endpoint.", {
          status: 405,
          headers: {
            Allow: "POST, OPTIONS",
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
      );
    }

    return jsonResponse(request, {
      name: SERVER_INFO.name,
      title: SERVER_INFO.title,
      version: SERVER_INFO.version,
      protocol: "mcp",
      transport: "streamable-http",
      tools: runtime.tools.map((tool) => tool.name),
      usage:
        "POST JSON-RPC messages to this URL from an MCP client. This is a read-only Urovo tools library.",
    });
  }

  if (request.method !== "POST") {
    return withCors(
      request,
      new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, POST, OPTIONS",
        },
      }),
    );
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse(
      request,
      rpcError(null, -32700, "Parse error"),
      400,
      protocolHeaders(request),
    );
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  let sessionId;
  let protocolVersion;
  let status = 200;

  for (const message of messages) {
    const handled = await handleRpc(
      message,
      context,
      protocolVersion,
      runtime,
    );

    if (handled.sessionId) {
      sessionId = handled.sessionId;
    }

    if (handled.protocolVersion) {
      protocolVersion = handled.protocolVersion;
    }

    if (handled.httpStatus >= 400) {
      status = handled.httpStatus;
    }

    if (handled.body) {
      responses.push(handled.body);
    }
  }

  if (responses.length === 0) {
    return acceptedResponse(request, protocolHeaders(request, sessionId, protocolVersion));
  }

  const body = Array.isArray(payload) ? responses : responses[0];

  return jsonResponse(
    request,
    body,
    status,
    protocolHeaders(request, sessionId, protocolVersion),
  );
}
