# Places Direct Source Search API

Serverless API (Vercel) that performs direct-source place search using OpenAI 5-mini (LLM-first), Perplexity (Reddit/TikTok retrieval), and Google Places for entity resolution. Returns ranked results with citations — no DB reads.

## Quick Start

- Requirements: Node 20+, Vercel CLI (optional)
- Set env vars in Vercel project (Project → Settings → Environment Variables):
  - `OPENAI_API_KEY`
  - `OPENAI_MODEL` (default `gpt-5-mini`)
  - `PERPLEXITY_API_KEY`
  - `GOOGLE_PLACES_API_KEY`

Local dev (optional):

```
npm i
vercel dev
# POST to http://localhost:3000/api/search
```

## Endpoint

POST `/api/search`

Body:

```
{
  "query": "nice chill cafe to work in moda, kadikoy with good espresso",
  "mode": "direct",
  "user_location": {"lat": 40.987, "lng": 29.027},
  "filters": {"open_now": null, "price_band": null},
  "limit": 20,
  "debug": false
}
```

Response (excerpt):

```
{
  "query_fingerprint": "v1|istanbul|moda|cafe|facets:chill,laptop,espresso|mode:direct",
  "meta": { "source_fetch": {"tiktok":"ok","reddit":"ok"}, "coverage": 14, "confidence": 0.71, "latency_ms": 3200 },
  "results": [
    { "place_id": "canon_temp_1", "name": "...", "fit_score": 92, "rationale": "...", "tags": ["chill","laptop-friendly"], "summary": "...", "citations": [{"source":"tiktok","url":"..."}]} 
  ]
}
```

## Architecture (this milestone)

- Vercel Node Serverless function at `api/search.ts` orchestrates:
  - A0: LLM query understanding
  - S1: Perplexity TikTok+Reddit retrieval (parallel)
  - X: LLM candidate extraction
  - R: Google Places entity resolution
  - A1: LLM attribute summarization
  - G: LLM rerank
- Cloudflare edge cache can be layered in front of `/api/search` later (TTL 6h, SWR 24h).

## Notes

- Strict JSON parsing with one retry per LLM step.
- No persistence; no secrets logged. Rotate keys if ever exposed.
- Keep `limit <= 20` and total latency budget ~6–8s cold.

## Deploy

- Push this repo to GitHub
- Import into Vercel → set env vars → Deploy
- Test with `curl`:

```
curl -sX POST https://<your-app>.vercel.app/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"chill cafe to work in moda kadikoy with good espresso","mode":"direct"}' | jq '.results[0:5]'
```

---

See `features/direct-source-search/SPEC.md` for a deeper execution spec.
