# Backend for AI Content Summarizer

## Setup
1. Copy `.env.example` to `.env`
2. Fill in your `GROQ_API_KEY`, `PINECONE_API_KEY`, `PINECONE_ENVIRONMENT`, and optional `GROQ_MODEL`, `PINECONE_INDEX_NAME` and `API_SECRET_KEY`
3. Run `npm install`
4. Start the server with `npm run dev`

## API Endpoints
- `POST /api/summarize` — summarize text, URL, or uploaded image/video metadata and save it to Pinecone
  - body: `{ content?: string, url?: string, source?: string, fileName?: string, fileType?: string, fileSize?: number }`
- `POST /api/search` — search saved summaries
  - body: `{ query: string }`
- `GET /api/summary/:id` — fetch a saved summary by ID

If `API_SECRET_KEY` is set, add `x-api-key` to the headers for all `/api/*` requests.
