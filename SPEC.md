# Cool Places Finder — Spec Sheet

A fast, AI-assisted way to discover “cool places” by mining TikTok search results and comments, then summarizing the vibe and actionable insights. Default LLM: OpenAI 5-mini.

## 1) Product Summary
- **Goal:** Turn TikTok chatter into trustworthy place recommendations with clear vibes, pros/cons, and first-timer tips.
- **Users:** Locals, travelers, creators, and curators who want authentic, trend-driven spots.
- **Core Insight:** TikTok comments contain dense, up-to-date signal on quality, crowd, price, lines, and hidden rules.

## 2) Primary Use Cases
- **Find spots by vibe:** “Cozy date night bars,” “late-night ramen,” “sunset rooftops.”
- **Decision help:** Quick pros/cons and tips (best time to go, must-order items).
- **Area scanning:** What’s cool near me or a given pin.
- **Trip planning:** Save/share shortlists with vibe-fit filters.

## 3) Sources & Inputs
- **TikTok Search:** Query keywords + locations; fetch top/recency/engagement results.
- **TikTok Comments:** Parse threads for sentiment, attributes (wait time, crowd, price, accessibility), and canonical names.
- **Reddit Enrichment (Perplexity Pro):** Retrieve relevant threads and top comments to corroborate TikTok claims, surface missing attributes, and add citations.
- **Optional Enrichment:** Maps/Places data for normalization (e.g., address, hours, lat/lng) and deduping.

## 4) Core Features (MVP)
- **Smart Search:** Query by keywords, vibe, or location.
- **Comment Intelligence:** Extract claims, consensus, and contradictions from TikTok comments.
- **Vibe Profile:** Vibe tags + 1–2 line summary.
- **Scoring:** 0–10 across 6–8 attributes (quality, value, service, wait, atmosphere, etc.).
- **Evidence-backed:** Citation snippets with timestamps and engagement.
- **Lists & Sharing:** Save places to lists; share as link.
- **Stored-First Search:** Serve from existing insights; if insufficient, auto-enrich in background and update results.

## 5) Non-Goals (MVP)
- Table bookings, full social graph, influencer management, UGC uploads, multi-city content ops.

## 6) Functional Requirements
- **Ingestion:** Fetch TikTok (videos + top comments) and Perplexity/Reddit citations; handle rate limits, spam filtering, and incremental updates.
- **Normalization & Dedup:**
  - Resolve place names to a canonical entity; geocode and enrich (address, hours) when possible.
  - Merge duplicates across videos; retain source lineage.
- **Analysis (OpenAI 5-mini):**
  - Extract attributes, sentiment, pros/cons, “what to know,” and vibe tags.
  - Compute attribute scores with uncertainty; summarize consensus vs outliers.
- **Languages:** Detect comment language; prompt/aggregate per language when needed.
 - **Ranking:**
  - LLM-driven: 5-mini interprets the query intent and ranks candidates; only minimal deterministic tie-breakers (distance, open-now) when explicitly requested.
- **Presentation:**
  - Card list + map; detail view with vibe radar, key quotes, tips, hours, and photos (if available).
- **Persistence:**
  - Store places, sources, comment-derived facts, and scores with versioning.
 - **Query Path (Stored-first → RT Fallback):**
   - For a query (e.g., "kadikoy + cafe"), fetch existing `place_insight` within polygon and filters.
   - If results meet satisfaction threshold (coverage + confidence), return immediately and schedule light refresh.
   - If below threshold, return partial results; enqueue real-time crawl/enrichment for gaps, then stream or refresh on completion.

## 7) Trust, Safety, and Compliance
- **Platform Compliance:** Respect TikTok ToS; prefer official APIs or approved providers; avoid storing raw video content beyond metadata necessary for analysis.
- **Reddit & Perplexity Compliance:** Respect Reddit content policies and Perplexity Pro ToS; attribute sources with links; avoid storing unnecessary user data.
- **Attribution:** Link to TikTok videos and Reddit threads; show creator handles, authors, and subreddits when citing.
- **Moderation:** Filter unsafe content; detect and down-rank misinformation and coordinated spam.
- **Privacy:** Do not collect PII from comments beyond public handles; allow data removal on request.

## 8) System Architecture
- **Client (Flutter: iOS/Android/Web):** Single codebase with responsive layouts; map view + list; swipe deck mode; client cache and service worker for web.
- **API Layer (Vercel):** Serverless/Edge Functions for `/search`, `/places/:id`, `/places/:id/evidence`, `/areas/*`, and admin endpoints.
- **Workers (Cloudflare):** Ingestion (TikTok), Reddit enrichment (Perplexity), place refresh, query backfill, analysis; scheduled jobs and queue consumers.
- **LLM Service:** Structured prompts to OpenAI 5-mini; JSON outputs.
- **Storage (Supabase):** Postgres (pgvector optional) for core data; Storage for images (optional); Realtime for change feeds.
- **Enrichment:** Maps/Places API for geocoding and hours; image proxying/thumbnails.
- **Geodata:** OSM neighborhood polygons cached per city.
- **Jobs & Cache:** Cloudflare Queues for background jobs; Cloudflare Cache for API response caching and on-demand purge; client SW stale-while-revalidate.

## 9) Data Model (MVP, simplified)
- **`place`**: `id`, `name`, `address`, `lat`, `lng`, `canonical_phone`, `hours_json`, `source_confidence`
- **`source_post`**: `id`, `platform` ('tiktok'|'reddit'), `post_id`, `url`, `author`, `published_at`, `engagement_json`, `subreddit?`, `retrieval_provider?` ('native'|'perplexity')
- **`comment`**: `id`, `source_post_id`, `author`, `text`, `likes`, `published_at`, `lang?`
- **`place_mention`**: `id`, `place_id`, `source_post_id`, `comment_id?`, `confidence`, `name_variants`
- **`place_insight`**: `id`, `place_id`, `run_id`, `vibe_tags[]`, `pros[]`, `cons[]`, `tips[]`, `summary`, `scores_json`, `uncertainty`, `dress_code?`, `busyness_wait?`, `must_orders?[]`
- **`analysis_run`**: `id`, `prompt_version`, `model`, `created_at`, `cost`, `status`
- **`user_list`**: `id`, `user_id`, `title`, `visibility`
- **`user_list_item`**: `list_id`, `place_id`, `notes`

## 10) Analysis Pipeline (LLM-first)
- **A0. Query Understanding (5-mini):**
  - Input: Raw user query text + optional location context.
  - Output: `query_intent` JSON with `normalized_type`, `neighborhood_hints[]`, `facets[]` (vibes/constraints), optional `filters` (e.g., open_now), and `notes` for what matters most.
- **A. Candidate Extraction:**
  - Input: TikTok search results (titles, captions), top comments.
  - Output: Place candidates with name variants, geo hints, confidence.
- **A2. Reddit Enrichment (Perplexity):**
  - Input: Query intent + candidate names/areas.
  - Output: Relevant Reddit threads/comments with citations and `attributes_delta` to merge.
- **A3. Satisfaction Check (per query):**
  - Compute coverage (min unique places), confidence (mean x agreement), and freshness (max age) per §21 thresholds.
  - If below threshold, enqueue targeted backfill for missing place types/areas.
- **B. Entity Resolution:**
  - Use Maps/Places to normalize; collapse duplicates; attach lat/lng.
- **C. Comment Understanding:**
  - Classify sentiments and extract attributes: quality, service, wait, crowd, noise, price, accessibility, ambience. Detect language and aggregate per-lang when needed.
- **D. Scoring:**
  - Compute 0–10 per attribute; include sample size and recency weighting; add uncertainty.
- **E. Summarization:**
  - Produce vibe tags, 3–5 pros/cons, and 2–3 “know before you go” tips.
- **F. Evidence:**
  - Keep top cited snippets with links and timestamps; re-verify citations on refresh and drop dead links.
 - **G. LLM Rerank (5-mini):**
  - Input: `query_intent` + batch of candidate `place_insight` JSONs (top-K by coarse prefilter like polygon and type).
  - Output: Per-place `fit_score` (0–100), `rationale`, and optional `flags` (e.g., "outlier", "insufficient evidence").

## 11) Prompt & Output Contracts (5-mini)
- **Query Understanding Prompt:** Given a free-text query, output `query_intent` JSON: `normalized_type`, `neighborhood_hints[]`, `facets[]` (vibes/needs), `filters{open_now?, price_band?}`, and `notes` (e.g., espresso quality, quiet, work-friendly). No code-side mappings.
- **Extraction Prompt:** Given captions+comments, output JSON of `candidates[{name, clues, confidence}]`.
- **Resolution Prompt:** When multiple candidates map to one entity, output `canonical_name`, `merged_variants`.
- **Attribute Prompt:** For a place with comments, output `scores{quality, value, service, wait, atmosphere}`, `vibe_tags[]`, `pros[]`, `cons[]`, `tips[]`, with `evidence[{quote, url, ts}]` and `uncertainty`.
- **Format:** Strict JSON with schema version and token budgets tuned for 5-mini.
- **Perplexity Query Template:** Provide intent and candidate names; request JSON with `threads[{title, url, subreddit, created_at}]`, `citations[{quote, url, ts}]`, and `attributes_delta` to merge into scoring.
 - **Rerank Prompt:** Given `query_intent` and a batch of `place_insight` JSONs, return `{ place_id, fit_score(0-100), rationale, flags[] }` per place. The LLM determines relevance; code does not apply semantic weights.

## 12) Ranking & Reranking
- **LLM First:** 5-mini computes per-place `fit_score` using `query_intent` and each `place_insight` (batch inference, top-K candidates).
- **Deterministic Tie-Breakers (only if needed):** Distance within polygon and explicit filters (e.g., open-now) for ties or explicit constraints; otherwise defer to LLM `fit_score`.
- **Confidence Handling:** If `uncertainty` is high or evidence sparse, LLM may lower `fit_score` or add `flags`; UI reflects this with confidence chips.

## 13) UX Overview
- **Search Bar:** Keyword + location; quick filter chips (price, open now, vibes).
- **Results List + Map:** Cards with score, tags, 1–2 quotes, distance, open/closed.
- **Place Detail:** Vibe radar, pros/cons, tips, hours, photos, evidence links, recency indicator.
- **Lists:** Save, reorder, share public link.
 - **Modes:** Toggle between Map View and Swipe Deck; mode persists per query.
 - **Swipe Deck:** Full-screen cards; Left=dismiss, Right=shortlist, Up=Go Now; on-screen buttons mirror gestures; undo last swipe.
 - **Shortlist Drawer:** Session shortlist for the current query; reorder/remove; compare view.
 - **Go Now:** After Up-swipe, show sheet with directions links (Apple/Google/Uber), open/busy hint, dress code, prep tips, must-orders, quick actions (call/site/share).

## 14) Performance & Cost
- **Search P95:** < 2.5s warm / < 6s cold; detail P95 < 2s.
- **Rerank Budget:** Rerank top-K (e.g., 40–60) per query in a batched 5-mini call; incremental latency < 400–800ms when warm.
- **Backfill:** Kickoff < 2s; first incremental update < 30s.
- **Cost:** 5-mini cost bounded via top-K batching and caching; Perplexity per-query/day caps.

## 15) Security & Reliability
- **Rate Limiting:** Per-IP and per-user; circuit breakers on ingestion.
- **Backoff & Retries:** Exponential for network/LLM calls; idempotent runs.
- **Data Validation:** JSON schema checks for all LLM outputs.
- **Secrets:** Use environment vars; no secrets client-side.

## 16) Tech Stack
- **Frontend:** Flutter (Dart) targeting iOS, Android, Web; responsive layouts; Material 3.
- **State:** Riverpod or Bloc for app state; go_router for navigation (web-friendly routes).
 - **Backend:** Vercel Functions/Edge (Node/Next); Zod for schemas; Prisma/TypeORM.
 - **Data:** Supabase Postgres (+ pgvector optional) and Supabase Storage; Realtime for change feeds.
- **LLM:** OpenAI 5-mini (default); optional batch mode for cost.
- **Enrichment Provider:** Perplexity Pro (Reddit-focused queries with citations).
- **Maps:** `google_maps_flutter` (+ `google_maps_flutter_web`) or `mapbox_gl` alternative; Places/Geocoding API.
- **Charts:** `spider_chart` (radar) or `fl_chart` if radar supported.
- **Icons:** Material Icons; custom SVGs for TikTok/Reddit badges.
 - **Realtime:** Supabase Realtime channels (WebSocket); polling fallback on web if needed.
 - **Deploy:** Flutter Web on Vercel; API on Vercel Functions/Edge; Cloudflare Workers/Queues for jobs.
- **Obs:** Sentry (Flutter + backend), Logtail, simple Prometheus-style metrics.
 - **Realtime UX:** Live re-rank via Supabase Realtime; optional push later.

## 17) MVP Scope Checklist
- Query → ingest TikTok → analyze → list+map → detail with citations → save lists.
- Optional: Perplexity-powered Reddit enrichment for corroboration and gap-filling.
- Stored-first search with background backfill for low-coverage queries.

## 18) Risks & Mitigations
- **API/ToS Changes:** Abstract ingestion; allow partner providers; feature flag.
- **Noisy/Spam Comments:** Heuristics + LLM spam classifier + down-rank.
- **Entity Ambiguity:** Force user confirmation when multiple candidates tie; show map pins.
- **Cold Start Cities:** Seed with curated lists; background crawl for major queries.
- **Latency/Cost:** Batch comments, cache embeddings/summaries, reuse results per place.
- **Provider Dependency:** Perplexity availability/cost; add caching, timeouts, and a kill-switch.
- **Cold Start Queries:** Pre-warm canonical neighborhood queries; fall back to broader radius; surface "still gathering" state.
 - **Gesture Discoverability:** Provide visible buttons and hints alongside swipes; full keyboard support; clear undo.

## 21) Stored-First Strategy (Details)
- **Satisfaction Thresholds (adaptive):**
  - Coverage: max(10, min(20, 0.15 × known places in polygon)).
  - Confidence: mean ≥ 0.65 with ≤ 30% high-uncertainty items.
  - Freshness: ≥ 60% refreshed ≤ 14d; ≤ 7d if trending.
- **Fallback Flow:**
  1) Return partial results immediately, labeled “Refreshing results”.
  2) Enqueue `query_backfill` with missing facets (e.g., brunch-friendly cafes in Kadıköy).
  3) Stream updates via Supabase Realtime channel; reorder as new insights land.
- **Caching:**
  - Query cache TTL 24h with stale-while-revalidate; invalidate on material place changes.
  - Place insight TTL 3–7d; faster (24–72h) for trending or conflicting claims.
  - Citations re-verified on refresh; drop dead links.
- **Cost Guards:**
  - Per-query budget caps; prioritize TikTok-first then selective Perplexity pulls for gaps.
  - Deduplicate by `place_id` and `source_post.post_id`; reuse summaries across nearby queries.

## 19) Metrics
- **Search CTR, Save Rate, Share Rate**
- **Session Time to Decision**
- **Place Detail Engagement (evidence opens)**
- **Return Rate within 7/30 days**
- **Coverage per city and freshness**
 - **Swipe Engagement & Shortlist Adds**
 - **Directions/Go Now CTR**

## 20) Roadmap (Post-MVP)
- Personalization by taste profile; collaborative lists; lightweight creator dashboards.
- Multi-source ingestion (IG, Reddit); menu/item-level insights; on-device offline shortlist.

---

Last updated: YYYY-MM-DD
 
## 22) Backend & Infra (Providers)
- **Supabase:** Postgres (pgvector optional), Storage (images), Realtime (change feeds), optional Auth for lists.
- **Cloudflare:** Workers (background jobs + schedulers), Queues (ingestion/enrichment/analysis pipelines), Cache (edge API caching + purge).
- **Vercel:** Functions/Edge for public API (`/search`, `/places/:id`, `/areas/*`), Flutter Web hosting, environment management.
- **Domains/DNS:** Cloudflare-managed DNS; proxied through Cloudflare for CDN and security.
- **Observability:** Sentry (client+server), Vercel + Cloudflare logs; cost/queue metrics dashboard.
