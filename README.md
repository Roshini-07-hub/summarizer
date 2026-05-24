# AI Content Summarizer

This project is a fullstack AI-powered content summarizer using Node.js, plain HTML/CSS, and Pinecone.

## Structure
- `backend/` - Express API with Groq and Pinecone integration
- `frontend/` - vanilla HTML/CSS frontend served by Vite

## Setup
1. Install dependencies
   - `cd backend && npm install`
   - `cd frontend && npm install`
2. Create `.env` in `backend/` from `.env.example`
3. Run backend: `cd backend && npm run dev`
4. Run frontend: `cd frontend && npm run dev`

## Environment variables
- `GROQ_API_KEY`
- `GROQ_MODEL` (optional, defaults to `llama-3.3-70b-versatile`)
- `PINECONE_API_KEY`
- `PINECONE_ENVIRONMENT`
- `PINECONE_INDEX_NAME`
- `API_SECRET_KEY` (optional, add `x-api-key` header to API requests for protection)

## Features
- Summarize text or URL content
- Upload image/video files for metadata-based summaries
- Summarize image/video links
- Save summaries into Pinecone vector database
- Search saved summaries by query
- Retrieve summary history
- Copy summary to clipboard from the frontend
- Browser extension scaffold for quick page summaries

## Browser extension
The `extension/` folder contains a Chrome-compatible popup extension scaffold. Load it in developer mode and use it to summarize the current tab or pasted text.
