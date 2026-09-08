// Compact number formatting for stat cards and chart axes.
export function compact(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
	return String(n);
}

// USD formatting for server-computed spend (cost_usd in the payload).
export function usd(v: number): string {
	if (v < 0.01) return '<$0.01';
	if (v < 1000) return '$' + v.toFixed(2);
	return '$' + v.toFixed(0);
}
