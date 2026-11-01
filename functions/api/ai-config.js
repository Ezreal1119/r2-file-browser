import { isAiReady, readAiSettings } from "../_lib/ai-config.js";

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export async function onRequestGet(context) {
  try {
    const settings = await readAiSettings(context.env.FIRMWARE_BUCKET);
    const ready = isAiReady(settings, context.env);

    return jsonResponse({
      enabled: settings.enabled && ready,
      ready,
      requireHumanVerification: settings.requireHumanVerification !== false,
      turnstileSiteKey: settings.requireHumanVerification !== false
        ? context.env.TURNSTILE_SITE_KEY || ""
        : "",
    });
  } catch {
    return jsonResponse({
      enabled: false,
      ready: false,
      requireHumanVerification: true,
      turnstileSiteKey: "",
    });
  }
}
