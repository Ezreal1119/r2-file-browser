// Independent of the authenticated Urovo catalog crawler and its persistence.
export const SDK_CRON = "10 19 * * *"; // Daily 03:10 Asia/Shanghai.
export const SDK_PREFIX = "indexes/github-sdk";
export const SDK_STATUS_KEY = `${SDK_PREFIX}/status.json`;
export const SDK_MANIFEST_KEY = `${SDK_PREFIX}/files.json`;
const REPO = "UrovoSdkCenter/docs-site";
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const OBJECT_PREFIX = "tools/auto-sdk/";
const LOCK_MS = 2 * 60 * 60 * 1000;

export const SDK_SOURCES = [
  { id: "pos-printer", page: "zh/printer/pos/download", folder: "pos", title: "Urovo POS Printer SDK" },
  { id: "sp35-cradle", page: "zh/cradle/download", folder: "cradle", title: "Urovo SP35 Cradle SDK" },
  { id: "pda-scanner", page: "zh/scanning/download", folder: "scanning", title: "Urovo PDA Scanner SDK" },
  { id: "pda-rfid", page: "zh/rfid/download", folder: "rfid", title: "Urovo PDA RFID SDK" },
  { id: "k388pro-printer", page: "zh/label-printer/k388pro/download", folder: "k388pro", title: "Urovo K388Pro Printer SDK" },
];

const readJson = async (bucket, key, fallback = null) => {
  const object = await bucket.get(key);
  return object ? object.json() : fallback;
};
const writeJson = (bucket, key, value) => bucket.put(key, JSON.stringify(value), {
  httpMetadata: { contentType: "application/json; charset=utf-8" },
});
const runKey = (runId) => `${SDK_PREFIX}/audits/${runId}.json`;
const errorText = (error) => error instanceof Error ? error.message : String(error);

export function shanghaiDate(value) {
  // Fixed UTC+08:00; China does not observe daylight saving time.
  return new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

export function parseSdkLink(markdown, source) {
  // Select the first main package, not the secondary offline API documentation.
  const links = [...markdown.matchAll(/\]\((https:\/\/github\.com\/UrovoSdkCenter\/docs-site\/raw\/main\/downloads\/[^)\s]+)\)/g)];
  const url = links[0] && new URL(links[0][1]);
  const path = url && decodeURIComponent(url.pathname).replace(`/${REPO}/raw/main/`, "");
  if (!path || !path.startsWith(`downloads/${source.folder}/`) ||
      path.includes("..") || path.includes("\\") || !/\.(zip|7z)$/i.test(path)) {
    throw new Error(`Missing or unexpected main SDK link: ${source.page}`);
  }
  return path;
}

export function parseLfsPointer(text) {
  if (!text.startsWith("version https://git-lfs.github.com/spec/v1\n")) return null;
  const oid = text.match(/^oid sha256:([a-f0-9]{64})$/m)?.[1];
  const size = Number(text.match(/^size (\d+)$/m)?.[1]);
  if (!oid || !Number.isSafeInteger(size) || size < 1) throw new Error("Invalid Git LFS pointer.");
  return { oid, size };
}

async function sourceFetch(url, env, fetchImpl, binary = false) {
  const headers = { "User-Agent": "Urovo-SDK-Sync/1.0", Accept: binary ? "application/octet-stream" : "application/vnd.github+json" };
  // Never forward the optional API token to raw, redirects, or download hosts.
  if (url.startsWith(`${API}/`) && env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const response = await fetchImpl(url, {
    headers, redirect: "follow", signal: AbortSignal.timeout(binary ? 240000 : 30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub returned HTTP ${response.status} for ${new URL(url).pathname}.`);
  }
  return response;
}

export async function discoverSdkPlan(env, fetchImpl = fetch) {
  const commit = await (await sourceFetch(`${API}/commits/main`, env, fetchImpl)).json();
  const revision = commit.sha;
  const treeSha = commit.commit?.tree?.sha;
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{40}$/.test(treeSha)) throw new Error("Invalid GitHub commit response.");
  const tree = await (await sourceFetch(`${API}/git/trees/${treeSha}?recursive=1`, env, fetchImpl)).json();
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("GitHub returned an incomplete repository tree.");
  const entries = new Map(tree.tree.map((entry) => [entry.path, entry]));
  const items = [];
  for (const source of SDK_SOURCES) {
    const markdown = await (await sourceFetch(`${RAW}/${revision}/docs/${source.page}.md`, env, fetchImpl)).text();
    const path = parseSdkLink(markdown, source);
    const entry = entries.get(path);
    if (entry?.type !== "blob" || !/^[a-f0-9]{40}$/.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 1) {
      throw new Error(`SDK archive missing from Git tree: ${path}`);
    }
    let lfs = null;
    if (entry.size < 1024) {
      const blob = await (await sourceFetch(`${API}/git/blobs/${entry.sha}`, env, fetchImpl)).json();
      if (blob.encoding !== "base64") throw new Error("Unexpected Git blob encoding.");
      lfs = parseLfsPointer(atob(blob.content.replace(/\s/g, "")));
      if (!lfs) throw new Error(`Unexpectedly small SDK archive: ${path}`);
    }
    const size = lfs?.size || entry.size;
    if (size > 512 * 1024 * 1024) throw new Error(`SDK exceeds the 512 MiB safety limit: ${path}`);
    const name = path.split("/").at(-1);
    items.push({
      ...source, path, name, size, revision,
      fingerprint: lfs ? `sha256:${lfs.oid}` : `git-blob:${entry.sha}`,
      sha256: lfs?.oid || null,
      key: `${OBJECT_PREFIX}${source.id}/${name}`,
      sourcePageUrl: `${RAW}/${revision}/docs/${source.page}.md`,
      // github.com/raw resolves Git LFS to media.githubusercontent.com.
      downloadUrl: lfs ? `https://github.com/${REPO}/raw/${revision}/${path}` : `${RAW}/${revision}/${path}`,
    });
  }
  return { revision, items };
}

export async function startSdkSync(env, trigger = "manual", now = new Date()) {
  if (!env.FIRMWARE_BUCKET || !env.SYNC_QUEUE) throw new Error("SDK sync storage or queue is not configured.");
  const bucket = env.FIRMWARE_BUCKET;
  const previous = await readJson(bucket, SDK_STATUS_KEY);
  if (["queued", "running", "retrying"].includes(previous?.state) &&
      now.getTime() - Date.parse(previous.startedAt) < LOCK_MS) {
    return { accepted: false, alreadyRunning: true, runId: previous.runId };
  }
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const status = { state: "queued", runId, trigger, startedAt: now.toISOString(), auditKey: runKey(runId), error: null };
  await writeJson(bucket, runKey(runId), { ...status, results: [] });
  await writeJson(bucket, SDK_STATUS_KEY, status);
  try {
    await env.SYNC_QUEUE.send({ type: "sdk-sync", runId });
  } catch (error) {
    await writeJson(bucket, SDK_STATUS_KEY, { ...status, state: "failed", error: errorText(error) });
    throw error;
  }
  return { accepted: true, alreadyRunning: false, runId };
}

function publicUrl(key) {
  return `https://temp.patrick-shenzhen.org/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function syncItem(item, previous, env, fetchImpl, now) {
  const bucket = env.FIRMWARE_BUCKET;
  const key = previous?.fingerprint === item.fingerprint ? previous.key : item.key;
  const stored = await bucket.head(key);
  // Metadata also recovers a successful put if manifest persistence failed afterward.
  if (stored?.size === item.size && stored.customMetadata?.sdkFingerprint === item.fingerprint) {
    return { action: "unchanged", entry: {
      ...(previous || {}), id: item.id, key, name: stored.customMetadata.originalFilename || item.name,
      size: item.size, fingerprint: item.fingerprint,
      downloadedAt: stored.customMetadata.sdkDownloadedAt,
      description: stored.customMetadata.description || "",
      lastCheckedAt: now().toISOString(), sourceCommit: item.revision,
      sourcePageUrl: item.sourcePageUrl, sourcePath: item.path, url: publicUrl(key),
    } };
  }
  const response = await sourceFetch(item.downloadUrl, env, fetchImpl, true);
  const contentType = response.headers.get("content-type") || "";
  const length = response.headers.get("content-length");
  if (!response.body || /text\/|json|html/i.test(contentType) || (length !== null && Number(length) !== item.size)) {
    await response.body?.cancel();
    throw new Error(`Invalid SDK download response: ${item.name}`);
  }
  const downloadedAt = now().toISOString();
  const description = `${item.title} - Last Sync: ${shanghaiDate(downloadedAt)}`;
  const result = await bucket.put(item.key, response.body, {
    httpMetadata: {
      contentType: item.name.toLowerCase().endsWith(".7z") ? "application/x-7z-compressed" : "application/zip",
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    },
    customMetadata: {
      autoSdk: "1", originalFilename: item.name, description,
      sdkFingerprint: item.fingerprint, sdkDownloadedAt: downloadedAt,
      sdkSourcePage: item.sourcePageUrl, sdkSourcePath: item.path,
      product: item.title.replace(/^Urovo | SDK$/g, ""),
    },
    ...(item.sha256 ? { sha256: item.sha256 } : {}),
  });
  if (result.size !== item.size) throw new Error(`Stored SDK size mismatch: ${item.name}`);
  return { action: "downloaded", entry: {
    id: item.id, key: item.key, name: item.name, size: item.size,
    fingerprint: item.fingerprint, downloadedAt, lastCheckedAt: now().toISOString(), description,
    sourceCommit: item.revision, sourcePageUrl: item.sourcePageUrl, sourcePath: item.path, url: publicUrl(item.key),
  } };
}

export async function runSdkSync(env, runId, { fetchImpl = fetch, now = () => new Date(), attempts = 1 } = {}) {
  const bucket = env.FIRMWARE_BUCKET;
  const run = await readJson(bucket, runKey(runId));
  if (!run) throw new Error("SDK run was not found.");
  if (run.state === "complete") return run;
  const current = await readJson(bucket, SDK_STATUS_KEY);
  if (current?.runId !== runId) return run; // Do not publish a stale queue delivery.
  const publish = async () => {
    await writeJson(bucket, runKey(runId), run);
    await writeJson(bucket, SDK_STATUS_KEY, {
      state: run.state, runId, trigger: run.trigger, startedAt: run.startedAt,
      completedAt: run.completedAt || null, auditKey: runKey(runId),
      summary: run.summary || null, error: run.error || null,
    });
  };
  run.state = "running";
  run.attempts = attempts;
  await publish();
  try {
    if (!run.plan) {
      run.plan = await discoverSdkPlan(env, fetchImpl);
      await publish();
    }
    const manifest = await readJson(bucket, SDK_MANIFEST_KEY, { version: 1, items: {} });
    for (const item of run.plan.items) {
      if (run.results.some((result) => result.id === item.id && result.action !== "failed")) continue;
      const previous = manifest.items[item.id];
      let result;
      try {
        const synced = await syncItem(item, previous, env, fetchImpl, now);
        // Persist pending retirement before attempting deletion, so a retry can
        // finish it even after the manifest points at the replacement filename.
        const retiredKeys = [...new Set([
          ...(previous?.retiredKeys || []),
          ...(previous?.key && previous.key !== synced.entry.key ? [previous.key] : []),
        ])].filter((key) => key !== synced.entry.key && key.startsWith(`${OBJECT_PREFIX}${item.id}/`));
        synced.entry.retiredKeys = retiredKeys;
        manifest.items[item.id] = synced.entry;
        manifest.updatedAt = now().toISOString();
        await writeJson(bucket, SDK_MANIFEST_KEY, manifest);
        // Only retire the old task-owned filename after its replacement is durable.
        if (retiredKeys.length) {
          for (const key of retiredKeys) await bucket.delete(key);
          synced.entry.retiredKeys = [];
          await writeJson(bucket, SDK_MANIFEST_KEY, manifest);
        }
        result = { ...synced.entry, action: synced.action };
      } catch (error) {
        result = { id: item.id, name: item.name, action: "failed", error: errorText(error) };
      }
      run.results = [...run.results.filter((result) => result.id !== item.id), result];
      await publish();
    }
    const failed = run.results.filter((result) => result.action === "failed");
    run.summary = {
      downloaded: run.results.filter((result) => result.action === "downloaded").length,
      unchanged: run.results.filter((result) => result.action === "unchanged").length,
      failed: failed.length,
    };
    if (failed.length) throw new Error(failed.map((result) => `${result.id}: ${result.error}`).join("; "));
    run.state = "complete";
    run.completedAt = now().toISOString();
    run.error = null;
    await publish();
    return run;
  } catch (error) {
    run.state = attempts >= 6 ? "failed" : "retrying";
    run.error = errorText(error);
    await publish();
    throw error;
  }
}
