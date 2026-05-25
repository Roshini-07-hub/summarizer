import "./styles.css";

const API_BASE = (import.meta.env.VITE_API_BASE || "https://summarizer-backend-xi.vercel.app") + "/api";

const fields = {
  text: document.getElementById("textInput"),
  file: document.getElementById("fileInput"),
  fileDescription: document.getElementById("fileDescription"),
  url: document.getElementById("urlInput"),
  video: document.getElementById("videoInput"),
  videoDescription: document.getElementById("videoDescription"),
  audio: document.getElementById("audioInput"),
  audioDescription: document.getElementById("audioDescription"),
};

const buttons = {
  text: document.getElementById("textSummaryButton"),
  file: document.getElementById("fileSummaryButton"),
  url: document.getElementById("urlSummaryButton"),
  video: document.getElementById("videoSummaryButton"),
  audio: document.getElementById("audioSummaryButton"),
  search: document.getElementById("searchButton"),
  copy: document.getElementById("copyButton"),
  deleteSummary: document.getElementById("deleteSummaryButton"),
  viewRecords: document.getElementById("viewRecordsButton"),
};

const summaryOutput = document.getElementById("summaryOutput");
const summaryMeta = document.getElementById("summaryMeta");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const messageBox = document.getElementById("message");
let currentSummaryId = null;

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

const showMessage = (text, isError = false) => {
  messageBox.textContent = text;
  messageBox.className = isError ? "alert" : "alert success";
  messageBox.classList.toggle("hidden", !text);
};

const renderRecords = (records) => {
  const container = document.getElementById("searchResults");
  if (!records || !records.length) {
    container.innerHTML = "<div>No saved records found.</div>";
    return;
  }

  container.innerHTML = records
    .map((r) => {
      const md = r.metadata || r;
      const title = md.title || md.fileName || "Saved summary";
      return `<article class="result-item" data-summary-id="${escapeHtml(r.id || "")}"><div class="result-header"><h3>${escapeHtml(title)}</h3><button class="delete-record-button danger-button" data-summary-id="${escapeHtml(r.id || "")}">Delete</button></div><p>${escapeHtml(md.summary || "")}</p><small>${escapeHtml(md.sourceDomain || md.fileUrl || "")}</small></article>`;
    })
    .join("");
};

const getHeaders = () => ({ "Content-Type": "application/json" });

const readFileData = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

const readFileText = async (file) => {
  const textTypes = [
    "application/json",
    "application/xml",
    "application/javascript",
    "text/",
  ];
  const textExtensions = /\.(txt|md|csv|json|xml|html|css|js|ts|jsx|tsx|log|yml|yaml)$/i;
  const isReadableText = textTypes.some((type) => file.type.startsWith(type)) || textExtensions.test(file.name);

  if (!isReadableText) return "";

  try {
    return (await file.text()).trim();
  } catch (error) {
    return "";
  }
};

const summarize = async (body, button, emptyMessage) => {
  if (!body) {
    showMessage(emptyMessage, true);
    return;
  }

  button.disabled = true;
  button.textContent = "Summarizing...";

  try {
    const response = await fetch(`${API_BASE}/summarize`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    const contentType = response.headers.get("content-type") || "";
    let result;
    if (contentType.includes("application/json")) {
      result = await response.json();
    } else {
      const text = await response.text();
      // If server returned HTML (unexpected), show the text as error
      if (!response.ok) throw new Error(text || `Unexpected response: ${response.status} ${response.statusText}`);
      // try to parse JSON fallback
      try {
        result = JSON.parse(text);
      } catch (err) {
        result = { metadata: { summary: text } };
      }
    }
    if (!response.ok) throw new Error(result.error || "Summarization failed.");
    currentSummaryId = result.id || null;
    setSummary(result.metadata || {});
    if (buttons.deleteSummary) buttons.deleteSummary.disabled = !currentSummaryId;
    showMessage("Summary generated.");
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.label;
  }
};

const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB — Groq Whisper limit

const fileBody = async (input, descriptionInput, source) => {
  const file = input.files?.[0];
  if (!file) return null;

  const isMedia = source === "audio" || source === "video";

  if (isMedia && file.size > MAX_MEDIA_BYTES) {
    showMessage(
      `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size for audio/video is 25 MB.`,
      true,
    );
    return null;
  }

  const content = source === "file" ? await readFileText(file) : "";
  let fileData = null;
  if (isMedia) {
    fileData = await readFileData(file);
    if (!fileData) {
      showMessage("Failed to read the media file. Please try again.", true);
      return null;
    }
  }

  return {
    content,
    fileData,
    fileName: file.name,
    fileType: file.type || source,
    fileSize: file.size,
    description: descriptionInput.value.trim(),
    source,
  };
};

const setSummary = (data) => {
  const typeMap = {
    file: "File Summary",
    url: "URL Summary",
    text: "Text Summary",
  };

  summaryOutput.textContent = data.summary || "";
  summaryMeta.innerHTML = "";

  const typeLabel = typeMap[data.summaryType] || "Summary";
  summaryMeta.insertAdjacentHTML("beforeend", `<div class="summary-type">${typeLabel}</div>`);

  if (data.title) summaryMeta.insertAdjacentHTML("beforeend", `<strong>${data.title}</strong>`);
  if (data.fileName) summaryMeta.insertAdjacentHTML("beforeend", `<span>${data.fileName}</span>`);
  if (data.sourceDomain) summaryMeta.insertAdjacentHTML("beforeend", `<span>${data.sourceDomain}</span>`);
  if (data.wordCount) summaryMeta.insertAdjacentHTML("beforeend", `<span>${data.wordCount} words</span>`);
  if (data.readTimeMinutes) summaryMeta.insertAdjacentHTML("beforeend", `<span>${data.readTimeMinutes} min read</span>`);
  if (data.bullets?.length) {
    summaryMeta.insertAdjacentHTML(
      "beforeend",
      `<ul>${data.bullets.map((bullet) => `<li>${bullet}</li>`).join("")}</ul>`,
    );
  }
};

const handleTextSummary = () => {
  const content = fields.text.value.trim();
  summarize(content ? { content, source: "text" } : null, buttons.text, "Paste text to summarize.");
};

const handleFileSummary = async () => {
  summarize(await fileBody(fields.file, fields.fileDescription, "file"), buttons.file, "Choose a file to summarize.");
};

const handleUrlSummary = () => {
  const url = fields.url.value.trim();
  summarize(url ? { url, source: "url" } : null, buttons.url, "Enter a URL to summarize.");
};

const handleVideoSummary = async () => {
  summarize(await fileBody(fields.video, fields.videoDescription, "video"), buttons.video, "Choose a video to summarize.");
};

const handleAudioSummary = async () => {
  summarize(await fileBody(fields.audio, fields.audioDescription, "audio"), buttons.audio, "Choose an audio file to summarize.");
};

const handleSearch = async () => {
  const query = searchInput.value.trim();
  if (!query) {
    showMessage("Enter a search query.", true);
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/search`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ query }),
    });

    const contentType = response.headers.get("content-type") || "";
    let result;
    if (contentType.includes("application/json")) {
      result = await response.json();
    } else {
      const text = await response.text();
      if (!response.ok) throw new Error(text || `Unexpected response: ${response.status} ${response.statusText}`);
      try {
        result = JSON.parse(text);
      } catch (err) {
        result = { matches: [] };
      }
    }
    if (!response.ok) throw new Error(result.error || "Search failed.");

    searchResults.innerHTML = result.matches
      .map((item) => {
        const typeLabel = item.metadata?.summaryType ? `${item.metadata.summaryType} summary` : "summary";
        const source = item.metadata?.url || item.metadata?.fileName || "Saved content";
        return `<article class="result-item" data-summary-id="${escapeHtml(item.id || "")}"><div class="result-header"><div><div class="search-type-badge">${escapeHtml(typeLabel)}</div><strong>Score:</strong> ${escapeHtml(item.score?.toFixed(3) || "0")}</div><button class="delete-record-button danger-button" data-summary-id="${escapeHtml(item.id || "")}">Delete</button></div><h3>${escapeHtml(item.metadata?.title || "Saved summary")}</h3><p>${escapeHtml(item.metadata?.summary || "")}</p><small>${escapeHtml(source)}</small></article>`;
      })
      .join("");
    showMessage("Search completed.");
  } catch (error) {
    showMessage(error.message, true);
  }
};

const deleteSummary = async (id) => {
  if (!id) {
    showMessage("No saved summary selected to delete.", true);
    return false;
  }

  const response = await fetch(`${API_BASE}/summary/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: getHeaders(),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Delete failed.");
  return true;
};

const handleViewRecords = async () => {
  try {
    const response = await fetch(`${API_BASE}/local-records`);
    const contentType = response.headers.get("content-type") || "";
    let result;
    if (contentType.includes("application/json")) result = await response.json();
    else result = { records: [] };

    if (!response.ok) throw new Error(result.error || "Failed to fetch records.");
    renderRecords(result || []);
    showMessage("Loaded saved records.");
  } catch (err) {
    showMessage(err.message, true);
  }
};

Object.values(buttons).forEach((button) => {
  if (button) button.dataset.label = button.textContent;
});

buttons.text.addEventListener("click", handleTextSummary);
buttons.file.addEventListener("click", handleFileSummary);
buttons.url.addEventListener("click", handleUrlSummary);
buttons.video.addEventListener("click", handleVideoSummary);
buttons.audio.addEventListener("click", handleAudioSummary);
buttons.search.addEventListener("click", handleSearch);
buttons.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(summaryOutput.textContent);
    showMessage("Summary copied to clipboard.");
  } catch (error) {
    showMessage("Copy failed.", true);
  }
});
if (buttons.deleteSummary) {
  buttons.deleteSummary.addEventListener("click", async () => {
    try {
      const deleted = await deleteSummary(currentSummaryId);
      if (!deleted) return;
      currentSummaryId = null;
      summaryOutput.textContent = "";
      summaryMeta.innerHTML = "";
      buttons.deleteSummary.disabled = true;
      showMessage("Summary deleted.");
    } catch (error) {
      showMessage(error.message, true);
    }
  });
}
searchResults.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(".delete-record-button");
  if (!deleteButton) return;

  try {
    const id = deleteButton.dataset.summaryId;
    const deleted = await deleteSummary(id);
    if (!deleted) return;
    deleteButton.closest(".result-item")?.remove();
    if (currentSummaryId === id) {
      currentSummaryId = null;
      summaryOutput.textContent = "";
      summaryMeta.innerHTML = "";
      if (buttons.deleteSummary) buttons.deleteSummary.disabled = true;
    }
    showMessage("Summary deleted.");
  } catch (error) {
    showMessage(error.message, true);
  }
});
if (buttons.viewRecords) buttons.viewRecords.addEventListener("click", handleViewRecords);
