import { isAdminPassword } from "../_lib/admin.js";
import { readAiSettings } from "../_lib/ai-config.js";
import {
  applyAutoLabels,
  previewAutoLabels,
} from "../_lib/auto-labeling.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestPost(context) {
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  if (!isAdminPassword(payload?.password, context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }
  if (!context.env.FIRMWARE_BUCKET) {
    return jsonResponse({ error: "R2 binding is unavailable." }, 503);
  }
  const action = payload?.action;
  if (action !== "preview" && action !== "apply") {
    return jsonResponse({ error: "Invalid Auto Labeling action." }, 400);
  }

  try {
    if (action === "preview") {
      const settings = await readAiSettings(context.env.FIRMWARE_BUCKET);
      const suggestions = await previewAutoLabels({
        bucket: context.env.FIRMWARE_BUCKET,
        settings,
        env: context.env,
        keys: payload.keys,
      });
      return jsonResponse({ suggestions });
    }
    const result = await applyAutoLabels(
      context.env.FIRMWARE_BUCKET,
      payload.proposals,
    );
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Auto Labeling failed.";
    const badInput = /^(Provide|Invalid labeling batch|Create labels)/.test(message);
    console.error("Auto Labeling failed:", message);
    return jsonResponse({ error: message }, badInput ? 400 : 502);
  }
}
