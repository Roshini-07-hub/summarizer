import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Groq, toFile } from "groq-sdk";
import crypto from "crypto";
import fs from "fs/promises";
import { MongoClient } from "mongodb";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const allowedOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Always allow the known frontend URLs as fallback
const defaultOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://summarizer-frontend-wine.vercel.app",
];
const allAllowedOrigins = [...new Set([...defaultOrigins, ...allowedOrigins])];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allAllowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  }),
);
// Allow override via env and increase default to handle larger media metadata (but avoid large base64 payloads from client)
const BODY_LIMIT = process.env.BODY_LIMIT || "200mb";
app.use(express.json({ limit: BODY_LIMIT }));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_TRANSCRIPTION_MODEL = process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo";
const API_SECRET_KEY = process.env.API_SECRET_KEY;

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
// No Pinecone. MongoDB is the default vector store when configured.

const requireApiKey = (req, res, next) => {
  if (!API_SECRET_KEY) return next();
  const requestKey = req.headers["x-api-key"];
  if (!requestKey || requestKey !== API_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized request." });
  }
  next();
};

app.use("/api", requireApiKey);

const COLLECTION_NAME = process.env.MONGODB_COLLECTION || "summaries";

// MongoDB (Atlas) optional replacement for Pinecone
const MONGODB_URI = process.env.MONGODB_URI || null;
const MONGODB_DB = process.env.MONGODB_DB || "content_summarizer";
let mongoClient = null;
let mongoCollection = null;
let mongoStatus = MONGODB_URI ? "configured" : "not_configured";
let mongoError = null;

const initMongo = async () => {
  if (!MONGODB_URI) return;
  try {
    mongoStatus = "connecting";
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db(MONGODB_DB);
    mongoCollection = db.collection(COLLECTION_NAME || "summaries");
    // ensure index on `id`
    await mongoCollection.createIndex({ id: 1 }, { unique: true });
    mongoStatus = "connected";
    mongoError = null;
    console.log("MongoDB connected and collection ready:", MONGODB_DB, COLLECTION_NAME || "summaries");
  } catch (err) {
    mongoStatus = "error";
    mongoError = err.message || String(err);
    console.warn("MongoDB init failed, continuing without MongoDB:", err.message || err);
    mongoClient = null;
    mongoCollection = null;
  }
};

const LOCAL_SUMMARIES_PATH = new URL("../data/summaries.json", import.meta.url);

const readLocalSummaries = async () => {
  try {
    const raw = (await fs.readFile(LOCAL_SUMMARIES_PATH, "utf8")).replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

const writeLocalSummaries = async (summaries) => {
  await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await fs.writeFile(LOCAL_SUMMARIES_PATH, JSON.stringify(summaries, null, 2));
};

const cosineSimilarity = (a, b) => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
};

const saveSummaryRecord = async (record) => {
  // Prefer MongoDB if configured
  if (mongoCollection) {
    try {
      await mongoCollection.updateOne({ id: record.id }, { $set: record }, { upsert: true });
      return "mongodb";
    } catch (err) {
      console.warn(`MongoDB upsert failed; error: ${err.message}`);
      // fall through to local storage
    }
  }

  const summaries = await readLocalSummaries();
  summaries.push(record);
  await writeLocalSummaries(summaries);
  return "local";
};

const searchSummaryRecords = async (vector) => {
  // If MongoDB available, fetch all and compute similarity locally
  if (mongoCollection) {
    try {
      const docs = await mongoCollection.find({}).toArray();
      return docs
        .map((record) => ({
          id: record.id,
          score: cosineSimilarity(vector, record.values || []),
          metadata: record.metadata,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    } catch (err) {
      console.warn(`MongoDB search failed; falling back to local: ${err.message}`);
    }
  }

  const summaries = await readLocalSummaries();
  return summaries
    .map((record) => ({
      id: record.id,
      score: cosineSimilarity(vector, record.values || []),
      metadata: record.metadata,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
};

const fetchSummaryRecord = async (id) => {
  if (mongoCollection) {
    try {
      const doc = await mongoCollection.findOne({ id });
      return doc || null;
    } catch (err) {
      console.warn(`MongoDB fetch failed; falling back to local: ${err.message}`);
    }
  }

  const summaries = await readLocalSummaries();
  return summaries.find((record) => record.id === id) || null;
};

const deleteSummaryRecord = async (id) => {
  if (mongoCollection) {
    try {
      const result = await mongoCollection.deleteOne({ id });
      return { deleted: result.deletedCount > 0, storage: "mongodb" };
    } catch (err) {
      console.warn(`MongoDB delete failed; falling back to local: ${err.message}`);
    }
  }

  const summaries = await readLocalSummaries();
  const nextSummaries = summaries.filter((record) => record.id !== id);
  if (nextSummaries.length === summaries.length) {
    return { deleted: false, storage: "local" };
  }

  await writeLocalSummaries(nextSummaries);
  return { deleted: true, storage: "local" };
};

const fetchPageText = async (url) => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ContentSummarizer/1.0)",
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Unable to fetch URL: ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType && !/(text|html|xml|json)/i.test(contentType)) {
    throw new Error("This URL does not look like a readable text page. Try a page/article URL or use the file/audio/video upload.");
  }
  const html = await response.text();
  const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 80) {
    throw new Error("Could not extract enough readable text from this URL. The site may block fetches or render content with JavaScript.");
  }
  return text;
};

const parseJsonResponse = (text) => {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const payload = jsonMatch ? jsonMatch[0] : cleaned;
  try {
    return JSON.parse(payload);
  } catch (err) {
    return null;
  }
};

const isMediaUrl = (url) => {
  return /\.(png|jpe?g|gif|bmp|webp|mp4|mov|webm|avi|mkv|mp3|wav|m4a|aac|ogg|flac)(\?.*)?$/i.test(url);
};

const getFileNameFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).pop() || url;
  } catch (err) {
    return url;
  }
};

const getMediaSummary = async ({ fileName, fileType, fileSize, fileUrl, description }) => {
  if (!groq) {
    throw new Error("GROQ_API_KEY is not configured. Please set it in backend/.env.");
  }

  const promptParts = [
    "Summarize this media asset with a short title, a concise paragraph summary, and three key bullet points.",
    `File name: ${fileName || "unknown"}`,
    `Type: ${fileType || "unknown"}`,
  ];

  if (fileSize) promptParts.push(`Size: ${fileSize} bytes`);
  if (fileUrl) promptParts.push(`URL: ${fileUrl}`);
  if (description) promptParts.push(`Description: ${description}`);

  const prompt = `${promptParts.join("\n")}${"\n\n"}Summarize the content in English. If the transcript or description is in another language, translate and summarize it in English. Do not say the content is unclear or that translation is unavailable — always provide a meaningful summary. Do not mention that this summary is based only on metadata.`;

  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: GROQ_MODEL,
    max_tokens: 450,
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "";
  const parsed = parseJsonResponse(raw);
  if (parsed && parsed.title && parsed.summary && Array.isArray(parsed.bullets)) {
    return parsed;
  }
  return {
    title: "Media Summary",
    summary: raw || "Summary unavailable.",
    bullets: [],
  };
};

const transcribeMedia = async ({ fileName, fileType, fileData }) => {
  if (!groq) {
    throw new Error("GROQ_API_KEY is not configured. Please set it in backend/.env.");
  }
  if (!fileData) return "";

  const buffer = Buffer.from(fileData, "base64");
  if (!buffer.length) return "";

  console.log(`Transcribing: ${fileName} (${fileType}, ${(buffer.length / 1024).toFixed(1)} KB)`);

  // Groq Whisper requires an audio stream. For video files, we send the raw
  // buffer and let Groq extract the audio track server-side.
  // Ensure the MIME type is audio/* so Whisper accepts it; fall back to
  // audio/mp4 for video containers (mp4/mov/webm all carry AAC/Opus audio).
  let mimeType = fileType || "application/octet-stream";
  if (mimeType.startsWith("video/")) {
    // Map common video containers to their audio equivalent
    const videoToAudio = {
      "video/mp4": "audio/mp4",
      "video/quicktime": "audio/mp4",
      "video/webm": "audio/webm",
      "video/x-matroska": "audio/webm",
      "video/avi": "audio/wav",
      "video/mpeg": "audio/mpeg",
    };
    mimeType = videoToAudio[mimeType] || "audio/mp4";
    console.log(`Remapped video MIME to audio MIME: ${mimeType}`);
  }

  // Normalize mpeg variants — browsers may report these inconsistently
  const mpegVariants = ["audio/mpeg", "audio/mp3", "audio/x-mpeg", "audio/x-mp3", "audio/mpg", "audio/x-mpg"];
  if (mpegVariants.includes(mimeType) || /\.(mpeg|mpg|mp3)$/i.test(fileName || "")) {
    mimeType = "audio/mpeg";
  }

  const file = await toFile(buffer, fileName || "media", { type: mimeType });

  try {
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: GROQ_TRANSCRIPTION_MODEL,
      response_format: "json",
    });

    const text = transcription.text?.trim() || "";
    console.log(`Transcription result (${text.split(/\s+/).length} words): ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);
    return text;
  } catch (err) {
    // Surface the real Groq error message instead of swallowing it
    const groqMessage = err?.error?.message || err?.message || String(err);
    console.error(`Groq transcription error: ${groqMessage}`);
    throw new Error(`Transcription failed: ${groqMessage}`);
  }
};

const getSummary = async (content) => {
  const prompt = `Analyze the text below and return valid JSON only with these fields: title, summary, bullets.
- title: a short, descriptive title (in English).
- summary: a concise paragraph summary in English. If the source text is in another language (e.g. Tamil, Hindi, Spanish), translate and summarize it in English. Do NOT say the transcript is unclear or that translation is unavailable — always provide a meaningful summary based on the content.
- bullets: an array of 3 key points in English.
Do not add any extra explanatory text outside the JSON.

Text:
${content}`;

  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: GROQ_MODEL,
    max_tokens: 450,
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "";
  const parsed = parseJsonResponse(raw);
  if (parsed && parsed.title && parsed.summary && Array.isArray(parsed.bullets)) {
    return parsed;
  }

  return {
    title: "Summary",
    summary: raw || content.slice(0, 400),
    bullets: [],
  };
};

const createEmbedding = async (text) => {
  if (!groq) {
    throw new Error("GROQ_API_KEY is not configured. Please set it in backend/.env.");
  }
  // Create a simple embedding using crypto hash
  // This is a simplified approach - in production, use a dedicated embedding service
  const hash = crypto.createHash("sha256").update(text).digest();
  const embedding = [];
  for (let i = 0; i < 1536; i++) {
    embedding.push((hash[i % hash.length] - 128) / 128);
  }
  return embedding;
};

app.post("/api/summarize", async (req, res) => {
  try {
    const { content, url, fileName, fileType, fileSize, fileUrl, fileData, description, source = "manual" } = req.body;
    if (!content && !url && !fileUrl && !fileName) {
      return res.status(400).json({ error: "Provide text, a URL, or a media file to summarize." });
    }

    let summaryData;
    let sourceDomain = "manual";
    let rawText = content || "";
    let summaryType = "text";
    const metadata = {};

    if ((source === "audio" || source === "video") && fileData && fileData.length > 0) {
      rawText = await transcribeMedia({ fileName, fileType, fileData });
      if (!rawText) {
        throw new Error(
          "Transcription returned empty text. Ensure the file contains audible speech and is in a supported format (mp3, mp4, wav, m4a, webm, ogg, flac).",
        );
      }

      const mediaContent = [
        `File name: ${fileName || "uploaded media"}`,
        fileType ? `File type: ${fileType}` : "",
        description ? `Context: ${description}` : "",
        "",
        "Transcript:",
        rawText,
      ].filter(Boolean).join("\n");

      summaryData = await getSummary(mediaContent);
      summaryType = source;
      metadata.fileName = fileName;
      metadata.fileType = fileType;
      metadata.fileSize = fileSize;
      metadata.fileUrl = fileUrl || null;
      metadata.source = source;
      metadata.sourceDomain = source;
      metadata.originalTextPreview = rawText.slice(0, 300);
      metadata.transcriptPreview = rawText.slice(0, 1000);
      metadata.wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;
      metadata.readTimeMinutes = Math.max(1, Math.ceil(metadata.wordCount / 200));
    } else if ((fileName || fileType || fileSize) && rawText.trim()) {
      const fileContent = [
        `File name: ${fileName || "uploaded file"}`,
        fileType ? `File type: ${fileType}` : "",
        description ? `Context: ${description}` : "",
        "",
        rawText,
      ].filter(Boolean).join("\n");

      summaryData = await getSummary(fileContent);
      summaryType = "file";
      metadata.fileName = fileName;
      metadata.fileType = fileType;
      metadata.fileSize = fileSize;
      metadata.fileUrl = fileUrl || null;
      metadata.source = source;
      metadata.sourceDomain = fileUrl ? getFileNameFromUrl(fileUrl) : source;
      metadata.originalTextPreview = rawText.slice(0, 300);
      metadata.wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;
      metadata.readTimeMinutes = Math.max(1, Math.ceil(metadata.wordCount / 200));
    } else if (fileName || fileType || fileSize) {
      summaryData = await getMediaSummary({ fileName, fileType, fileSize, fileUrl, description });
      summaryType = "file";
      metadata.fileName = fileName;
      metadata.fileType = fileType;
      metadata.fileSize = fileSize;
      metadata.fileUrl = fileUrl || null;
      metadata.source = source;
      metadata.sourceDomain = fileUrl ? getFileNameFromUrl(fileUrl) : source;
      metadata.originalTextPreview = `${fileName || fileUrl || "Media upload"}`;
      metadata.wordCount = 0;
      metadata.readTimeMinutes = 0;
    } else if (url) {
      if (isMediaUrl(url)) {
        const name = getFileNameFromUrl(url);
        summaryData = await getMediaSummary({ fileName: name, fileType: url.split(".").pop(), fileUrl: url });
        summaryType = "file";
        metadata.fileName = name;
        metadata.fileType = url.split(".").pop();
        metadata.fileSize = null;
        metadata.fileUrl = url;
        metadata.source = source;
        metadata.sourceDomain = new URL(url).hostname;
        metadata.originalTextPreview = url;
        metadata.wordCount = 0;
        metadata.readTimeMinutes = 0;
      } else {
        rawText = await fetchPageText(url);
        summaryData = await getSummary(rawText);
        summaryType = "url";
        metadata.source = source;
        metadata.sourceDomain = new URL(url).hostname;
        metadata.originalTextPreview = rawText.slice(0, 300);
        metadata.wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;
        metadata.readTimeMinutes = Math.max(1, Math.ceil(metadata.wordCount / 200));
      }
    } else {
      summaryData = await getSummary(rawText);
      summaryType = "text";
      metadata.source = source;
      metadata.sourceDomain = "manual";
      metadata.originalTextPreview = rawText.slice(0, 300);
      metadata.wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;
      metadata.readTimeMinutes = Math.max(1, Math.ceil(metadata.wordCount / 200));
    }

    const embeddingText = `${summaryData.summary}\n${rawText.slice(0, 1000)}`;
    const vector = await createEmbedding(embeddingText);
    const id = uuidv4();

    const storedMetadata = {
      title: summaryData.title,
      summary: summaryData.summary,
      bullets: summaryData.bullets,
      summaryType,
      ...metadata,
      createdAt: new Date().toISOString(),
      url: url || metadata.fileUrl || null,
    };

    const storage = await saveSummaryRecord({
      id,
      values: vector,
      metadata: storedMetadata,
    });

    return res.json({ id, metadata: storedMetadata, saved: true, storage });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || "Summarization failed." });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Search query is required." });
    }

    const queryEmbedding = await createEmbedding(query);
    const result = await searchSummaryRecords(queryEmbedding);

    const matches = result.map((match) => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata,
    }));

    return res.json({ query, matches });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || "Search failed." });
  }
});

app.get("/api/summary/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const vector = await fetchSummaryRecord(id);
    if (!vector) {
      return res.status(404).json({ error: "Summary not found." });
    }
    return res.json({ id, metadata: vector.metadata });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || "Fetch failed." });
  }
});

app.delete("/api/summary/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await deleteSummaryRecord(id);
    if (!result.deleted) {
      return res.status(404).json({ error: "Summary not found." });
    }

    return res.json({ deleted: true, id, storage: result.storage });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || "Delete failed." });
  }
});

// Return local stored summaries
app.get("/api/local-records", async (req, res) => {
  try {
    if (mongoCollection) {
      const docs = await mongoCollection.find({}).toArray();
      return res.json(docs || []);
    }

    const summaries = await readLocalSummaries();
    return res.json(summaries || []);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to read local records." });
  }
});

// Return storage configuration/status (non-sensitive)
app.get("/api/index-info", (req, res) => {
  try {
      const info = {
      mongoConfigured: !!MONGODB_URI,
      mongoConnected: !!mongoCollection,
      mongoStatus,
      mongoError,
      mongoDb: MONGODB_DB || null,
      collectionName: COLLECTION_NAME || null,
      storage: mongoCollection ? "mongodb" : "local",
    };
    return res.json(info);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to get index info." });
  }
});

// Generic JSON error handler for unhandled errors
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const status = err && err.status ? err.status : 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

const port = process.env.PORT || 4000;
await initMongo();
app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
