// Compact number formatting for stat cards and chart axes.
export function compact(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
	return String(n);
}

// Estimated spend at the Sumopod promo rate (per 1M tokens).
export function estCost(prompt: number, completion: number): string {
	const usd = (prompt * 0.03 + completion * 0.12) / 1_000_000;
	if (usd < 0.01) return '<$0.01';
	return '$' + usd.toFixed(2);
}
