const backendUrlInput = document.getElementById("backendUrl");
const apiKeyInput = document.getElementById("apiKey");
const authTokenInput = document.getElementById("authToken");
const manualText = document.getElementById("manualText");
const status = document.getElementById("status");
const result = document.getElementById("result");
const summarizePageButton = document.getElementById("summarizePage");
const summarizeTextButton = document.getElementById("summarizeText");

const getHeaders = () => {
  const headers = { "Content-Type": "application/json" };
  if (apiKeyInput.value) headers["x-api-key"] = apiKeyInput.value;
  if (authTokenInput.value) headers["Authorization"] = `Bearer ${authTokenInput.value}`;
  return headers;
};

const showStatus = (message, isError = false) => {
  status.textContent = message;
  status.style.color = isError ? "#b91c1c" : "#065f46";
};

const showResult = (text) => {
  result.textContent = text;
};

const fetchSummary = async (payload) => {
  showStatus("Summarizing...");
  showResult("");

  try {
    const response = await fetch(`${backendUrlInput.value}/api/summarize`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to summarize this content.");
    }

    const summaryText = data.metadata?.summary || "No summary returned.";
    const title = data.metadata?.title ? `Title: ${data.metadata.title}\n\n` : "";
    showResult(`${title}${summaryText}`);
    showStatus("Summary generated successfully.");
  } catch (error) {
    showStatus(error.message, true);
  }
};

summarizePageButton.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.url) {
      showStatus("Unable to detect current tab URL.", true);
      return;
    }
    await fetchSummary({ url: tab.url });
  });
});

summarizeTextButton.addEventListener("click", async () => {
  const text = manualText.value.trim();
  if (!text) {
    showStatus("Please paste text to summarize.", true);
    return;
  }
  await fetchSummary({ content: text });
});
