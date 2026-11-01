const COOKIE_NAME = "urovo_ai_visitor";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 180;

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

function secureEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

export async function getVisitor(request, secret, now = Date.now()) {
  const cookie = readCookie(request, COOKIE_NAME);

  if (cookie) {
    const [id, expiresText, signature] = cookie.split(".");
    const expires = Number(expiresText);
    if (
      /^[a-f0-9-]{36}$/i.test(id || "") &&
      Number.isInteger(expires) &&
      expires > Math.floor(now / 1000) &&
      typeof signature === "string"
    ) {
      const expected = await sign(`${id}.${expires}`, secret);
      if (secureEqual(signature, expected)) {
        return { id, setCookie: null };
      }
    }
  }

  const id = crypto.randomUUID();
  const expires = Math.floor(now / 1000) + COOKIE_MAX_AGE;
  const signature = await sign(`${id}.${expires}`, secret);
  return {
    id,
    setCookie: `${COOKIE_NAME}=${id}.${expires}.${signature}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
  };
}

export async function verifyTurnstile({ request, token, secret }) {
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) body.set("remoteip", remoteIp);

  let response;
  try {
    response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body },
    );
  } catch {
    return false;
  }

  if (!response.ok) return false;

  let result;
  try {
    result = await response.json();
  } catch {
    return false;
  }

  const expectedHostname = new URL(request.url).hostname.toLowerCase();
  return Boolean(
    result.success === true &&
      result.action === "ai_search" &&
      String(result.hostname || "").toLowerCase() === expectedHostname,
  );
}

export async function acquireAiLock(database, visitorId, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  const lockToken = crypto.randomUUID();
  await database
    .prepare("DELETE FROM ai_active_tasks WHERE expires_at <= ?")
    .bind(nowSeconds)
    .run();
  const lock = await database
    .prepare(
      "INSERT OR IGNORE INTO ai_active_tasks (visitor_id, lock_token, expires_at) VALUES (?, ?, ?) RETURNING lock_token",
    )
    .bind(visitorId, lockToken, nowSeconds + LOCK_TTL_SECONDS)
    .first();

  return lock?.lock_token === lockToken ? lockToken : null;
}

export async function releaseAiLock(database, visitorId, lockToken) {
  await database
    .prepare(
      "DELETE FROM ai_active_tasks WHERE visitor_id = ? AND lock_token = ?",
    )
    .bind(visitorId, lockToken)
    .run();
}

export async function consumeAiQuota(database, visitorId, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  const minuteBucket = Math.floor(nowSeconds / 60);
  const dayBucket = new Date(now).toISOString().slice(0, 10);
  const requestId = crypto.randomUUID();
  const inserted = await database
    .prepare(
      `INSERT INTO ai_requests (id, visitor_id, created_at, minute_bucket, day_bucket)
       SELECT ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM ai_requests WHERE visitor_id = ? AND minute_bucket = ?) < 3
         AND (SELECT COUNT(*) FROM ai_requests WHERE visitor_id = ? AND day_bucket = ?) < 20
         AND (SELECT COUNT(*) FROM ai_requests WHERE day_bucket = ?) < 200
       RETURNING id`,
    )
    .bind(
      requestId,
      visitorId,
      nowSeconds,
      minuteBucket,
      dayBucket,
      visitorId,
      minuteBucket,
      visitorId,
      dayBucket,
      dayBucket,
    )
    .first();

  if (inserted?.id === requestId) {
    if (Math.random() < 0.02) {
      await database
        .prepare("DELETE FROM ai_requests WHERE created_at < ?")
        .bind(nowSeconds - 3 * 24 * 60 * 60)
        .run();
    }
    return { allowed: true };
  }

  const statements = [
    database.prepare(
      "SELECT COUNT(*) AS count FROM ai_requests WHERE visitor_id = ? AND minute_bucket = ?",
    ).bind(visitorId, minuteBucket),
    database.prepare(
      "SELECT COUNT(*) AS count FROM ai_requests WHERE visitor_id = ? AND day_bucket = ?",
    ).bind(visitorId, dayBucket),
    database.prepare(
      "SELECT COUNT(*) AS count FROM ai_requests WHERE day_bucket = ?",
    ).bind(dayBucket),
  ];
  const counts = await database.batch(statements);
  const values = counts.map((result) => Number(result.results?.[0]?.count || 0));
  const secondsToMinute = 60 - (nowSeconds % 60);
  const nextDay = Date.parse(`${dayBucket}T00:00:00.000Z`) / 1000 + 86400;

  if (values[0] >= 3) {
    return { allowed: false, reason: "minute", retryAfter: secondsToMinute };
  }
  if (values[1] >= 20) {
    return { allowed: false, reason: "visitor_day", retryAfter: nextDay - nowSeconds };
  }
  return { allowed: false, reason: "global_day", retryAfter: nextDay - nowSeconds };
}
