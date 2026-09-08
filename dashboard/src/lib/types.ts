// Mirrors the Go /metrics payload (snake_case JSON from internal/metrics).
export interface Totals {
	turns: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	errors: number;
}

export interface DayUsage {
	day: string;
	turns: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	errors: number;
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

export interface MetricsPayload {
	totals: Totals;
	daily: DayUsage[];
	recent_errors: TurnError[];
	conversations: ConversationInfo[];
}
