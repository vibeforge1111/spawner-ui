/**
 * CSRF Token Validation
 *
 * SvelteKit 2 has built-in CSRF protection for form actions (checking Origin header),
 * but API routes (+server.ts) are not protected by default. This module provides
 * token-based CSRF validation for state-changing API endpoints.
 *
 * Flow:
 * 1. hooks.server.ts generates a token and stores it in a cookie + event.locals
 * 2. Client reads the token (e.g., from a meta tag or cookie) and sends it as
 *    a header on mutating requests
 * 3. API routes call validateCsrfToken() to verify the token matches
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CSRF_COOKIE_NAME = '__csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_TOKEN_LENGTH = 32;
const CSRF_TOKEN_MAX_AGE = 60 * 60; // 1 hour

/**
 * Generate a new CSRF token and store it in a cookie.
 * Returns the token string for use in locals / meta tags.
 */
export function generateCsrfToken(): string {
	return randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
}

/**
 * Hash a token for storage comparison (constant-time safe).
 */
function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Set the CSRF cookie on the response.
 */
export function setCsrfCookie(response: Response, token: string): Response {
	response.headers.append(
		'Set-Cookie',
		`${CSRF_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${CSRF_TOKEN_MAX_AGE}`
	);
	return response;
}

/**
 * Get the CSRF token from the request cookie.
 */
export function getCsrfTokenFromCookie(request: Request): string | null {
	const cookieHeader = request.headers.get('cookie') || '';
	const match = cookieHeader.match(new RegExp(`${CSRF_COOKIE_NAME}=([a-f0-9]+)`));
	return match ? match[1] : null;
}

/**
 * Validate that the token from the header matches the token from the cookie.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @returns true if valid, false if invalid
 */
export function validateCsrfToken(request: Request): boolean {
	const cookieToken = getCsrfTokenFromCookie(request);
	const headerToken = request.headers.get(CSRF_HEADER_NAME);

	if (!cookieToken || !headerToken) return false;

	try {
		const cookieHash = Buffer.from(hashToken(cookieToken));
		const headerHash = Buffer.from(hashToken(headerToken));
		return cookieHash.length === headerHash.length && timingSafeEqual(cookieHash, headerHash);
	} catch {
		return false;
	}
}

/**
 * Middleware helper: reject a request if CSRF validation fails.
 * Returns null if valid, or a Response with 403 if invalid.
 */
export function rejectIfCsrfInvalid(request: Request): Response | null {
	if (!validateCsrfToken(request)) {
		return new Response(
			JSON.stringify({ success: false, error: 'CSRF token validation failed' }),
			{ status: 403, headers: { 'content-type': 'application/json' } }
		);
	}
	return null;
}
