import { isAiReady, readAiSettings } from "../_lib/ai-config.js";
import {
  AiAgentError,
  searchLibraryWithPrompt,
} from "../_lib/ai-agent.js";
import {
  acquireAiLock,
  consumeAiQuota,
  getVisitor,
  releaseAiLock,
  verifyTurnstile,
} from "../_lib/ai-security.js";
import { writeEventLog } from "../_lib/event-logs.js";
import { scopedLibraryFiles } from "../_lib/uploader.js";

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function scheduleAiLog(
  context,
  { prompt, response = "", error = "", visitorId = "" },
) {
  const task = writeEventLog(
    context.env.AI_DB,
    {
      eventType: "ai_search",
      status: error ? "error" : "success",
      aiPrompt: prompt,
      aiResponse: response,
      errorMessage: error,
    },
    { visitorId },
  ).catch((logError) => {
    console.error(
      "Failed to write AI activity log:",
      logError instanceof Error ? logError.message : String(logError),
    );
  });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(task);
  } else {
    void task;
  }
}

function aiErrorResponse(
  context,
  { prompt, message, status, headers = {}, visitorId = "", detail = "" },
) {
  scheduleAiLog(context, {
    prompt,
    error: detail ? `${message} ${detail}` : message,
    visitorId,
  });
  return jsonResponse({ error: message }, status, headers);
}

export async function onRequestPost(context) {
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const rawPrompt = typeof payload?.prompt === "string" ? payload.prompt : "";
  const prompt = rawPrompt.trim();
  const turnstileToken = typeof payload?.turnstileToken === "string"
    ? payload.turnstileToken.trim()
    : "";
  if (!prompt || prompt.length > 500) {
    return aiErrorResponse(context, {
      prompt: rawPrompt,
      message: "Prompt must be between 1 and 500 characters.",
      status: 400,
    });
  }

  let settings;
  try {
    settings = await readAiSettings(context.env.FIRMWARE_BUCKET);
  } catch {
    return aiErrorResponse(context, {
      prompt: rawPrompt,
      message: "AI is unavailable.",
      status: 503,
    });
  }
  if (!settings.enabled || !isAiReady(settings, context.env)) {
    return aiErrorResponse(context, {
      prompt: rawPrompt,
      message: "AI search is not enabled.",
      status: 503,
    });
  }

  const visitor = await getVisitor(context.request, context.env.AI_SESSION_SECRET);
  const responseHeaders = visitor.setCookie ? { "Set-Cookie": visitor.setCookie } : {};
  const requiresVerification = settings.requireHumanVerification !== false;
  if (requiresVerification && (
    !turnstileToken ||
    turnstileToken.length > 2048 ||
    !(await verifyTurnstile({
      request: context.request,
      token: turnstileToken,
      secret: context.env.TURNSTILE_SECRET_KEY,
    }))
  )) {
    return aiErrorResponse(context, {
      prompt: rawPrompt,
      message: "Human verification failed. Please try again.",
      status: 403,
      headers: responseHeaders,
      visitorId: visitor.id,
    });
  }

  const lockToken = await acquireAiLock(context.env.AI_DB, visitor.id);
  if (!lockToken) {
    return aiErrorResponse(context, {
      prompt: rawPrompt,
      message: "An AI search is already running for this visitor.",
      status: 409,
      headers: responseHeaders,
      visitorId: visitor.id,
    });
  }

  try {
    const quota = await consumeAiQuota(context.env.AI_DB, visitor.id);
    if (!quota.allowed) {
      return aiErrorResponse(context, {
        prompt: rawPrompt,
        message: "AI search limit reached. Please try again later.",
        status: 429,
        headers: {
          ...responseHeaders,
          "Retry-After": String(Math.max(1, quota.retryAfter)),
        },
        visitorId: visitor.id,
        detail: `Quota: ${quota.reason || "unknown"}.`,
      });
    }

    const result = await searchLibraryWithPrompt({
      prompt,
      bucket: context.env.FIRMWARE_BUCKET,
      settings,
      apiKey: context.env.AI_API_KEY,
      loadLibrary: () => scopedLibraryFiles(context),
    });
    scheduleAiLog(context, {
      prompt: rawPrompt,
      response: typeof result?.message === "string" ? result.message : "",
      visitorId: visitor.id,
    });
    return jsonResponse(result, 200, responseHeaders);
  } catch (error) {
    console.error("AI search failed:", error instanceof Error ? error.message : String(error));
    if (error instanceof AiAgentError) {
      const status = error.code === "incompatible" ? 503 : 502;
      const message = error.code === "incompatible"
        ? "The configured AI model is not compatible with this search agent."
        : error.code === "timeout"
          ? "AI search timed out. Please try again."
          : "The AI provider is temporarily unavailable.";
      return aiErrorResponse(context, {
        prompt: rawPrompt,
        message,
        status,
        headers: responseHeaders,
        visitorId: visitor.id,
        detail: error.message,
      });
    }
    return aiErrorResponse(context, {
      prompt: rawPrompt,
      message: "AI search is temporarily unavailable.",
      status: 500,
      headers: responseHeaders,
      visitorId: visitor.id,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await releaseAiLock(context.env.AI_DB, visitor.id, lockToken);
    } catch (error) {
      console.error("Failed to release AI task lock:", error instanceof Error ? error.message : String(error));
    }
  }
}
