import type { PageServerLoad } from './$types';
import { fetchMetrics } from '$lib/server/metrics';

export const load: PageServerLoad = async ({ fetch, url }) => {
	const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
	return { days, metrics: await fetchMetrics(fetch, days) };
};
