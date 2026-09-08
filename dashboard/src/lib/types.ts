// Mirrors the Go /metrics payload (snake_case JSON from internal/metrics).
// Vendored Iconoir path data (see src/lib/icons/*.json, MIT licensed).
export interface IconData {
	name: string;
	data: Record<string, string | number | undefined>[];
}

export interface Totals {
	turns: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	errors: number;
	cost_usd: number;
}

export interface DayUsage {
	day: string;
	turns: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	errors: number;
	cost_usd: number;
}

export interface TurnError {
	update_id: number;
	model: string;
	error: string;
	created_at: string;
}

export interface ConversationInfo {
	chat_id: number;
	messages: number;
	last_activity: string;
}

export interface Pricing {
	price_in_per_m: number;
	price_out_per_m: number;
	currency: string;
}

export interface MetricsPayload {
	totals: Totals;
	daily: DayUsage[];
	recent_errors: TurnError[];
	conversations: ConversationInfo[];
	pricing: Pricing;
}
