import type { VercelRequest, VercelResponse } from '@vercel/node';
import { QueryBodySchema, IntentSchema, SourceResponseSchema, CandidateListSchema, ResolvedPlaceSchema, PlaceAttributesSchema, RerankItemSchema } from '../src/lib/schemas.js';
import { llmJSON } from '../src/lib/openai.js';
import { perplexityJSON } from '../src/lib/perplexity.js';
import { resolvePlaceText } from '../src/lib/places.js';
import pLimit from 'p-limit';

function bad(res: VercelResponse, code: number, error_code: string, message: string) {
  return res.status(code).json({ error_code, message });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const request_id = Math.random().toString(36).slice(2);
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed', 'Use POST');
  const parse = QueryBodySchema.safeParse(req.body ?? {});
  if (!parse.success) return bad(res, 400, 'invalid_body', parse.error.message);
  const body = parse.data;

  const t0 = Date.now();
  try {
    // A0: Query Understanding
    const intentRaw = await llmJSON(
      'Turn free-text place search into strict JSON intent. Return ONLY valid JSON. No prose.',
      `QUERY: ${body.query}\nSCHEMA:{"normalized_type":"cafe|restaurant|bar|hotel|...","neighborhood_hints":["..."],"facets":["vibe or need"],"filters":{"open_now":bool|null,"price_band":"$|$$|$$$|$$$$|null"},"notes":"..."}`,
      1500
    );
    const intentParse = IntentSchema.safeParse(intentRaw);
    if (!intentParse.success) return bad(res, 502, 'intent_parse_failed', 'LLM intent output invalid');
    const intent = intentParse.data;

    const nbh = intent.neighborhood_hints[0] || '';
    const city = 'Istanbul';
    const fingerprint = `v1|${city.toLowerCase()}|${nbh.toLowerCase()}|${intent.normalized_type}|facets:${intent.facets.join(',')}|mode:direct`;

    // S1: Perplexity retrieval (parallel)
    const tikTokPrompt = `Find recent TikTok videos about "${intent.normalized_type}" in ${nbh || city} matching facets: ${intent.facets.join(', ')}. Return JSON: {"items":[{"title":"","url":"","author":"","created_at":"","snippet":""}...]}.`;
    const redditPrompt = `Find relevant Reddit threads/comments about "${intent.normalized_type}" in ${nbh || city} (e.g., r/istanbul, coffee subs). Focus on ${intent.facets.join(', ')}. Return JSON items array with title,url,author,created_at,snippet.`;

    const [tikTokRaw, redditRaw] = await Promise.allSettled([
      perplexityJSON(tikTokPrompt, 2500),
      perplexityJSON(redditPrompt, 2500)
    ]);

    const source_fetch: Record<string, string> = { tiktok: tikTokRaw.status === 'fulfilled' ? 'ok' : 'fail', reddit: redditRaw.status === 'fulfilled' ? 'ok' : 'fail' };
    const tikTokItems = tikTokRaw.status === 'fulfilled' ? SourceResponseSchema.safeParse(tikTokRaw.value).success ? (tikTokRaw.value as any).items : [] : [];
    const redditItems = redditRaw.status === 'fulfilled' ? SourceResponseSchema.safeParse(redditRaw.value).success ? (redditRaw.value as any).items : [] : [];

    // X: Candidate extraction
    const combined = [...tikTokItems, ...redditItems];
    const evidenceDigest = combined.map((i: any) => `- ${i.title} | ${i.url} | ${i.snippet || ''}`).join('\n');
    const extractionRaw = await llmJSON(
      'Extract candidate place names from provided items. Return ONLY JSON {"candidates":[{"name":"","clues":"","source_urls":[""],"confidence":0-1}...]}.',
      `ITEMS:\n${evidenceDigest}`,
      1500
    );
    const extracted = CandidateListSchema.safeParse(extractionRaw);
    if (!extracted.success) return bad(res, 502, 'candidate_parse_failed', 'LLM candidate output invalid');
    const candidates = extracted.data.candidates.slice(0, 40); // cap

    // R: Entity resolution
    const limit = pLimit(8);
    const resolved = await Promise.all(candidates.map((c, idx) => limit(async () => {
      const r = await resolvePlaceText(c.name, `${nbh} ${city}`, 2000);
      return ResolvedPlaceSchema.parse({
        temp_id: `c${idx}`,
        name: r.name,
        lat: r.lat,
        lng: r.lng,
        address: r.address,
        place_id: r.place_id,
        evidence: [{ source: 'mixed', url: (c.source_urls[0] || ''), quote: c.clues }].filter(e => !!e.url)
      });
    })));

    // Dedupe by place_id/name+geo
    const map = new Map<string, any>();
    for (const p of resolved) {
      const key = p.place_id || `${p.name.toLowerCase()}|${p.lat?.toFixed(4)}|${p.lng?.toFixed(4)}`;
      if (!map.has(key)) map.set(key, p);
    }
    const places = Array.from(map.values()).slice(0, body.limit);

    // A1: Attribute summarization
    const attrs = await Promise.all(places.map(async (p) => {
      const sumRaw = await llmJSON(
        'Summarize and score attributes from evidence for a place. Return ONLY JSON {summary,vibe_tags,scores,uncertainty,pros,cons,tips}.',
        `PLACE:${p.name}\nEVIDENCE:${p.evidence?.map((e: any) => `${e.url} | ${e.quote || ''}`).join('\n')}`,
        2500
      );
      const parsed = PlaceAttributesSchema.safeParse({ place_id: p.place_id || p.temp_id, ...(sumRaw as any) });
      if (parsed.success) return parsed.data; else return { place_id: p.place_id || p.temp_id, summary: '', vibe_tags: [], scores: {}, uncertainty: 0.4, pros: [], cons: [], tips: [] };
    }));

    // G: Rerank
    const rerankRaw = await llmJSON(
      'Rank places by fit to the query intent using only provided JSON. Return ONLY JSON array of {place_id,fit_score,rationale,flags}.',
      JSON.stringify({ query_intent: intent, candidates: attrs }),
      1200
    );
    const rerankedArray = Array.isArray(rerankRaw) ? rerankRaw : [];
    const reranked = rerankedArray.map((r) => RerankItemSchema.safeParse(r)).filter((r) => r.success).map((r) => r.data);
    const byId = new Map(reranked.map(r => [r.place_id, r] as const));

    const results = places.map((p) => {
      const rr = byId.get(p.place_id || p.temp_id);
      const at = attrs.find(a => a.place_id === (p.place_id || p.temp_id));
      return {
        place_id: p.place_id || p.temp_id,
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        fit_score: rr?.fit_score ?? 50,
        rationale: rr?.rationale ?? '',
        tags: at?.vibe_tags ?? [],
        summary: at?.summary ?? '',
        citations: (p.evidence || []).map((e: any) => ({ source: e.source, url: e.url, quote: e.quote }))
      };
    }).sort((a, b) => (b.fit_score - a.fit_score));

    const latency_ms = Date.now() - t0;
    return res.status(200).json({
      query_fingerprint: fingerprint,
      meta: { source_fetch, coverage: results.length, confidence: 0.7, latency_ms },
      results
    });
  } catch (e: any) {
    return bad(res, 500, 'internal_error', e?.message || 'unknown');
  }
}

