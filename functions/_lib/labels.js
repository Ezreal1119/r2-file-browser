export const LABELS_KEY = "settings/labels.json";
export const MAX_LABELS = 50;
export const MAX_LABEL_LENGTH = 40;
export const MAX_ITEM_LABELS = 20;

function cleanLabel(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

export function normalizeLabelList(values) {
  const labels = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const label = cleanLabel(value);
    const identity = label.toLocaleLowerCase();
    if (!label || label.length > MAX_LABEL_LENGTH || seen.has(identity)) continue;
    seen.add(identity);
    labels.push(label);
    if (labels.length >= MAX_LABELS) break;
  }

  return labels;
}

export function normalizeLabelState(value) {
  const labels = normalizeLabelList(value?.labels);
  const canonical = new Map(
    labels.map((label) => [label.toLocaleLowerCase(), label]),
  );
  const assignments = {};

  if (value?.assignments && typeof value.assignments === "object") {
    for (const [key, assigned] of Object.entries(value.assignments)) {
      const cleanKey = String(key || "").trim();
      if (!cleanKey || !Array.isArray(assigned)) continue;
      const normalized = [];
      const seen = new Set();
      for (const candidate of assigned) {
        const label = canonical.get(cleanLabel(candidate).toLocaleLowerCase());
        if (!label || seen.has(label)) continue;
        seen.add(label);
        normalized.push(label);
        if (normalized.length >= MAX_ITEM_LABELS) break;
      }
      if (normalized.length > 0) assignments[cleanKey] = normalized;
    }
  }

  return {
    version: 1,
    labels,
    assignments,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
  };
}

export async function readLabelState(bucket) {
  const object = await bucket.get(LABELS_KEY);
  if (!object) return normalizeLabelState(null);

  try {
    return normalizeLabelState(await object.json());
  } catch (error) {
    throw new Error(
      `Label index is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function writeLabelState(bucket, value) {
  const state = normalizeLabelState({
    ...value,
    updatedAt: new Date().toISOString(),
  });
  state.updatedAt = new Date().toISOString();

  await bucket.put(LABELS_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  return state;
}

export function assignLabelsToFiles(files, state) {
  return files.map((file) => ({
    ...file,
    labels: [...(state.assignments[file.key] || [])],
  }));
}
