export function tryParseJSON<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: Error } {
  try {
    const value = JSON.parse(text) as T;
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}

export function safeJSONStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return '"[unstringifiable]"';
  }
}

export function redact(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
