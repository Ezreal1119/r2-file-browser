export const LABELS_KEY = "settings/labels.json";
export const DESCRIPTION_OVERRIDES_KEY = "settings/description-overrides.json";

function deletedKeys(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter((key) => key.startsWith("urovo-en/")),
  )];
}

async function readJson(bucket, key) {
  const object = await bucket.get(key);
  return object ? object.json() : null;
}

async function writeJson(bucket, key, value) {
  return bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export async function pruneDeletedItemPersistence(bucket, values) {
  const keys = deletedKeys(values);
  const result = {
    attempted: keys.length,
    labelsRemoved: 0,
    descriptionsRemoved: 0,
  };

  if (keys.length === 0) return result;

  const [labelState, descriptionState] = await Promise.all([
    readJson(bucket, LABELS_KEY),
    readJson(bucket, DESCRIPTION_OVERRIDES_KEY),
  ]);

  if (labelState?.assignments && typeof labelState.assignments === "object") {
    const assignments = { ...labelState.assignments };

    for (const key of keys) {
      if (!Object.hasOwn(assignments, key)) continue;
      delete assignments[key];
      result.labelsRemoved += 1;
    }

    if (result.labelsRemoved > 0) {
      await writeJson(bucket, LABELS_KEY, {
        ...labelState,
        version: 1,
        assignments,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  if (
    descriptionState?.overrides &&
    typeof descriptionState.overrides === "object"
  ) {
    const overrides = { ...descriptionState.overrides };

    for (const key of keys) {
      if (!Object.hasOwn(overrides, key)) continue;
      delete overrides[key];
      result.descriptionsRemoved += 1;
    }

    if (result.descriptionsRemoved > 0) {
      await writeJson(bucket, DESCRIPTION_OVERRIDES_KEY, {
        ...descriptionState,
        version: 1,
        overrides,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return result;
}
