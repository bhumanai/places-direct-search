# Basic Search — Execution Spec (LLM-First)

This document frontloads all decisions to implement “Basic Search” end‑to‑end using the Flutter client, Vercel API, Supabase (DB + Realtime), Cloudflare (Workers/Queues/Cache), and OpenAI 5-mini. Focus: serve high‑quality results from stored data with LLM-based intent understanding and reranking. No ingestion is required to pass this test; use seed data or fixtures.

## 0) Scope & Success Criteria
- Scope: Implement `POST /search` with LLM query understanding and LLM rerank over stored place insights; return ranked results for a city/neighborhood + type intent.
- Out of scope: TikTok/Reddit ingestion, background jobs, realtime updates beyond simple channel issuance.
- Success Criteria (must pass):
  - Given a natural language query (e.g., “chill cafe to work in Moda Kadıköy with good espresso”), API responds < 2s warm with ≥ 10 ranked results (from seed data), each with name, score, tags, summary, distance, open/closed, updated_at.
  - Rerank reflects query intent (espresso/quiet/work‑friendly) without code-side semantic weights.
  - Deterministic tie‑breakers only when explicitly requested (distance/open-now) or ties.
  - Strict JSON schemas; invalid LLM output is retried once and then gracefully downgraded.

## 1) Inputs & Contracts
- Endpoint: `POST /search`
- Headers: `Content-Type: application/json`
- Body:
  ```json
  {
    "query": "nice chill cafe to work in moda, kadikoy with good espresso",
    "user_location": { "lat": 40.987, "lng": 29.027 },
    "filters": { "open_now": false },
    "limit": 30,
    "debug": false
  }
  ```
- Response 200:
  ```json
  {
    "query_fingerprint": "v1|istanbul|moda|cafe|facets:chill,laptop,espresso",
    "meta": {
      "satisfied": true,
      "coverage": 18,
      "confidence": 0.74,
      "freshness_days_p50": 6,
      "notes": "rerank: llm; tie-breakers: none"
    },
    "channel_id": "query:v1|istanbul|moda|cafe|facets:chill,laptop,espresso",
    "results": [
      {
        "place_id": "plc_123",
        "name": "Ratio Coffee Moda",
        "lat": 40.987,
        "lng": 29.027,
        "distance_m": 420,
        "fit_score": 92,
        "rationale": "espresso quality consistently praised; quiet weekdays; laptop-friendly seating",
        "tags": ["chill","laptop-friendly","espresso"],
        "summary": "Third-wave cafe with strong espresso; quiet mornings; outlets available.",
        "price_band": "$$",
        "open_now": true,
        "updated_at": "2025-01-02T12:00:00Z",
        "sources": {"tiktok": 8, "reddit": 3}
      }
    ]
  }
  ```
- Errors:
  - 400 invalid body; 429 rate‑limited; 500 internal (with `error_code` and `request_id`).

## 2) Minimal Data Requirements (Supabase)
Seed or import a small dataset for one city/neighborhood.
- Tables (subset of main schema):
  - `place(id, name, lat, lng, address, type, neighborhood, hours_json)`
  - `place_insight(id, place_id, summary, vibe_tags jsonb, scores_json jsonb, uncertainty float8, updated_at timestamptz, must_orders jsonb, dress_code text, busyness_wait text)`
- Minimal indexes:
  - `place(type, neighborhood)`, `place(lat, lng)`, `place_insight(place_id)`
- Example `scores_json` (schema v1):
  ```json
  {"quality": 8.6, "value": 7.2, "service": 7.4, "wait": 6.2, "atmosphere": 8.2, "noise": 4.5, "work_friendly": 8.1}
  ```
- Example `vibe_tags`:
  ```json
  ["chill","laptop-friendly","espresso","third-wave"]
  ```

## 3) Query Fingerprint (Deterministic)
- Format: `v1|<city>|<neighborhood>|<normalized_type>|facets:<facet1,facet2,...>`
- Derivation:
  - City/neighborhood from LLM `query_intent.neighborhood_hints` or geocode fallback.
  - Type from `query_intent.normalized_type` (e.g., cafe).
  - Facets from `query_intent.facets` (lowercase, hyphenated), limited to ≤ 5.
- Used for: cache keys, channel id, analytics grouping.

## 4) LLM Contracts (OpenAI 5-mini)
- Environment:
  - `OPENAI_API_KEY`: required
  - `OPENAI_MODEL`: default `gpt-5-mini` (or name provided by platform)
- A0: Query Understanding (single call)
  - Prompt (system):
    """
    You are an assistant that turns a free-text place search into a strict JSON intent for ranking.
    Output ONLY valid JSON matching the provided schema. No comments or prose.
    """
  - Prompt (user):
    """
    QUERY: "{{query}}"
    CONTEXT: city defaults to Istanbul unless specified; neighborhoods recognized include Moda, Kadıköy, Karaköy, etc.
    SCHEMA:
    {
      "normalized_type": "cafe|restaurant|bar|hotel|...",
      "neighborhood_hints": ["..."],
      "facets": ["vibe or need terms"],
      "filters": {"open_now": bool|null, "price_band": "$|$$|$$$|$$$$|null"},
      "notes": "free-form ranking notes"
    }
    """
  - Expected output example:
    ```json
    {"normalized_type":"cafe","neighborhood_hints":["Moda","Kadıköy"],"facets":["chill","laptop-friendly","espresso"],"filters":{"open_now":null,"price_band":null},"notes":"prioritize espresso quality, quiet, work-friendly"}
    ```
- G: Rerank (single batched call)
  - Input payload: `query_intent` + up to K=50 candidate `place_insight` JSONs (see section 2).
  - Prompt (system):
    """
    Rank places by fit to the query intent using only the provided JSON. Return a JSON array where each item is:
    {"place_id":"...","fit_score":0-100,"rationale":"...","flags":["optional"]}.
    Fit is your judgment; do not invent facts. Penalize uncertainty when evidence is low.
    """
  - Prompt (user):
    ```json
    {"query_intent": { ... }, "candidates": [ {"place_id":"...","summary":"...","vibe_tags":[...],"scores_json":{...},"uncertainty":0.21}, ... ]}
    ```
  - Output example:
    ```json
    [{"place_id":"plc_123","fit_score":92,"rationale":"espresso praised; quiet weekdays; laptop friendly","flags":[]},{"place_id":"plc_456","fit_score":81,"rationale":"good coffee but noisier","flags":["noisy"]}]
    ```
- Strict JSON enforcement: on parse error, retry once with a clarifying system reminder; otherwise fallback to deterministic base ordering (distance ascending) with `meta.notes="fallback: base ordering"`.

## 5) Backend Flow (Vercel API)
1) Validate body; apply rate limit (per-IP token bucket). Generate `request_id`.
2) Call A0 (Query Understanding) → `query_intent`.
3) Derive fingerprint; check Cloudflare Cache for `/search:f:<fingerprint>`; if hit, return cached response.
4) Candidate selection (DB only, no semantics):
   - Resolve polygon for first `neighborhood_hints` (fallback to city);
   - Select places within polygon where `type = normalized_type`;
   - Join with latest `place_insight`; limit 200; order by `updated_at DESC`.
5) Rerank (G) top‑K=50 with LLM 5‑mini; map results back to candidates; compute `coverage`, `confidence≈1 - mean(uncertainty)`.
6) Build response: attach `fit_score`, `rationale`, derived tags, distances from `user_location` if provided.
7) Cache response at Cloudflare (TTL 24h, SWR) under `/search:f:<fingerprint>`.
8) Return 200 with `results`, `meta`, `channel_id = query:<fingerprint>`.

## 6) Deterministic Tie‑Breakers (Only if Needed)
- If two items have equal `fit_score` (±1), break ties by:
  1) `filters.open_now == true` → prefer open
  2) Distance (if `user_location` provided)
  3) Newer `updated_at`

## 7) Error Handling & Timeouts
- A0 timeout: 2.0s; Rerank timeout: 3.0s; total budget: 6s (cold) / 2.5s (warm target).
- On LLM error or timeout: 1 retry; then fallback ordering (distance asc) and set `meta.notes` accordingly.
- On DB miss (coverage < 5): return 200 with empty/partial results and `satisfied=false`.

## 8) Feature Flags (Config)
- `FF_RERANK_ENABLED` (default: true): disable to use fallback ordering.
- `FF_RETURN_RATIONALE` (default: true): if false, omit `rationale` to save bytes.
- `FF_INCLUDE_CHANNEL_ID` (default: true): include `channel_id` for future realtime.

## 9) Caching & Keys
- Cloudflare Cache key: `/search:f:<hash(fingerprint)>`
- TTL: 24h; SWR: 24h; Purge: by fingerprint on place insight change (future job).
- Client hints: ETag and `Cache-Control: public, max-age=60` on API for short client caching.

## 10) Observability
- Log fields: `request_id`, `fingerprint`, `duration_ms`, `source=cache|llm`, `coverage`, `confidence`, `rerank_ms`, `errors`.
- Metrics counters: requests, cache_hits, llm_calls, llm_failures, rerank_duration_ms_histogram.
- Tracing: span `search.query`, child spans `llm.query_intent`, `db.select_candidates`, `llm.rerank`.

## 11) Test Plan (No Ingestion Required)
- Seed 20–40 cafes in `place` for Kadıköy/Moda with realistic `place_insight` rows.
- Golden queries and assertions:
  1) "chill cafe to work in moda kadikoy with good espresso"
     - Expect top 3 to include cafes with tags ["chill","laptop-friendly","espresso"], lower `noise`, higher `quality`.
  2) "open now cafe in moda"
     - With `filters.open_now=true`, ensure open places are ranked above closed ties.
  3) "quiet place to study in kadikoy"
     - Non-espresso intent; ensure `noise` and `work_friendly` drive ranking.
- cURL example:
  ```bash
  curl -sX POST https://api.example.com/search \
    -H 'content-type: application/json' \
    -d '{"query":"chill cafe to work in moda kadikoy with good espresso"}' | jq '.results[0:5]'
  ```

## 12) Security & Limits
- Rate limit: 30 req/min per IP (429 on exceed).
- Payload size: request ≤ 2KB; response ≤ 200KB (limit results to 50 max from server).
- Secrets: `OPENAI_API_KEY` in Vercel env; do not expose to clients.

## 13) Deliverables Checklist
- [ ] Vercel `POST /search` handler with input validation and `request_id` logging
- [ ] OpenAI 5-mini Query Understanding (A0) call with strict JSON parsing + 1 retry
- [ ] Supabase SELECT candidates by polygon/type with seed data
- [ ] OpenAI 5-mini Rerank (G) batched call (≤ 50 candidates) with strict JSON parsing + 1 retry
- [ ] Fingerprint + Cloudflare Cache store (TTL 24h, SWR)
- [ ] Response mapping: `fit_score`, `rationale`, tags, summary, distance, open_now
- [ ] Error handling: retries + fallback ordering; meta notes
- [ ] Logging & basic metrics counters
- [ ] Example cURL verified against seed data

## 14) Appendix — JSON Schemas
- Query Intent (A0):
  ```json
  {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["normalized_type","neighborhood_hints","facets","filters","notes"],
    "properties": {
      "normalized_type": {"type":"string"},
      "neighborhood_hints": {"type":"array","items":{"type":"string"}},
      "facets": {"type":"array","items":{"type":"string"}},
      "filters": {
        "type":"object",
        "properties": {
          "open_now": {"type":["boolean","null"]},
          "price_band": {"type":["string","null"], "enum":["$","$$","$$$","$$$$", null]}
        },
        "additionalProperties": false
      },
      "notes": {"type":"string"}
    },
    "additionalProperties": false
  }
  ```
- Rerank Output (G):
  ```json
  {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "array",
    "items": {
      "type": "object",
      "required": ["place_id","fit_score","rationale"],
      "properties": {
        "place_id": {"type":"string"},
        "fit_score": {"type":"number","minimum":0,"maximum":100},
        "rationale": {"type":"string"},
        "flags": {"type":"array","items":{"type":"string"}}
      },
      "additionalProperties": false
    }
  }
  ```

---

Owner: Search
Version: v1
Last updated: YYYY-MM-DD

