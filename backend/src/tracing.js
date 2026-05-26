import dotenv from "dotenv";
dotenv.config();

// Set LangChain/LangSmith env vars before any traceable imports
process.env.LANGCHAIN_TRACING_V2 = process.env.LANGSMITH_TRACING || "false";
process.env.LANGCHAIN_ENDPOINT = process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com";
process.env.LANGCHAIN_API_KEY = process.env.LANGSMITH_API_KEY || "";
process.env.LANGCHAIN_PROJECT = process.env.LANGSMITH_PROJECT || "summarizer";
