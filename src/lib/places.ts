import fetch from 'node-fetch';

export type PlaceResolution = {
  name: string;
  lat: number | null;
  lng: number | null;
  address?: string;
  place_id?: string;
};

export async function resolvePlaceText(name: string, cityHint?: string, timeoutMs = 20000): Promise<PlaceResolution> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const query = encodeURIComponent(`${name} ${cityHint ?? ''}`.trim());
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${process.env.GOOGLE_PLACES_API_KEY}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return { name, lat: null, lng: null };
    const data: any = await resp.json();
    const first = data?.results?.[0];
    if (!first) return { name, lat: null, lng: null };
    return {
      name: first.name || name,
      lat: first.geometry?.location?.lat ?? null,
      lng: first.geometry?.location?.lng ?? null,
      address: first.formatted_address,
      place_id: first.place_id
    };
  } catch {
    return { name, lat: null, lng: null };
  } finally {
    clearTimeout(id);
  }
}

