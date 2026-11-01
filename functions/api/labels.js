import { isAdminPassword } from "../_lib/admin.js";
import { uploaderId } from "../_lib/uploader.js";
import {
  MAX_ITEM_LABELS,
  MAX_LABEL_LENGTH,
  MAX_LABELS,
  normalizeLabelList,
  readLabelState,
  writeLabelState,
} from "../_lib/labels.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readPayload(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getPassword(context, payload) {
  return context.request.headers.get("X-Admin-Password") || payload?.password;
}

export async function onRequestGet(context) {
  if (!context.env.FIRMWARE_BUCKET) {
    return jsonResponse({ error: "R2 binding FIRMWARE_BUCKET is not configured." }, 500);
  }

  try {
    const state = await readLabelState(context.env.FIRMWARE_BUCKET);
    return jsonResponse({ labels: state.labels, updatedAt: state.updatedAt });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function onRequestPut(context) {
  const payload = await readPayload(context.request);
  if (!payload) return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  if (!isAdminPassword(getPassword(context, payload), context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }
  if (!Array.isArray(payload.labels) || payload.labels.length > MAX_LABELS) {
    return jsonResponse({ error: `Labels must be an array of at most ${MAX_LABELS} strings.` }, 400);
  }
  if (payload.labels.some((label) =>
    typeof label !== "string" || !label.trim() || label.normalize("NFKC").trim().length > MAX_LABEL_LENGTH
  )) {
    return jsonResponse({ error: `Each label must be 1–${MAX_LABEL_LENGTH} characters.` }, 400);
  }

  try {
    const bucket = context.env.FIRMWARE_BUCKET;
    const current = await readLabelState(bucket);
    const state = await writeLabelState(bucket, {
      labels: normalizeLabelList(payload.labels),
      assignments: current.assignments,
    });
    return jsonResponse(state);
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function onRequestPatch(context) {
  const payload = await readPayload(context.request);
  if (!payload) return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  if (!isAdminPassword(getPassword(context, payload), context.env)) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const key = typeof payload.key === "string" ? payload.key.trim() : "";
  if (!key || (!key.startsWith("tools/") && !key.startsWith("urovo-en/") && !uploaderId(key))) {
    return jsonResponse({ error: "A valid library item key is required." }, 400);
  }
  if (!Array.isArray(payload.labels) || payload.labels.length > MAX_ITEM_LABELS) {
    return jsonResponse({ error: `Item labels must contain at most ${MAX_ITEM_LABELS} entries.` }, 400);
  }

  try {
    const bucket = context.env.FIRMWARE_BUCKET;
    if (uploaderId(key) && !(await context.env.UPLOADER_BUCKET?.head(`records/${uploaderId(key)}`))) return jsonResponse({ error: "File not found." }, 404);
    const current = await readLabelState(bucket);
    const canonical = new Map(
      current.labels.map((label) => [label.toLocaleLowerCase(), label]),
    );
    const labels = [];
    for (const value of payload.labels) {
      const label = canonical.get(String(value || "").normalize("NFKC").trim().toLocaleLowerCase());
      if (!label) return jsonResponse({ error: "One or more labels no longer exist." }, 400);
      if (!labels.includes(label)) labels.push(label);
    }

    const assignments = { ...current.assignments };
    if (labels.length > 0) assignments[key] = labels;
    else delete assignments[key];
    const state = await writeLabelState(bucket, {
      labels: current.labels,
      assignments,
    });
    return jsonResponse({ key, labels: state.assignments[key] || [] });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}
