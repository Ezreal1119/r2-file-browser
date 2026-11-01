// Kept separate from the existing library and Admin controls.
function createUploadTuning(now = () => performance.now()) {
  let limit = 3;
  let ceiling = 4;
  let successes = 0;
  let nextProbeAt = 0;
  let windowStart = null;
  let windowBytes = 0;
  let probe = null;
  return {
    get limit() { return limit; },
    completedPart() { successes++; },
    retried() {
      limit = Math.max(2, limit - 1);
      probe = null;
      successes = 0;
      nextProbeAt = now() + 30000;
      windowStart = null;
    },
    sample(bytes, remaining) {
      const time = now();
      // A draining queue or a suspended browser tab cannot provide a fair comparison.
      if (remaining < limit + 2 || windowStart === null || time - windowStart > 30000) {
        windowStart = time;
        windowBytes = bytes;
        return;
      }
      const elapsed = time - windowStart;
      if (elapsed < 10000) return;
      const delta = Math.max(0, bytes - windowBytes);
      const rate = delta / elapsed;
      windowStart = time;
      windowBytes = bytes;
      if (probe) {
        if (rate < probe.rate * 1.1) {
          limit = probe.previous;
          ceiling = limit;
        }
        probe = null;
        successes = 0;
        nextProbeAt = time + 30000;
      } else if (time >= nextProbeAt && successes >= 2 && delta >= 256 * 1024 && limit < ceiling) {
        probe = { previous: limit, rate };
        limit++;
        successes = 0;
      }
    },
  };
}

function createUploadSpeedMeter(now = () => performance.now()) {
  const samples = [];
  return {
    sample(bytes) {
      const time = now();
      samples.push({ time, bytes });
      while (samples.length > 1 && samples[0].time < time - 8000) samples.shift();
      const first = samples[0];
      const elapsed = (time - first.time) / 1000;
      return elapsed >= 1 ? Math.max(0, bytes - first.bytes) / elapsed : 0;
    },
  };
}

function uploadRetryDelay(error, attempt, random = Math.random) {
  const status = Number(error.status || 0);
  if (status && status !== 408 && status !== 429 && (status < 500 || status >= 600)) return null;
  const header = error.retryAfter;
  const seconds = header ? Number(header) : NaN;
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : header ? Date.parse(header) - Date.now() : 0;
  const backoff = 1000 * 2 ** attempt * (0.8 + random() * 0.4);
  return Math.min(30000, Math.max(backoff, Number.isFinite(requested) ? requested : 0));
}

document.addEventListener("DOMContentLoaded", () => {
  const el = id => document.getElementById(id);
  const dialog = el("uploaderDialog");
  const status = el("uploaderStatus");
  const start = el("uploaderStart");
  const picker = el("uploaderFile");
  const description = el("uploaderDescription");
  let file = null;
  let session = null;
  let parts = [];
  let stopped = false;
  const requests = new Set();
  const inFlight = new Map();
  let timer;
  let finishing = false;
  let closing = false;
  let runController;
  let wireBytes = 0;
  let retryNotBefore = 0;
  let tuning;
  let speedMeter;

  function updateDescriptionCount() {
    el("uploaderDescriptionCount").textContent = `${description.value.length} / 1500`;
    start.disabled = Boolean(window.uploaderBusy) || !file || description.value.length > 1500;
  }

  function busy(value) {
    window.uploaderBusy = value;
    description.disabled = value;
    updateDescriptionCount();
    picker.disabled = value;
    const firmwareEntry = document.getElementById("firmwareOpen");
    if (firmwareEntry) firmwareEntry.disabled = value;
  }

  function showSelectedFile() {
    const selected = Boolean(file);
    el("uploaderEmptyState").classList.toggle("is-hidden", selected);
    el("uploaderChosenState").classList.toggle("is-hidden", !selected);
    if (selected) {
      el("uploaderFilename").textContent = file.name;
      el("uploaderFilesize").textContent = formatBytes(file.size);
    }
  }

  function resetDialog() {
    file = null;
    session = null;
    parts = [];
    stopped = false;
    finishing = false;
    picker.value = "";
    description.value = "";
    inFlight.clear();
    el("uploaderProgress").value = 0;
    el("uploaderProgressArea").classList.add("is-hidden");
    start.textContent = "Upload";
    showSelectedFile();
    busy(false);
  }

  function progress() {
    if (!file || !session) return;
    const done = parts.reduce((sum, part, i) => sum + (part ? Math.min(session.partSize, file.size - i * session.partSize) : 0), 0);
    const transferred = Math.min(file.size, done + [...inFlight.values()].reduce((a, b) => a + b, 0));
    const speed = speedMeter.sample(wireBytes);
    tuning.sample(wireBytes, parts.filter(part => !part).length);
    const percent = Math.min(100, transferred / file.size * 100);
    el("uploaderProgress").value = percent;
    status.textContent = `${percent.toFixed(1)}% · ${formatBytes(transferred)} / ${formatBytes(file.size)} · ${formatBytes(speed)}/s${speed > 0 ? ` · ~${Math.ceil((file.size - transferred) / speed)}s remaining` : ""}`;
  }

  async function api(action, method, body) {
    const response = await fetch(`/api/uploader-upload?${action}`, {
      method, headers: { "Content-Type": "application/json", ...uploaderHeaders() },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || "Upload failed"); error.status = response.status; error.retryAfter = response.headers.get("Retry-After"); throw error; }
    return data;
  }

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitForRetry(ms) {
    const signal = runController.signal;
    if (signal.aborted) throw new Error("Upload paused.");
    await new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener("abort", cancel); resolve(); };
      const timeout = setTimeout(finish, ms);
      const cancel = () => { clearTimeout(timeout); reject(new Error("Upload paused.")); };
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  async function retry(fn, partTransfer = false) {
    for (let attempt = 0; ; attempt++) {
      if (stopped) throw new Error("Upload paused.");
      try { return await fn(); } catch (error) {
        const pause = uploadRetryDelay(error, attempt);
        if (stopped || attempt >= 3 || pause === null) throw error;
        if (partTransfer) {
          tuning.retried();
          if (error.status === 429 || error.retryAfter) {
            retryNotBefore = Math.max(retryNotBefore, performance.now() + pause);
          }
        }
        await waitForRetry(pause);
      }
    }
  }

  function sendPart(index) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      requests.add(xhr);
      xhr.open("PUT", `/api/uploader-upload?id=${session.id}&part=${index + 1}`);
      xhr.setRequestHeader("X-Uploader-Token", state.uploaderToken);
      let sent = 0;
      const recordBytes = loaded => {
        const current = Math.min(loaded, Math.min(session.partSize, file.size - index * session.partSize));
        wireBytes += Math.max(0, current - sent);
        sent = Math.max(sent, current);
        inFlight.set(index, current);
      };
      // Reset an inactivity timer on progress, not a short total-duration timeout.
      let watchdog;
      const watch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => xhr.abort(), 120000); };
      const cleanup = () => { clearTimeout(watchdog); requests.delete(xhr); inFlight.delete(index); };
      xhr.upload.onprogress = event => { recordBytes(event.loaded); watch(); };
      xhr.onload = () => {
        cleanup();
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && data.partNumber === index + 1 && typeof data.etag === "string") {
          recordBytes(Math.min(session.partSize, file.size - index * session.partSize));
          inFlight.delete(index);
          resolve(data);
        } else { const error = new Error(data.error || "Part upload failed"); error.status = xhr.status >= 200 && xhr.status < 300 ? 502 : xhr.status; error.retryAfter = xhr.getResponseHeader("Retry-After"); reject(error); }
      };
      xhr.onerror = xhr.onabort = () => { cleanup(); reject(new Error("Connection interrupted. Retry to continue uploaded parts.")); };
      watch();
      xhr.send(file.slice(index * session.partSize, Math.min(file.size, (index + 1) * session.partSize)));
    });
  }

  function choose(selected) {
    if (window.uploaderBusy || session || !selected) return;
    if (!selected.size || selected.size > 5 * 1024 ** 3) { status.textContent = "Choose a file between 1 byte and 5 GiB."; return; }
    file = selected;
    showSelectedFile();
    el("uploaderProgress").value = 0;
    el("uploaderProgressArea").classList.add("is-hidden");
    start.textContent = "Upload";
    busy(false);
  }

  start.addEventListener("click", async () => {
    if (!file || window.uploaderBusy) return;
    if (description.value.length > 1500) { description.focus(); return; }
    const uploadDescription = description.value.trim();
    stopped = false;
    runController = new AbortController();
    tuning = createUploadTuning();
    speedMeter = createUploadSpeedMeter();
    wireBytes = 0;
    retryNotBefore = 0;
    speedMeter.sample(0);
    busy(true);
    el("uploaderProgressArea").classList.remove("is-hidden");
    start.textContent = "Uploading…";
    status.textContent = "Preparing upload…";
    try {
      if (!session) {
        session = await api("action=start", "POST", { name: file.name, size: file.size });
        parts = new Array(Math.ceil(file.size / session.partSize)).fill(null);
      }
      if (stopped) throw new Error("Upload paused.");
      timer = setInterval(progress, 400);
      const pending = parts.map((p, i) => p ? -1 : i).filter(i => i >= 0);
      let cursor = 0;
      let active = 0;
      let firstError;
      const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
        try {
          while (cursor < pending.length && !stopped) {
            const index = pending[cursor++];
            parts[index] = await retry(async () => {
              // Reductions let existing requests finish; only new attempts wait.
              while (active >= tuning.limit || performance.now() < retryNotBefore) await waitForRetry(100);
              if (stopped) throw new Error("Upload paused.");
              active++;
              try { return await sendPart(index); }
              finally { active--; }
            }, true);
            tuning.completedPart();
          }
        } catch (error) {
          firstError ||= error;
          stopped = true;
          runController.abort();
          for (const request of requests) request.abort();
          throw error;
        }
      });
      const results = await Promise.allSettled(workers);
      const failed = results.find(r => r.status === "rejected");
      if (failed) throw firstError || failed.reason;
      if (stopped) throw new Error("Upload paused.");
      clearInterval(timer);
      progress();
      status.textContent = "Finalizing upload… Please keep this page open.";
      finishing = true;
      // Completion is idempotent, so a lost response is safe to retry.
      await retry(() => api(`action=complete&id=${session.id}`, "POST", { parts, description: uploadDescription }));
      el("uploaderProgress").value = 100;
      await loadFiles();
      showToast("File uploaded");
      resetDialog();
      dialog.classList.remove("visible");
    } catch (error) {
      status.textContent = error.message + " Keep this page open to retry without resending completed parts.";
      start.textContent = "Retry upload";
    } finally {
      finishing = false;
      clearInterval(timer);
      busy(false);
    }
  });

  async function discardAndClose() {
    if (closing) return;
    if (finishing) {
      status.textContent = "Finalizing the upload. Please keep this page open.";
      return;
    }
    const uploadStarted = Boolean(session || window.uploaderBusy);
    if (uploadStarted && !confirm("Cancel this upload? Uploaded parts will be permanently discarded.")) return;
    closing = true;
    stopped = true;
    runController?.abort();
    for (const xhr of requests) xhr.abort();
    while (window.uploaderBusy) await delay(100);
    if (session) {
      busy(true);
      try { await api(`id=${session.id}`, "DELETE"); }
      catch (error) { status.textContent = `${error.message} Try closing again.`; busy(false); closing = false; return; }
    }
    resetDialog();
    dialog.classList.remove("visible");
    closing = false;
  }

  el("uploaderUploadButton").addEventListener("click", () => {
    if (!state.uploaderToken) return;
    if (window.uploaderBusy || session) { dialog.classList.add("visible"); return; }
    resetDialog();
    dialog.classList.add("visible");
  });
  el("uploaderClose").addEventListener("click", discardAndClose);
  el("uploaderDrop").addEventListener("click", () => { if (!window.uploaderBusy && !session) picker.click(); });
  el("uploaderDrop").addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!window.uploaderBusy && !session) picker.click(); }
  });
  picker.addEventListener("change", () => choose(picker.files[0]));
  description.addEventListener("input", updateDescriptionCount);
  for (const name of ["dragover", "drop"]) el("uploaderDrop").addEventListener(name, event => {
    event.preventDefault();
    if (name === "drop") choose(event.dataTransfer.files[0]);
  });
  window.addEventListener("beforeunload", event => {
    if (window.uploaderBusy || session) { event.preventDefault(); event.returnValue = ""; }
  });
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); discardAndClose(); } });
});
