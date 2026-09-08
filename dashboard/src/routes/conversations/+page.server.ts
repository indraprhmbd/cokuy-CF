import type { PageServerLoad } from './$types';
import { fetchMetrics } from '$lib/server/metrics';

export const load: PageServerLoad = async ({ fetch }) => {
	return { metrics: await fetchMetrics(fetch, 30) };
};
