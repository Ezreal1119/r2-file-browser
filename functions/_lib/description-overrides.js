export const DESCRIPTION_OVERRIDES_KEY = "settings/description-overrides.json";
export const MAX_DESCRIPTION_LENGTH = 1500;

function normalizeDescription(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

export function normalizeDescriptionOverrideState(value) {
  const overrides = {};

  if (value?.overrides && typeof value.overrides === "object") {
    for (const [key, entry] of Object.entries(value.overrides)) {
      if (!key.startsWith("urovo-en/") || !entry || typeof entry !== "object") {
        continue;
      }

      const description = normalizeDescription(entry.description);
      if (!description || description.length > MAX_DESCRIPTION_LENGTH) continue;

      overrides[key] = {
        description,
        updatedAt:
          typeof entry.updatedAt === "string" ? entry.updatedAt : null,
      };
    }
  }

  return {
    version: 1,
    overrides,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
  };
}

export async function readDescriptionOverrideState(bucket) {
  const object = await bucket.get(DESCRIPTION_OVERRIDES_KEY);
  if (!object) return normalizeDescriptionOverrideState(null);

  try {
    return normalizeDescriptionOverrideState(await object.json());
  } catch (error) {
    throw new Error(
      `Description override index is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function writeDescriptionOverrideState(bucket, value) {
  const updatedAt = new Date().toISOString();
  const state = normalizeDescriptionOverrideState({ ...value, updatedAt });
  state.updatedAt = updatedAt;

  await bucket.put(DESCRIPTION_OVERRIDES_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  return state;
}

export function applyDescriptionOverrides(files, state) {
  return files.map((file) => {
    if (!file.external) return file;

    const generatedDescription = file.description || "";
    const override = state.overrides[file.key];
    const description = override?.description || generatedDescription;

    return {
      ...file,
      description,
      hasDescription: description.length > 0,
      descriptionOverridden: Boolean(override),
    };
  });
}

export async function saveDescriptionOverride(bucket, key, description) {
  const current = await readDescriptionOverrideState(bucket);
  const overrides = { ...current.overrides };
  const cleanDescription = normalizeDescription(description);

  if (cleanDescription) {
    overrides[key] = {
      description: cleanDescription,
      updatedAt: new Date().toISOString(),
    };
  } else {
    delete overrides[key];
  }

  return writeDescriptionOverrideState(bucket, { overrides });
}
