import { isAiProviderReady } from "./ai-config.js";
import { listToolFiles } from "./files.js";
import { readLabelState, writeLabelState } from "./labels.js";

export const AUTO_LABEL_BATCH_SIZE = 20;
export const AUTO_LABEL_APPLY_BATCH_SIZE = 100;

function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""));
  } catch {
    return null;
  }
}

export function normalizeLabelSuggestions(input, candidates, labels) {
  const args = parseToolArguments(input);
  const rows = Array.isArray(args?.suggestions) ? args.suggestions : null;
  if (!rows) return null;
  const candidateByKey = new Map(candidates.map((file) => [file.key, file]));
  const canonicalLabels = new Map(labels.map((label) => [label.toLocaleLowerCase(), label]));
  const results = new Map();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = typeof row.key === "string" ? row.key : "";
    if (!candidateByKey.has(key) || results.has(key)) continue;
    const suggested = typeof row.label === "string" ? row.label.normalize("NFKC").trim() : "";
    const label = canonicalLabels.get(suggested.toLocaleLowerCase()) || null;
    const confidence = Number(row.confidence);
    const reason = typeof row.reason === "string" ? row.reason.trim().slice(0, 180) : "";
    results.set(key, {
      key,
      name: candidateByKey.get(key).name,
      label: label && Number.isFinite(confidence) && confidence >= 85 && reason ? label : null,
      reason: reason || "Insufficient evidence from the filename.",
    });
  }

  return candidates.map((file) => results.get(file.key) || {
    key: file.key,
    name: file.name,
    label: null,
    reason: "The model did not provide a confident classification.",
  });
}

export async function previewAutoLabels({ bucket, settings, env, keys, fetchImpl = fetch }) {
  if (!isAiProviderReady(settings, env)) throw new Error("AI provider is not configured.");
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > AUTO_LABEL_BATCH_SIZE ||
      keys.some((key) => typeof key !== "string" || !key.startsWith("tools/") || key.length > 1024) ||
      new Set(keys).size !== keys.length) {
    throw new Error("Provide 1–20 unique uploaded file keys.");
  }

  const [files, state] = await Promise.all([listToolFiles(bucket), readLabelState(bucket)]);
  if (state.labels.length === 0) throw new Error("Create labels in Label List first.");
  const eligible = new Map(files
    .filter((file) => !(state.assignments[file.key] || []).length)
    .map((file) => [file.key, file]));
  const candidates = keys.map((key) => eligible.get(key)).filter(Boolean);
  if (candidates.length === 0) return [];

  const tool = {
    type: "function",
    function: {
      name: "propose_labels",
      description: "Classify uploaded files using only the exact available labels. Return null for uncertain files.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: { type: "string", description: "One existing label, or an empty string when uncertain." },
                confidence: { type: "number", minimum: 0, maximum: 100 },
                reason: { type: "string" },
              },
              required: ["key", "label", "confidence", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["suggestions"],
        additionalProperties: false,
      },
    },
  };
  const body = {
    model: settings.model,
    messages: [
      {
        role: "system",
        content: `You classify Urovo uploaded library files by filename only. Available labels: ${JSON.stringify(state.labels)}. Use exactly one existing label per file only when the filename provides clear evidence. Never invent a label or assume what an opaque filename contains. Set confidence 85–100 only for clear matches; otherwise use label "" and confidence 0. Do not use product knowledge beyond the filename. Return every supplied key exactly once through propose_labels.`,
      },
      {
        role: "user",
        content: JSON.stringify(candidates.map(({ key, name }) => ({ key, name }))),
      },
    ],
    tools: [tool],
    tool_choice: "required",
    temperature: 0,
  };
  if (new URL(settings.baseUrl).hostname.toLowerCase().endsWith("deepseek.com")) {
    body.thinking = { type: "disabled" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetchImpl(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("The AI provider could not classify this batch.");
    const payload = await response.json();
    const call = payload?.choices?.[0]?.message?.tool_calls?.find(
      (item) => item?.function?.name === "propose_labels",
    );
    const normalized = normalizeLabelSuggestions(call?.function?.arguments, candidates, state.labels);
    if (!normalized) throw new Error("The AI model returned invalid labeling results.");
    return normalized;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Auto Labeling timed out. Please try again.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function applyAutoLabels(bucket, proposals) {
  if (!Array.isArray(proposals) || proposals.length > AUTO_LABEL_APPLY_BATCH_SIZE ||
      proposals.some((entry) => !entry || typeof entry.key !== "string" ||
        !entry.key.startsWith("tools/") || entry.key.length > 1024 ||
        typeof entry.label !== "string" || entry.label.length > 40) ||
      new Set(proposals.map((entry) => entry.key)).size !== proposals.length) {
    throw new Error("Invalid labeling batch.");
  }
  const [files, state] = await Promise.all([listToolFiles(bucket), readLabelState(bucket)]);
  const fileKeys = new Set(files.map((file) => file.key));
  const canonicalLabels = new Map(state.labels.map((label) => [label.toLocaleLowerCase(), label]));
  const assignments = { ...state.assignments };
  const applied = [];
  const skipped = [];

  for (const { key, label: proposedLabel } of proposals) {
    const label = canonicalLabels.get(proposedLabel.normalize("NFKC").trim().toLocaleLowerCase());
    if (!fileKeys.has(key) || (assignments[key] || []).length || !label) {
      skipped.push(key);
      continue;
    }
    assignments[key] = [label];
    applied.push({ key, label });
  }

  if (applied.length) {
    await writeLabelState(bucket, { labels: state.labels, assignments });
  }
  return { applied, skipped };
}
