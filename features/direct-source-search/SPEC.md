# Direct Source Search — Execution Spec (LLM-First, No DB Read)

Build Basic Search that pulls live recommendations from external sources (TikTok + Reddit via Perplexity) and returns ranked places with citations — without querying our own database. All reasoning, extraction, and ranking are LLM-driven; we do not persist results in this phase.

## 0) Scope & Success Criteria
- Scope: Implement a direct-search API that aggregates external sources at request time and returns ranked place recommendations with evidence.
- Out of scope: Persistence, background ingestion, realtime updates, lists.
- Success Criteria:
  - Given a query like “nice chill cafe to work in moda, kadikoy with good espresso”, respond in ≤ 6–8s cold / ≤ 3s warm.
  - Return ≥ 8 de-duplicated places with: name, location, fit_score, rationale, tags, summary, and citations (TikTok/Reddit URLs + snippets).
  - No hand-coded semantics; LLM determines intent and ranking. Only explicit constraints (e.g., open-now) applied deterministically.

## 1) Endpoint & Contracts
- Endpoint: `POST /search` (mode: direct)
- Body:
  ```json
  {
    "query": "nice chill cafe to work in moda, kadikoy with good espresso",
    "mode": "direct",
    "user_location": {"lat": 40.987, "lng": 29.027},
    "filters": {"open_now": null, "price_band": null},
    "limit": 20,
    "debug": false
  }
  ```
- Response 200:
  ```json
  {
    "query_fingerprint": "v1|istanbul|moda|cafe|facets:chill,laptop,espresso|mode:direct",
    "meta": {
      "source_fetch": {"tiktok":"ok","reddit":"ok"},
      "coverage": 14,
      "confidence": 0.71,
      "latency_ms": 3200
    },
    "results": [
      {
        "place_id": "canon_temp_1",
        "name": "Ratio Coffee Moda",
        "lat": 40.987,
        "lng": 29.027,
        "fit_score": 92,
        "rationale": "espresso quality praised; quiet weekdays; laptop-friendly seating",
        "tags": ["chill","laptop-friendly","espresso"],
        "summary": "Third-wave cafe with strong espresso and outlets; quiet mornings.",
        "citations": [
          {"source":"tiktok","url":"https://www.tiktok.com/...","quote":"Great espresso, I work here often"},
          {"source":"reddit","url":"https://www.reddit.com/...","quote":"Laptop-friendly spot in Moda"}
        ]
      }
    ]
  }
  ```
- Errors: 400 (invalid), 429 (rate limit), 502 (provider error), 500 (internal). Include `request_id` and `error_code`.

## 2) Infra & Responsibilities
- Vercel API (or Edge): Orchestrates the full request; no DB reads/writes; returns JSON.
- Perplexity Pro API: Retrieval for Reddit and TikTok content (citations/snippets/links); 2 targeted calls in parallel.
- Google Places API: Entity resolution only (name → canonical place with lat/lng) — optional but recommended for dedup + mapping.
- Cloudflare Cache: Cache final response by fingerprint (TTL 6h, SWR 24h) for warm performance.

## 3) Pipeline (Request-Time)
1) A0 — Query Understanding (OpenAI 5-mini)
   - Input: raw `query` (+ optional `user_location`).
   - Output: `query_intent` JSON: `normalized_type`, `neighborhood_hints[]`, `facets[]`, `filters{open_now?, price_band?}`, `notes`.
2) S1 — Source Retrieval (Perplexity, in parallel)
   - TikTok-focused query: ask Perplexity to return top relevant TikTok video links for the area, with caption summary and any salient comment quotes related to the intent.
   - Reddit-focused query: ask Perplexity to return top relevant threads/comments from local subs (e.g., r/istanbul) and coffee subs.
   - Each response must include `items[{title,url,author,created_at,snippet}]` and be constrained to the geographic hints.
3) X — Candidate Extraction (OpenAI 5-mini)
   - Input: union of S1 TikTok and Reddit items (titles, snippets, quotes).
   - Output: `candidates[{name, clues, source_urls[], confidence}]` (no geocodes yet).
4) R — Entity Resolution (Google Places)
   - For each candidate, query Places Text Search scoped to `neighborhood_hints`/city; output `canonical_name`, `lat`, `lng`, `address`, `place_id`.
   - Dedupe by `place_id` (or by name+geo threshold if unavailable).
5) A1 — Attribute Summarization (OpenAI 5-mini)
   - For each canonical place, aggregate all evidence snippets; output `summary`, `vibe_tags[]`, `scores{quality, value, service, wait, atmosphere, noise, work_friendly}`, `uncertainty`, `pros[]`, `cons[]`, `tips[]`.
6) G — Rerank (OpenAI 5-mini)
   - Input: `query_intent` + per-place attribute JSONs.
   - Output: per-place `fit_score(0–100)`, `rationale`, optional `flags`.
7) Respond
   - Map to final payload with citations (original URLs), fit_score, rationale, summary, tags, and coordinates.
   - Cache by fingerprint (mode: direct).

## 4) Prompts & Output (Strict JSON)
- A0 — Query Understanding (system excerpt)
  - “Output ONLY JSON: {normalized_type, neighborhood_hints[], facets[], filters{open_now?,price_band?}, notes}. Do not explain.”
- S1 — Perplexity (TikTok)
  - Instruction: “Find recent, relevant TikTok videos about ‘{{normalized_type}}’ in {{neighborhood/city}} that match: {{facets}}. Return JSON: items[{title,url,author,created_at,snippet}]. Prefer posts with meaningful comments on espresso/quiet/work-friendly. No duplicates.”
- S1 — Perplexity (Reddit)
  - Instruction: “Find relevant Reddit threads/comments about ‘{{normalized_type}}’ in {{neighborhood/city}} (e.g., r/istanbul, coffee subs). Return JSON: items[{title,url,author,created_at,snippet}]. Emphasize laptop-friendly/espresso/quiet.”
- X — Candidate Extraction (system excerpt)
  - “From mixed TikTok/Reddit items, extract candidate place names in the target area. Output JSON: candidates[{name, clues, source_urls[], confidence:0–1}] only.”
- A1 — Attribute Summarization (system excerpt)
  - “Given evidence snippets per place, summarize and score attributes. Output JSON per place: {summary, vibe_tags[], scores{quality,value,service,wait,atmosphere,noise,work_friendly}, uncertainty, pros[], cons[], tips[]}.”
- G — Rerank (system excerpt)
  - “Rank places by fit to the query intent using only provided JSON. Output [{place_id, fit_score, rationale, flags[]}]. Penalize uncertainty.”

## 5) Budgets, Timeouts, and Concurrency
- Global budget: ≤ 6–8s cold; parallelize wherever possible.
- A0 (intent): 1.5s timeout.
- S1 TikTok + Reddit (Perplexity): 2.5s each, in parallel; soft-fail one if needed; proceed with available.
- X extraction: 1.5s.
- R Places lookup: 2.0s, parallel per candidate with concurrency cap (e.g., 8).
- A1 summarize (batched per 5–8 places): 2.5s per batch.
- G rerank (batched all places): 1.0s.
- If any step times out: continue with available data; mark `meta.source_fetch` statuses.

## 6) Compliance & Safety
- Use Perplexity to retrieve TikTok/Reddit content (no scraping of authenticated content); include attributions and links.
- Do not store PII beyond public handles in responses; no persistence at this stage.
- Respect API ToS for Places; limit fields to essentials.

## 7) Error Handling & Fallbacks
- If both sources fail: return 200 with `results:[]`, `meta.source_fetch={tiktok:"fail",reddit:"fail"}`.
- If only one succeeds: proceed; dedupe; rank whatever is available.
- If Places resolution fails for a candidate: keep name without coords; include `flags:["unresolved_entity"]`.
- JSON enforcement: Any non-JSON output from LLM retried once; on second failure, skip that step for the affected batch.

## 8) Caching (Edge)
- Key: `/search:f:<fingerprint>|mode:direct`.
- TTL: 6h; SWR: 24h; manual purge not required for this phase.

## 9) Observability
- Log: `request_id`, `fingerprint`, per-step `latency_ms`, source statuses, counts (candidates/places), final `coverage`, `confidence`.
- Metrics: counters for provider calls, timeouts, failures; histograms for step latencies.

## 10) Test Plan
- Dry-run with known cities/neighborhoods (e.g., Moda/Kadıköy, Karaköy) and confirm:
  - TikTok/Reddit items populated with relevant citations.
  - Extracted place candidates are sensible.
  - Places resolve to correct coordinates; near target area.
  - Rerank favors espresso/quiet/work-friendly for the sample query.
- Latency checks: P95 within budget with parallelism.

## 11) Deliverables Checklist
- [ ] `POST /search` supports `mode=direct` and bypasses DB.
- [ ] A0 intent call with strict JSON parsing + 1 retry.
- [ ] Perplexity calls (TikTok/Reddit) with JSON outputs and provider timeouts.
- [ ] Candidate extraction call and mapping.
- [ ] Places resolution with dedupe.
- [ ] Attribute summarization per place (batched).
- [ ] Rerank call producing `fit_score` + `rationale`.
- [ ] Final response with citations, tags, summary, coords; edge cache store.
- [ ] Logs/metrics for each step; debug mode includes intermediate counts.

---

Owner: Search
Version: v1
Last updated: YYYY-MM-DD

