const noteInput = document.getElementById("note-input");
const classifyBtn = document.getElementById("classify-btn");
const sampleBtn = document.getElementById("sample-btn");
const clearBtn = document.getElementById("clear-btn");
const statusEl = document.getElementById("status");
const highlightedContainer = document.getElementById("highlighted-text");
const deidentifiedContainer = document.getElementById("deidentified-text");
const tableContainer = document.getElementById("tabular-results");
const btnLabel = document.getElementById("btn-label");
const btnSpinner = document.getElementById("btn-spinner");
const dropZone = document.getElementById("drop-zone");
const processAllBtn = document.getElementById("process-all-btn");
const downloadAllBtn = document.getElementById("download-all-btn");
const fileSelect = document.getElementById("file-select");
const folderInput = document.getElementById("folder-input");
const progressFill = document.getElementById("batch-progress-fill");
const progressLabel = document.getElementById("batch-progress-label");
const singleProgressFill = document.getElementById("single-progress-fill");

let workerDevice = "wasm";
let worker = createWorker(workerDevice);
const deviceSelect = document.getElementById("device-select");

const pendingRequests = new Map();
const batchRecords = [];
let selectedFileId = "";
let fileIdCounter = 0;
let isBatchProcessing = false;
let isManualClassificationRunning = false;
let nextRequestId = 1;

const sampleNote = `Patient Name: John A. Smith
MRN: 12345678
Admitted: Jan 04, 2024
Discharged: Jan 10, 2024

HPI: John is a 54-year-old male referred by Dr. Thompson for evaluation of hypertension. He works as a postal carrier, lives at 2411 Elm Street, Denver, CO, and reports daily alcohol intake. He denies current tobacco use.`;

function createWorker(device) {
  const instance = new Worker(
    new URL("./worker.js", import.meta.url),
    { type: "module" }
  );
  instance.postMessage({ type: "configure", device });
  return instance;
}

function resetWorker(device) {
  worker.terminate();
  worker = createWorker(device);
  workerDevice = device;
  attachWorkerListeners();
}

function attachWorkerListeners() {
  worker.addEventListener("message", handleWorkerMessage);
  worker.addEventListener("error", handleWorkerError);
  worker.addEventListener("messageerror", handleWorkerMessageError);
}

function rejectAllPendingRequests(error) {
  pendingRequests.forEach(({ reject }) => {
    try {
      reject(error);
    } catch (err) {
      console.error(err);
    }
  });
  pendingRequests.clear();
}

function handleWorkerMessage(event) {
  const data = event.data;
  if (!data || typeof data !== "object") {
    return;
  }

  if (data.type === "progress") {
    const entry = pendingRequests.get(data.id);
    if (entry && typeof entry.progress === "function") {
      entry.progress(data.completed, data.total);
    }
    return;
  }

  const entry = pendingRequests.get(data.id);
  if (!entry) {
    return;
  }

  if (data.type === "result") {
    pendingRequests.delete(data.id);
    entry.resolve(Array.isArray(data.spans) ? data.spans : []);
    return;
  }

  if (data.type === "error") {
    pendingRequests.delete(data.id);
    entry.reject(new Error(data.message || "Classification failed."));
  }
}

function handleWorkerError(event) {
  console.error("Classification worker error:", event?.message || event);
  rejectAllPendingRequests(new Error("Classification worker encountered an error."));
}

function handleWorkerMessageError(event) {
  console.error("Classification worker message error:", event?.data);
  rejectAllPendingRequests(new Error("Classification worker received malformed data."));
}

attachWorkerListeners();
worker.postMessage({ type: "configure", device: workerDevice });

function setStatus(message, variant = "info") {
  statusEl.textContent = message;
  statusEl.className = "";
  statusEl.classList.add("show", variant);
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "";
}

function toggleLoading(isLoading) {
  isManualClassificationRunning = isLoading;
  classifyBtn.disabled = isLoading || isBatchProcessing;
  btnSpinner.style.display = isLoading ? "inline-flex" : "none";
  btnLabel.textContent = isLoading ? "Running..." : "Run De-identification";
  updateBatchControls();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HIGHLIGHT_PLACEHOLDER =
  "De-identification highlights will appear here.";
const DEID_PLACEHOLDER = "Run de-identification to see the scrubbed note.";

const LABEL_COLORS = {
  AGE: {
    accent: "#0f766e",
    bg: "rgba(15, 118, 110, 0.18)",
    chipBg: "rgba(15, 118, 110, 0.24)",
    chipColor: "#0f766e",
  },
  DATE: {
    accent: "#2563eb",
    bg: "rgba(37, 99, 235, 0.18)",
    chipBg: "rgba(37, 99, 235, 0.24)",
    chipColor: "#1d4ed8",
  },
  EMAIL: {
    accent: "#7c3aed",
    bg: "rgba(124, 58, 237, 0.18)",
    chipBg: "rgba(124, 58, 237, 0.24)",
    chipColor: "#6d28d9",
  },
  HOSP: {
    accent: "#4338ca",
    bg: "rgba(67, 56, 202, 0.18)",
    chipBg: "rgba(67, 56, 202, 0.24)",
    chipColor: "#3730a3",
  },
  ID: {
    accent: "#f97316",
    bg: "rgba(249, 115, 22, 0.18)",
    chipBg: "rgba(249, 115, 22, 0.24)",
    chipColor: "#c2410c",
  },
  LOC: {
    accent: "#16a34a",
    bg: "rgba(22, 163, 74, 0.18)",
    chipBg: "rgba(22, 163, 74, 0.24)",
    chipColor: "#15803d",
  },
  OTHERPHI: {
    accent: "#e11d48",
    bg: "rgba(225, 29, 72, 0.18)",
    chipBg: "rgba(225, 29, 72, 0.24)",
    chipColor: "#be123c",
  },
  PATIENT: {
    accent: "#d97706",
    bg: "rgba(217, 119, 6, 0.18)",
    chipBg: "rgba(217, 119, 6, 0.24)",
    chipColor: "#b45309",
  },
  PATORG: {
    accent: "#db2777",
    bg: "rgba(219, 39, 119, 0.18)",
    chipBg: "rgba(219, 39, 119, 0.24)",
    chipColor: "#be185d",
  },
  PHONE: {
    accent: "#0284c7",
    bg: "rgba(2, 132, 199, 0.18)",
    chipBg: "rgba(2, 132, 199, 0.24)",
    chipColor: "#0369a1",
  },
  STAFF: {
    accent: "#475569",
    bg: "rgba(71, 85, 105, 0.18)",
    chipBg: "rgba(71, 85, 105, 0.24)",
    chipColor: "#334155",
  },
};

function renderHighlightedText(text, spans) {
  if (!text) {
    highlightedContainer.textContent = HIGHLIGHT_PLACEHOLDER;
    return;
  }

  if (!spans.length) {
    highlightedContainer.textContent = "No protected health information detected.";
    return;
  }

  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let pointer = 0;
  let html = "";

  for (const span of sorted) {
    const { start, end, entity_group } = span;
    const colors = LABEL_COLORS[entity_group] || null;
    const styleAttribute = colors
      ? ` style="--tag-color:${colors.accent};--tag-bg:${colors.bg};--tag-chip-bg:${colors.chipBg};--tag-chip-color:${colors.chipColor};"`
      : "";
    if (start > pointer) {
      html += escapeHtml(text.slice(pointer, start));
    }
    const token = text.slice(start, end);
    html += `<span class="tagged"${styleAttribute} data-entity="${escapeHtml(
      entity_group
    )}"><span class="entity-label">[${escapeHtml(
      entity_group
    )}]</span> ${escapeHtml(token)}</span>`;
    pointer = end;
  }

  if (pointer < text.length) {
    html += escapeHtml(text.slice(pointer));
  }

  highlightedContainer.innerHTML = html;
}

function buildDeidentifiedText(text, spans) {
  if (!text) {
    return "";
  }

  if (!spans.length) {
    return text;
  }

  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let pointer = 0;
  let result = "";

  for (const span of sorted) {
    if (span.start > pointer) {
      result += text.slice(pointer, span.start);
    }
    result += `[${span.entity_group}]`;
    pointer = span.end;
  }

  if (pointer < text.length) {
    result += text.slice(pointer);
  }

  return result;
}

function renderDeidentifiedText(text, spans) {
  if (!text) {
    deidentifiedContainer.textContent = DEID_PLACEHOLDER;
    return;
  }

  if (!spans.length) {
    deidentifiedContainer.textContent = text;
    return;
  }

  deidentifiedContainer.textContent = buildDeidentifiedText(text, spans);
}

function renderTable(spans) {
  if (!spans.length) {
    tableContainer.innerHTML = "";
    return;
  }

  const rows = spans
    .map(
      (span) => `
            <tr>
              <td>${escapeHtml(span.entity_group)}</td>
              <td>${escapeHtml(
                typeof span.word === "string"
                  ? span.word.trim() || span.word
                  : ""
              )}</td>
              <td>${typeof span.score === "number"
                ? `${(span.score * 100).toFixed(2)}%`
                : "—"
              }</td>
              <td>${span.start}</td>
              <td>${span.end}</td>
            </tr>`
    )
    .join("");

  tableContainer.innerHTML = `
          <table class="results-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Token</th>
                <th>Confidence</th>
                <th>Start</th>
                <th>End</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;
}

function requestClassification(text, progressCallback) {
  if (!text) {
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, {
      resolve,
      reject,
      progress: typeof progressCallback === "function" ? progressCallback : null,
    });

    worker.postMessage({
      type: "classify",
      id,
      text,
    });
  });
}

async function classifyText(text, progressCallback) {
  return requestClassification(text, progressCallback);
}

async function runClassification() {
  resetSingleProgress();
  const text = noteInput.value.trim();
  if (!text) {
    setStatus("Please add text to analyze.", "warn");
    return;
  }

  toggleLoading(true);
  setStatus("Loading model weights. This may take a moment...", "info");

  try {
    setStatus("Running inference...", "info");

    const grouped = await classifyText(text, setSingleProgress);
    renderHighlightedText(text, grouped);
    renderDeidentifiedText(text, grouped);
    renderTable(grouped);

    if (selectedFileId) {
      const record = batchRecords.find((item) => item.id === selectedFileId);
      if (record) {
        record.text = text;
        record.spans = grouped;
        record.deidentifiedText = buildDeidentifiedText(text, grouped);
        record.status = grouped.length ? "success" : "no-phi";
        record.error = null;
        updateFileSelectOptions();
        updateBatchControls();
      }
    }

    if (grouped.length) {
      setStatus(
        `Detected ${grouped.length} entity ${grouped.length === 1 ? "span" : "spans"
        }.`,
        "success"
      );
    } else {
      setStatus("No protected health information detected.", "success");
    }
  } catch (error) {
    console.error(error);
    setStatus(
      `Something went wrong: ${error?.message || "Unknown error."}`,
      "error"
    );
    renderHighlightedText("", []);
    renderDeidentifiedText("", []);
    renderTable([]);
  } finally {
    toggleLoading(false);
    resetSingleProgress();
  }
}

function findRecordById(id) {
  return batchRecords.find((record) => record.id === id);
}

function formatRecordStatus(record) {
  switch (record.status) {
    case "processing":
      return "Processing";
    case "success":
      return "Processed";
    case "no-phi":
      return "No PHI";
    case "error":
      return "Error";
    default:
      return "Pending";
  }
}

function updateFileSelectOptions() {
  if (!fileSelect) {
    return;
  }

  const previousSelection = selectedFileId;
  fileSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = batchRecords.length
    ? "Select a file to inspect"
    : "No files loaded";
  fileSelect.appendChild(placeholder);

  for (const record of batchRecords) {
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = `${formatRecordStatus(record)} — ${record.displayName}`;
    if (record.id === previousSelection) {
      option.selected = true;
    }
    fileSelect.appendChild(option);
  }

  fileSelect.disabled = !batchRecords.length;
}

function setBatchProgress(completed, total, labelText) {
  if (!progressFill || !progressLabel) {
    return;
  }

  const safeTotal = Math.max(total, 0);
  const denominator = safeTotal > 0 ? safeTotal : 1;
  const percent = Math.max(
    0,
    Math.min(100, Math.round((completed / denominator) * 100))
  );

  progressFill.style.width = `${percent}%`;
  progressFill.setAttribute("aria-valuenow", String(percent));
  progressLabel.textContent =
    labelText || `Progress: ${percent}%`;
}

function refreshProgressSummary() {
  if (!progressFill || !progressLabel) {
    return;
  }

  const total = batchRecords.length;
  if (!total) {
    setBatchProgress(0, 1, "Idle");
    return;
  }

  const processed = batchRecords.filter(
    (record) => record.status === "success" || record.status === "no-phi"
  ).length;
  const failed = batchRecords.filter((record) => record.status === "error").length;

  if (processed === 0 && failed === 0) {
    setBatchProgress(0, total, `Pending ${total} file${total === 1 ? "" : "s"}`);
    return;
  }

  if (processed === total && failed === 0) {
    setBatchProgress(processed, total, "All files processed");
    return;
  }

  const completed = processed;
  const label = failed
    ? `Processed ${completed}/${total} (with ${failed} error${failed === 1 ? "" : "s"})`
    : `Processed ${completed}/${total}`;
  setBatchProgress(completed, total, label);
}

function updateBatchControls() {
  const hasFiles = batchRecords.length > 0;
  const hasDownloads = batchRecords.some(
    (record) => typeof record.deidentifiedText === "string" && record.deidentifiedText.length
  );

  if (processAllBtn) {
    processAllBtn.disabled =
      !hasFiles || isBatchProcessing || isManualClassificationRunning;
  }

  if (downloadAllBtn) {
    downloadAllBtn.disabled =
      !hasDownloads || isBatchProcessing || isManualClassificationRunning;
  }

  if (fileSelect) {
    fileSelect.disabled = !hasFiles;
  }

  classifyBtn.disabled = isBatchProcessing || isManualClassificationRunning;

  if (!isBatchProcessing) {
    refreshProgressSummary();
  }
}

function setSingleProgress(completed, total) {
  if (!singleProgressFill) {
    return;
  }

  const safeTotal = Math.max(total, 0);
  const denominator = safeTotal > 0 ? safeTotal : 1;
  const percent = Math.max(
    0,
    Math.min(100, Math.round((completed / denominator) * 100))
  );

  singleProgressFill.style.width = `${percent}%`;
  singleProgressFill.setAttribute("aria-valuenow", String(percent));
}

function resetSingleProgress() {
  setSingleProgress(0, 1);
}

function resetHighlights() {
  renderHighlightedText("", []);
  deidentifiedContainer.textContent = DEID_PLACEHOLDER;
  tableContainer.innerHTML = "";
}

function displaySelectedRecord() {
  if (!selectedFileId) {
    return;
  }

  const record = findRecordById(selectedFileId);
  if (!record) {
    selectedFileId = "";
    updateFileSelectOptions();
    updateBatchControls();
    resetHighlights();
    return;
  }

  noteInput.value = record.text;

  if (Array.isArray(record.spans)) {
    renderHighlightedText(record.text, record.spans);
    renderDeidentifiedText(record.text, record.spans);
    renderTable(record.spans);
  } else {
    highlightedContainer.textContent =
      "Run batch processing to see highlighted spans.";
    deidentifiedContainer.textContent =
      "Process this file to generate the de-identified note.";
    tableContainer.innerHTML = "";
  }
}

function setSelectedRecord(recordId) {
  selectedFileId = recordId || "";
  updateFileSelectOptions();
  displaySelectedRecord();
  updateBatchControls();

  if (selectedFileId) {
    const record = findRecordById(selectedFileId);
    if (record) {
      const variant =
        record.status === "error"
          ? "error"
          : record.status === "success" || record.status === "no-phi"
          ? "success"
          : "info";
      setStatus(`Inspecting ${record.displayName}.`, variant);
    }
  }
}

async function ingestFiles(fileList) {
  if (!Array.isArray(fileList) || !fileList.length) {
    setStatus("No files detected. Drop .txt files to begin.", "warn");
    return;
  }

  const txtFiles = fileList.filter(
    (file) => file && file.name && file.name.toLowerCase().endsWith(".txt")
  );

  if (!txtFiles.length) {
    setStatus("No .txt files detected in the batch.", "warn");
    return;
  }

  let added = 0;
  let refreshed = 0;

  for (const file of txtFiles) {
    try {
      const text = await file.text();
      const displayName =
        file.relativePath ||
        file.webkitRelativePath ||
        file.path ||
        file.name;

      const existing = batchRecords.find(
        (record) => record.displayName === displayName
      );

      if (existing) {
        existing.text = text;
        existing.spans = null;
        existing.deidentifiedText = "";
        existing.status = "pending";
        existing.error = null;
        refreshed += 1;
      } else {
        batchRecords.push({
          id: `file-${fileIdCounter++}`,
          name: file.name,
          displayName,
          text,
          spans: null,
          deidentifiedText: "",
          status: "pending",
          error: null,
        });
        added += 1;
      }
    } catch (error) {
      console.error("Failed to read file", file?.name, error);
      setStatus(
        `Failed to read ${file?.name || "one file"}: ${
          error?.message || "Unknown error"
        }`,
        "error"
      );
    }
  }

  if (!selectedFileId && batchRecords.length) {
    selectedFileId = batchRecords[batchRecords.length - 1].id;
  }

  updateFileSelectOptions();
  updateBatchControls();
  displaySelectedRecord();

  if (added || refreshed) {
    const details = [];
    if (added) {
      details.push(`${added} added`);
    }
    if (refreshed) {
      details.push(`${refreshed} refreshed`);
    }
    setStatus(`Batch updated (${details.join(", ")}).`, "success");
  } else {
    setStatus("Batch already up to date.", "info");
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function triggerDownload(record) {
  const safeName = record.displayName.replace(/[/\\]/g, "_");
  const filename = safeName.endsWith(".txt")
    ? safeName.replace(/\.txt$/i, "_deidentified.txt")
    : `${safeName}_deidentified.txt`;

  const blob = new Blob([record.deidentifiedText], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  requestAnimationFrame(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });
}

async function downloadAllDeidentified() {
  const processed = batchRecords.filter(
    (record) =>
      typeof record.deidentifiedText === "string" &&
      record.deidentifiedText.length
  );

  if (!processed.length) {
    setStatus("No processed files available to download yet.", "warn");
    return;
  }

  setStatus(
    `Starting downloads for ${processed.length} file${processed.length === 1 ? "" : "s"}...`,
    "info"
  );

  const chunkSize = 5;
  for (let index = 0; index < processed.length; index += chunkSize) {
    const chunk = processed.slice(index, index + chunkSize);
    chunk.forEach(triggerDownload);

    if (index + chunkSize < processed.length) {
      await wait(1000);
    }
  }

  setStatus(
    `Downloads initiated for ${processed.length} file${processed.length === 1 ? "" : "s"}.`,
    "success"
  );
}

async function processAllFiles() {
  if (!batchRecords.length) {
    setStatus("Add .txt files before running batch processing.", "warn");
    return;
  }

  if (isManualClassificationRunning) {
    setStatus("Finish the current classification run before processing all files.", "warn");
    return;
  }

  isBatchProcessing = true;
  updateBatchControls();

  try {
    const total = batchRecords.length;
    let processedCount = 0;

    setBatchProgress(0, total || 1, total ? `Processing 0/${total}` : "Processing...");

    for (let index = 0; index < batchRecords.length; index += 1) {
      const record = batchRecords[index];
      record.status = "processing";
      updateFileSelectOptions();
      updateBatchControls();

      setStatus(
        `Processing ${record.displayName} (${index + 1}/${batchRecords.length})...`,
        "info"
      );

      try {
        const spans = await classifyText(record.text);
        record.spans = spans;
        record.deidentifiedText = buildDeidentifiedText(record.text, spans);
        record.status = spans.length ? "success" : "no-phi";
        record.error = null;
        processedCount += 1;

        if (selectedFileId === record.id) {
          renderHighlightedText(record.text, spans);
          renderDeidentifiedText(record.text, spans);
          renderTable(spans);
          noteInput.value = record.text;
        }
      } catch (error) {
        console.error(`Failed to process ${record.displayName}`, error);
        record.status = "error";
        record.error = error?.message || "Unknown error";
      }

      updateFileSelectOptions();
      updateBatchControls();
      setBatchProgress(
        index + 1,
        total,
        `Processing ${Math.min(index + 1, total)}/${total}`
      );
    }

    const failed = batchRecords.filter((record) => record.status === "error").length;
    if (failed) {
      setStatus(
        `Processed ${processedCount} of ${batchRecords.length} files. ${failed} failed.`,
        "warn"
      );
      setBatchProgress(
        total,
        total,
        `Completed with ${failed} error${failed === 1 ? "" : "s"}`
      );
    } else {
      setStatus(
        `Processed ${batchRecords.length} file${batchRecords.length === 1 ? "" : "s"}.`,
        "success"
      );
      setBatchProgress(
        total,
        total,
        batchRecords.length === 1 ? "Processing complete" : "All files processed"
      );
    }
  } catch (error) {
    console.error("Batch processing failed", error);
    setStatus(error?.message || "Batch processing failed.", "error");
    setBatchProgress(0, 1, "Processing failed");
  } finally {
    isBatchProcessing = false;
    updateFileSelectOptions();
    updateBatchControls();
    displaySelectedRecord();
  }
}


async function readEntries(reader) {
  const entries = [];

  async function readBatch() {
    return new Promise((resolve, reject) => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve();
            return;
          }

          entries.push(...batch);
          readBatch().then(resolve).catch(reject);
        },
        (error) => reject(error)
      );
    });
  }

  await readBatch();
  return entries;
}

async function traverseFileEntry(entry, currentPath = entry.name) {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      entry.file(
        (file) => {
          try {
            file.relativePath = currentPath;
          } catch {
            // Ignore if property is read-only
          }
          resolve([file]);
        },
        (error) => reject(error)
      );
    });
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await readEntries(reader);
    const files = [];

    for (const child of entries) {
      const childPath = `${currentPath}/${child.name}`;
      const childFiles = await traverseFileEntry(child, childPath);
      files.push(...childFiles);
    }

    return files;
  }

  return [];
}

async function extractFilesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) {
    return [];
  }

  const files = [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];

  if (items.length) {
    for (const item of items) {
      if (item.kind !== "file") {
        continue;
      }

      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        const entryFiles = await traverseFileEntry(entry, entry.name);
        files.push(...entryFiles);
      } else {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
  } else if (dataTransfer.files && dataTransfer.files.length) {
    files.push(...Array.from(dataTransfer.files));
  }

  return files;
}

classifyBtn.addEventListener("click", runClassification);

sampleBtn.addEventListener("click", () => {
  noteInput.value = sampleNote;
  clearStatus();
  highlightedContainer.textContent = HIGHLIGHT_PLACEHOLDER;
  deidentifiedContainer.textContent = DEID_PLACEHOLDER;
  tableContainer.innerHTML = "";
});

clearBtn.addEventListener("click", () => {
  noteInput.value = "";
  clearStatus();
  renderHighlightedText("", []);
  renderDeidentifiedText("", []);
  renderTable([]);
});

noteInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "enter") {
    event.preventDefault();
    runClassification();
  }
});

if (processAllBtn) {
  processAllBtn.addEventListener("click", () => {
    processAllFiles();
  });
}

if (downloadAllBtn) {
  downloadAllBtn.addEventListener("click", () => {
    downloadAllDeidentified();
  });
}

if (fileSelect) {
  fileSelect.addEventListener("change", (event) => {
    setSelectedRecord(event.target.value);
  });
}

if (dropZone) {
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });

  dropZone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });

  dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    const files = await extractFilesFromDataTransfer(event.dataTransfer);
    await ingestFiles(files);
  });

  dropZone.addEventListener("click", () => {
    if (folderInput) {
      folderInput.click();
    }
  });

  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (folderInput) {
        folderInput.click();
      }
    }
  });
}

if (folderInput) {
  folderInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    await ingestFiles(files);
    folderInput.value = "";
  });
}

updateFileSelectOptions();
updateBatchControls();
if (deviceSelect) {
  deviceSelect.addEventListener("change", (event) => {
    const device = event.target.value === "webgpu" ? "webgpu" : "wasm";
    if (device !== workerDevice) {
      resetWorker(device);
      setStatus(`Switched device to ${device.toUpperCase()}.`, "info");
    }
  });
}
