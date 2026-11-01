export const AI_SETTINGS_KEY = "settings/ai.json";

export async function readAiSettings(bucket) {
  if (!bucket) {
    return {
      baseUrl: "",
      model: "",
      enabled: false,
      requireHumanVerification: true,
      updatedAt: null,
    };
  }

  const object = await bucket.get(AI_SETTINGS_KEY);

  if (!object) {
    return {
      baseUrl: "",
      model: "",
      enabled: false,
      requireHumanVerification: true,
      updatedAt: null,
    };
  }

  let stored;

  try {
    stored = await object.json();
  } catch {
    throw new Error("Stored AI settings are invalid.");
  }

  return {
    baseUrl: typeof stored.baseUrl === "string" ? stored.baseUrl : "",
    model: typeof stored.model === "string" ? stored.model : "",
    enabled: stored.enabled === true,
    requireHumanVerification: stored.requireHumanVerification !== false,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
  };
}

export function getAiInfrastructure(env) {
  return {
    apiKey: Boolean(env.AI_API_KEY),
    turnstileSiteKey: Boolean(env.TURNSTILE_SITE_KEY),
    turnstileSecretKey: Boolean(env.TURNSTILE_SECRET_KEY),
    sessionSecret: Boolean(env.AI_SESSION_SECRET),
    database: Boolean(env.AI_DB),
    bucket: Boolean(env.FIRMWARE_BUCKET),
  };
}

export function isAiReady(settings, env) {
  const infrastructure = getAiInfrastructure(env);

  return Boolean(
    isAiProviderReady(settings, env) &&
      infrastructure.sessionSecret &&
      infrastructure.database &&
      infrastructure.bucket &&
      (settings?.requireHumanVerification === false ||
        (infrastructure.turnstileSiteKey &&
          infrastructure.turnstileSecretKey)),
  );
}

export function isAiProviderReady(settings, env) {
  return Boolean(
    settings?.baseUrl &&
      settings?.model &&
      env?.AI_API_KEY &&
      env?.FIRMWARE_BUCKET,
  );
}
