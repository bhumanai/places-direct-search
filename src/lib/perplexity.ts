import fetch from 'node-fetch';
import { tryParseJSON } from './json.js';

const PPLX_ENDPOINT = 'https://api.perplexity.ai/chat/completions';

export async function perplexityJSON(prompt: string, timeoutMs = 25000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const resp = await fetch(PPLX_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: 'You are a retrieval assistant. Return STRICT JSON only matching the schema requested. No commentary.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1
      }),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error(`Perplexity HTTP ${resp.status}`);
    const data: any = await resp.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    const parsed = tryParseJSON(text);
    if (parsed.ok) return parsed.value;
    throw new Error('Perplexity JSON parse failed');
  } finally {
    clearTimeout(id);
  }
}

