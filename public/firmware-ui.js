// Firmware jobs run on the existing mobile API; local file uploads are independent.
document.addEventListener("DOMContentLoaded", () => {
  const el = id => document.getElementById(id);
  // The entry can be commented out temporarily without initializing this feature.
  if (!el("firmwareOpen")) return;
  const dialog = el("firmwareDialog");
  const status = el("firmwareStatus");
  const storageKey = "urovo-firmware-task-v1";
  const stageLabels = { queued: "Queued", finding: "Finding firmware", downloading: "Downloading", uploading: "Uploading", succeeded: "Ready", failed: "Failed" };
  let available = false;
  let searching = false;
  let starting = false;
  let polling = false;
  let searchId = "";
  let selection = "";
  let jobId = "";
  let resultFile = null;
  let searchController;

  function show(id, visible) { el(id).classList.toggle("is-hidden", !visible); }
  function setStatus(message, error = false) {
    status.textContent = message;
    status.style.color = error ? "var(--danger)" : "";
  }
  function controls() {
    const busy = searching || starting || polling;
    for (const id of ["firmwareModel", "firmwareDate", "firmwareIndex", "firmwareFind"]) el(id).disabled = busy;
    el("firmwareFind").textContent = searching ? "Finding…" : "Find firmware";
    el("firmwareGet").disabled = busy || !selection;
    el("firmwareGet").textContent = starting ? "Starting…" : "Get selected firmware";
    for (const input of el("firmwareCandidates").querySelectorAll("input")) input.disabled = busy;
  }
  function persist() {
    try {
      if (jobId) sessionStorage.setItem(storageKey, JSON.stringify({ jobId, filename: selection, createdAt: Date.now() }));
      else sessionStorage.removeItem(storageKey);
    } catch { /* Progress still works when browser storage is unavailable. */ }
  }
  async function request(action, { body, signal, timeout = 65000 } = {}) {
    const response = await fetch(`/api/firmware?${action}`, {
      method: body ? "POST" : "GET", cache: "no-store",
      headers: { ...uploaderHeaders(), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal || AbortSignal.timeout(timeout),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const error = new Error(payload.error || "Firmware request failed. Please try again.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function renderProgress(job) {
    show("firmwareProgressArea", true);
    el("firmwareStages").replaceChildren();
    const stages = ["queued", "finding", "downloading", "uploading", "succeeded"];
    const current = stages.indexOf(job.stage);
    stages.forEach((stage, index) => {
      const item = document.createElement("span");
      item.textContent = stageLabels[stage];
      item.style.color = stage === job.stage ? "var(--success)" : index < current ? "var(--accent-light)" : "var(--muted)";
      item.style.fontWeight = stage === job.stage ? "700" : "400";
      el("firmwareStages").appendChild(item);
    });
    const bar = el("firmwareProgress");
    if (job.state === "succeeded") bar.value = 100;
    else if (Number.isFinite(job.percentage)) bar.value = Math.min(100, Math.max(0, job.percentage));
    else bar.removeAttribute("value");
    const metrics = [];
    if (Number.isFinite(job.bytes)) metrics.push(Number.isFinite(job.totalBytes) ? `${formatBytes(job.bytes)} / ${formatBytes(job.totalBytes)}` : formatBytes(job.bytes));
    if (Number.isFinite(job.percentage)) metrics.push(`${job.percentage.toFixed(1)}%`);
    if (Number.isFinite(job.speed)) metrics.push(`${formatBytes(job.speed)}/s`);
    if (Number.isFinite(job.eta)) metrics.push(`~${Math.ceil(job.eta)}s remaining`);
    el("firmwareMetrics").textContent = metrics.join(" · ") || "Waiting for progress details…";
  }

  async function complete(job) {
    if (!job.file?.url || !job.file?.name) throw new Error("The completed file is not ready. Resume checking shortly.");
    resultFile = job.file;
    jobId = "";
    persist();
    polling = false;
    show("firmwareResume", false);
    show("firmwareGet", false);
    show("firmwareResult", true);
    show("firmwareDone", true);
    el("firmwareResultName").textContent = resultFile.name;
    el("firmwareDownload").href = resultFile.url;
    setStatus("Firmware is ready. Its download link has been added to the library.");
    renderProgress({ state: "succeeded", stage: "succeeded", percentage: 100 });
    el("firmwareMetrics").textContent = Number.isFinite(resultFile.size) ? formatBytes(resultFile.size) : "";
    controls();
    showToast("Firmware ready");
    await loadFiles();
  }

  async function poll() {
    if (!jobId || polling) return;
    polling = true;
    controls();
    show("firmwareResume", false);
    let failures = 0;
    const trackedId = jobId;
    try {
      while (jobId === trackedId) {
        try {
          const job = await request(`action=status&id=${encodeURIComponent(trackedId)}`);
          failures = 0;
          renderProgress(job);
          if (job.state === "succeeded") { await complete(job); return; }
          if (job.state === "failed") {
            jobId = ""; persist();
            throw Object.assign(new Error(job.error || "The firmware task failed. Please retry."), { status: 400 });
          }
          if (!["queued", "running"].includes(job.state)) throw Object.assign(new Error("Unknown firmware task state."), { status: 400 });
          setStatus(`${stageLabels[job.stage] || "Working"} · ${job.filename || selection}`);
        } catch (error) {
          if (error.status && ![408, 429, 500, 502, 503, 504, 524].includes(error.status)) throw error;
          if (++failures > 6) throw error;
          setStatus("Connection interrupted. Retrying progress checks…");
          await new Promise(resolve => setTimeout(resolve, Math.min(15000, 1000 * 2 ** failures)));
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      if (error.status === 404) { jobId = ""; persist(); }
      setStatus(`${error.message}${jobId ? " The server task may still be running; use Resume checking." : ""}`, true);
      show("firmwareResume", Boolean(jobId));
    } finally { polling = false; controls(); }
  }

  function invalidateSearch() {
    if (polling || starting) return;
    jobId = ""; persist();
    searchId = ""; selection = "";
    el("firmwareCandidates").replaceChildren();
    show("firmwareGet", false);
    show("firmwareResult", false);
    show("firmwareDone", false);
    show("firmwareProgressArea", false);
    show("firmwareResume", false);
    resultFile = null;
    controls();
  }

  el("uploaderUploadButton").addEventListener("click", async () => {
    available = false;
    show("firmwareOpen", false);
    const token = state.uploaderToken;
    if (!token) return;
    try {
      const config = await request("action=config", { timeout: 10000 });
      if (state.uploaderToken !== token) return;
      available = config.available === true;
      show("firmwareOpen", available);
      el("firmwareOpen").disabled = Boolean(window.uploaderBusy);
    } catch { /* Optional integration stays hidden until configured and authorized. */ }
  });

  el("firmwareOpen").addEventListener("click", () => {
    if (!available || window.uploaderBusy || !state.uploaderToken) return;
    dialog.classList.add("visible");
    if (!el("firmwareDate").value) {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      const value = type => parts.find(part => part.type === type).value;
      el("firmwareDate").value = `${value("year")}-${value("month")}-${value("day")}`;
    }
    if (!jobId && !resultFile) {
      try {
        const stored = JSON.parse(sessionStorage.getItem(storageKey) || "null");
        if (stored && Date.now() - stored.createdAt < 86400000) { jobId = stored.jobId; selection = stored.filename || ""; }
      } catch { /* No resumable task in this browser session. */ }
    }
    if (jobId && !polling) poll();
    else if (!polling) el("firmwareModel").focus();
  });

  el("firmwareForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (searching || starting || polling) return;
    invalidateSearch();
    searching = true; controls();
    searchController = new AbortController();
    const timeout = setTimeout(() => searchController.abort(), 185000);
    setStatus("Searching for matching firmware…");
    try {
      const date = el("firmwareDate").value;
      const params = new URLSearchParams({ action: "find", internal_model: el("firmwareModel").value.trim(), date: date.slice(2).replaceAll("-", ""), index: el("firmwareIndex").value });
      const response = await request(params.toString(), { signal: searchController.signal });
      searchId = response.searchId;
      const files = response.files || [];
      for (const file of files) {
        const label = document.createElement("label");
        label.style.cssText = "display:flex;gap:12px;align-items:flex-start;padding:14px;border:1px solid var(--border);border-radius:12px;cursor:pointer;overflow-wrap:anywhere";
        const input = document.createElement("input"); input.type = "radio"; input.name = "firmwareCandidate"; input.value = file.filename;
        const name = document.createElement("span"); name.textContent = file.filename; name.style.minWidth = "0";
        if (files.length === 1) { input.checked = true; selection = file.filename; }
        input.addEventListener("change", () => { selection = file.filename; controls(); });
        label.append(input, name); el("firmwareCandidates").appendChild(label);
      }
      setStatus(files.length ? `${files.length} matching file${files.length === 1 ? "" : "s"} found. Choose the package to prepare.` : "No firmware matched this model, date and index. Try another combination.");
      show("firmwareGet", files.length > 0);
    } catch (error) { setStatus(error.name === "AbortError" ? "The search was interrupted. Please try again." : error.message, true); }
    finally { clearTimeout(timeout); searching = false; controls(); }
  });

  for (const id of ["firmwareModel", "firmwareDate", "firmwareIndex"]) el(id).addEventListener("input", invalidateSearch);
  el("firmwareGet").addEventListener("click", async () => {
    if (!selection || !searchId || starting || polling) return;
    if (!confirm(`Get ${selection}? The server will download this firmware and make its download link available in the library.`)) return;
    starting = true; controls();
    setStatus("Starting the firmware task…");
    try {
      const job = await request("action=start", { body: { searchId, filename: selection } });
      if (job.state === "succeeded" && job.file) { await complete(job); return; }
      if (!job.jobId) throw new Error("The firmware service did not return a task ID.");
      jobId = job.jobId; persist();
      renderProgress(job);
      if (job.reused) setStatus("Following the existing task for this firmware…");
      starting = false;
      await poll();
    } catch (error) { setStatus(error.message, true); }
    finally { starting = false; controls(); }
  });
  el("firmwareResume").addEventListener("click", poll);
  el("firmwareCopy").addEventListener("click", () => { if (resultFile) copyText(resultFile.url, "Firmware link copied"); });
  function close() {
    if (starting) { setStatus("The task is starting. Please wait for confirmation before closing."); return; }
    if (polling && !confirm("Close this progress view? The server task will continue. Reopen Get Firmware to see its progress.")) return;
    if (searching) searchController?.abort();
    dialog.classList.remove("visible");
    el("firmwareOpen").focus();
  }
  el("firmwareClose").addEventListener("click", close);
  el("firmwareDone").addEventListener("click", () => {
    close();
    el("uploaderDialog").classList.remove("visible");
  });
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } });
});
