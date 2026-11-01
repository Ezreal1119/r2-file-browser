import { isAdminPassword } from "../_lib/admin.js";
import {
  AI_SETTINGS_KEY,
  getAiInfrastructure,
  isAiReady,
  readAiSettings,
} from "../_lib/ai-config.js";

export { AI_SETTINGS_KEY };

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function getAdminPassword(context, payload) {
  return context.request.headers.get("X-Admin-Password") || payload?.password;
}

function normalizeBaseUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!text) {
    return { error: "Base URL is required." };
  }

  let url;

  try {
    url = new URL(text);
  } catch {
    return { error: "Base URL must be a valid URL." };
  }

  if (url.protocol !== "https:") {
    return { error: "Base URL must use HTTPS." };
  }

  if (url.username || url.password || url.search || url.hash) {
    return { error: "Base URL cannot contain credentials, a query, or a hash." };
  }

  return { value: url.href.replace(/\/$/, "") };
}

function normalizeModel(value) {
  const model = typeof value === "string" ? value.trim() : "";

  if (!model) {
    return { error: "Model name is required." };
  }

  if (model.length > 200) {
    return { error: "Model name must be at most 200 characters." };
  }

  return { value: model };
}

export async function onRequestGet(context) {
  if (!isAdminPassword(getAdminPassword(context), context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const bucket = context.env.FIRMWARE_BUCKET;

  if (!bucket) {
    return jsonResponse(
      { error: "R2 binding FIRMWARE_BUCKET is not configured." },
      500,
    );
  }

  let settings;

  try {
    settings = await readAiSettings(bucket);
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  const infrastructure = getAiInfrastructure(context.env);

  return jsonResponse({
    ...settings,
    ready: isAiReady(settings, context.env),
    infrastructure,
    apiKeyConfigured: infrastructure.apiKey,
  });
}

export async function onRequestPut(context) {
  let payload;

  try {
    payload = await context.request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  if (!isAdminPassword(getAdminPassword(context, payload), context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const bucket = context.env.FIRMWARE_BUCKET;

  if (!bucket) {
    return jsonResponse(
      { error: "R2 binding FIRMWARE_BUCKET is not configured." },
      500,
    );
  }

  const baseUrl = normalizeBaseUrl(payload?.baseUrl);

  if (baseUrl.error) {
    return jsonResponse({ error: baseUrl.error }, 400);
  }

  const model = normalizeModel(payload?.model);

  if (model.error) {
    return jsonResponse({ error: model.error }, 400);
  }

  const enabled = payload?.enabled === true;
  const requireHumanVerification = payload?.requireHumanVerification !== false;
  const settings = {
    baseUrl: baseUrl.value,
    model: model.value,
    enabled,
    requireHumanVerification,
    updatedAt: new Date().toISOString(),
  };

  if (enabled && !isAiReady(settings, context.env)) {
    return jsonResponse(
      { error: "AI cannot be enabled until the required Secrets and bindings for the selected verification mode are configured." },
      409,
    );
  }

  await bucket.put(AI_SETTINGS_KEY, JSON.stringify(settings), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  return jsonResponse({
    ...settings,
    ready: isAiReady(settings, context.env),
    infrastructure: getAiInfrastructure(context.env),
    apiKeyConfigured: Boolean(context.env.AI_API_KEY),
  });
}
