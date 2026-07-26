/**
 * Client-side events authentication.
 *
 * SECURITY: API keys MUST NOT be exposed in the browser bundle.
 * Previous versions read PUBLIC_EVENTS_API_KEY / PUBLIC_MCP_API_KEY via
 * import.meta.env, which embeds the values in the client JS. The server
 * already sets an HttpOnly cookie (spawner_events_api_key) after the first
 * authenticated request, so the browser sends credentials automatically
 * without ever seeing the raw key.
 *
 * For same-origin requests the cookie is sufficient. The helpers below are
 * kept for callers that still spread their results into fetch headers –
 * they return empty objects so no secret leaks into the bundle.
 */

export function getEventsApiKey(): string | null {
	// API keys are never available client-side. Authentication is handled
	// by the HttpOnly cookie set in +server.ts createAuthCookieHeader().
	return null;
}

export function withEventsAuth(path: string): string {
	return path;
}

export function getEventsAuthHeaders(): Record<string, string> {
	// No explicit headers needed – the browser sends the spawner_events_api_key
	// cookie automatically on same-origin requests.
	return {};
}
