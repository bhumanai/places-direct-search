import { z } from 'zod';

export const QueryBodySchema = z.object({
  query: z.string().min(3),
  mode: z.enum(["direct"]).default("direct"),
  user_location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  filters: z.object({ open_now: z.boolean().nullable().optional(), price_band: z.string().nullable().optional() }).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  debug: z.boolean().optional()
});

export type QueryBody = z.infer<typeof QueryBodySchema>;

export const IntentSchema = z.object({
  normalized_type: z.string(),
  neighborhood_hints: z.array(z.string()).default([]),
  facets: z.array(z.string()).default([]),
  filters: z.object({ open_now: z.boolean().nullable().optional(), price_band: z.string().nullable().optional() }).default({}),
  notes: z.string().default("")
});
export type Intent = z.infer<typeof IntentSchema>;

export const SourceItemSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  author: z.string().optional().default(''),
  created_at: z.string().optional().default(''),
  snippet: z.string().optional().default('')
});
export type SourceItem = z.infer<typeof SourceItemSchema>;

export const SourceResponseSchema = z.object({
  items: z.array(SourceItemSchema)
});

export const CandidateSchema = z.object({
  name: z.string(),
  clues: z.string().optional().default(''),
  source_urls: z.array(z.string().url()).default([]),
  confidence: z.number().min(0).max(1)
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidateListSchema = z.object({
  candidates: z.array(CandidateSchema)
});

export const ResolvedPlaceSchema = z.object({
  temp_id: z.string(),
  name: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  address: z.string().optional().default(''),
  place_id: z.string().optional().default(''),
  evidence: z.array(z.object({ source: z.string(), url: z.string().url(), quote: z.string().optional().default('') })).default([])
});
export type ResolvedPlace = z.infer<typeof ResolvedPlaceSchema>;

export const PlaceAttributesSchema = z.object({
  place_id: z.string(),
  summary: z.string().default(''),
  vibe_tags: z.array(z.string()).default([]),
  scores: z.object({}).passthrough().default({}),
  uncertainty: z.number().min(0).max(1).default(0.3),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  tips: z.array(z.string()).default([])
});
export type PlaceAttributes = z.infer<typeof PlaceAttributesSchema>;

export const RerankItemSchema = z.object({
  place_id: z.string(),
  fit_score: z.number().min(0).max(100),
  rationale: z.string().default(''),
  flags: z.array(z.string()).default([])
});
export type RerankItem = z.infer<typeof RerankItemSchema>;

