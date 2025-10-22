import OpenAI from 'openai';
import { tryParseJSON } from './json.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function llmJSON(system: string, user: string, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.2
    }, { signal: controller.signal });
    const text = resp.choices?.[0]?.message?.content ?? '';
    const parsed = tryParseJSON(text);
    if (parsed.ok) return parsed.value;
    // One retry with explicit instruction
    const retry = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      messages: [
        { role: 'system', content: system + '\nReturn only valid JSON. No prose.' },
        { role: 'user', content: user }
      ],
      temperature: 0.1
    }, { signal: controller.signal });
    const text2 = retry.choices?.[0]?.message?.content ?? '';
    const parsed2 = tryParseJSON(text2);
    if (parsed2.ok) return parsed2.value;
    throw new Error('LLM JSON parse failed');
  } finally {
    clearTimeout(id);
  }
}

