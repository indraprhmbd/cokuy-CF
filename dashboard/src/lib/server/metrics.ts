import { env } from '$env/dynamic/private';
import type { MetricsPayload } from '$lib/types';

// Server only: talks to the Go metrics endpoint over loopback with the
// shared bearer token. Localhost only, never exposed publicly.
export async function fetchMetrics(
	fetchFn: typeof fetch,
	days = 30
): Promise<MetricsPayload> {
	const base = env.GO_METRICS_URL || 'http://127.0.0.1:8090';
	const res = await fetchFn(`${base}/metrics?days=${days}`, {
		headers: { Authorization: `Bearer ${env.METRICS_TOKEN || ''}` }
	});
	if (!res.ok) {
		throw new Error(`metrics endpoint returned ${res.status}`);
	}
	return (await res.json()) as MetricsPayload;
}
