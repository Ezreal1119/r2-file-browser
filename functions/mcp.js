import {
  findToolFile,
  getDescriptionFromMetadata,
  listToolFiles,
  searchToolFiles,
  toMcpFile,
} from "./_lib/files.js";

const SERVER_INFO = {
  name: "urovo-tools",
  title: "Urovo Tools",
  version: "1.0.0",
};

const INSTRUCTIONS =
  "Read-only access to the Urovo tools/firmware library stored under tools/. Use search_files to find files by name (pass a string, or an array of strings to OR terms), get_file for metadata and the public download URL, and get_description for optional notes. Return the url field to users instead of downloading file bytes through these tools.";

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

const TOOLS = [
  {
    name: "search_files",
    description:
      "Search Urovo tool/firmware files under tools/. Matching is case-insensitive against file name and key. Pass one string, or an array of strings to OR them together (a file matches if any term hits). An empty query returns the most recently uploaded files. Results include public download URLs, not file contents.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          anyOf: [
            {
              type: "string",
              description:
                "A single search term, for example K329 or setup.zip.",
            },
            {
              type: "array",
              items: {
                type: "string",
              },
              description:
                "Multiple search terms combined with OR. Example: [\"K329\", \"SDK\"].",
            },
          ],
          description:
            "Optional search text. A string matches as a substring. An array ORs the terms. Empty or omitted returns the newest files.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of files to return. Defaults to 50.",
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

async function callTool(name, args, bucket) {
  const input = args && typeof args === "object" ? args : {};

  if (name === "search_files") {
    const files = await listToolFiles(bucket);
    return toolResult(searchToolFiles(files, input.query, input.limit));
  }

  if (name === "get_file") {
    if (!input.key && !input.name) {
      return toolError({
        error: "Provide key or name.",
      });
    }

    const found = await findToolFile(bucket, input);

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

    const found = await findToolFile(bucket, input);

    if (found.error) {
      return toolError({
        error: found.error,
        matches: found.matches,
      });
    }

    const object = await bucket.head(found.file.key);

    if (!object) {
      return toolError({
        error: "File not found.",
      });
    }

    return toolResult({
      key: found.file.key,
      name: found.file.name,
      url: found.file.url,
      description: getDescriptionFromMetadata(object.customMetadata),
    });
  }

  return null;
}

async function handleRpc(message, context, protocolVersion) {
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
        instructions: INSTRUCTIONS,
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
        tools: TOOLS,
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

    if (!TOOLS.some((tool) => tool.name === name)) {
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
      const result = await callTool(name, args, bucket);

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
      tools: TOOLS.map((tool) => tool.name),
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
    const handled = await handleRpc(message, context, protocolVersion);

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
