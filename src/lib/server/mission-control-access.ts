export type MissionControlAccessMode = 'hosted' | 'lan' | 'local-only';

export interface MissionControlAccess {
	mode: MissionControlAccessMode;
	url: string | null;
	mobileReachable: boolean;
	message: string;
	privacy: {
		defaultPayload: 'status-metadata';
		privatePayloadsStayLocal: boolean;
	};
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const LAN_HOST_PATTERNS = [
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[0-1])\./,
	/^169\.254\./
];

function envValue(name: string): string | null {
	const value = process.env[name]?.trim();
	return value ? value : null;
}

function normalizeBaseUrl(value: string | null): URL | null {
	if (!value) return null;
	try {
		return new URL(value.endsWith('/') ? value : `${value}/`);
	} catch (err: unknown) {
			console.warn('[spark-compete] caught error:', err);
		return null;
	}
}

function isLoopbackUrl(url: URL): boolean {
	return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

function isLanUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	return LAN_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function appendPath(base: URL, path: string): string {
	const cleanPath = path.startsWith('/') ? path.slice(1) : path;
	return new URL(cleanPath, base).toString();
}

export function missionControlPathForMission(missionId: string | null | undefined): string {
	const cleanMissionId = typeof missionId === 'string' ? missionId.trim() : '';
	return cleanMissionId ? `/missions/${encodeURIComponent(cleanMissionId)}` : '/kanban';
}

export function resolveMissionControlAccess(path = '/kanban'): MissionControlAccess {
	const publicBase = normalizeBaseUrl(
		envValue('SPAWNER_MISSION_CONTROL_PUBLIC_URL') ||
			envValue('MISSION_CONTROL_PUBLIC_URL') ||
			envValue('SPARK_MISSION_CONTROL_PUBLIC_URL')
	);

	if (publicBase && !isLoopbackUrl(publicBase)) {
		const hosted = publicBase.protocol === 'https:' && !isLanUrl(publicBase);
		return {
			mode: hosted ? 'hosted' : 'lan',
			url: appendPath(publicBase, path),
			mobileReachable: hosted,
			message: hosted
				? 'Mission Control is available from mobile through the configured hosted URL.'
				: 'Mission Control uses a network URL that only works when the phone can reach the same private network.',
			privacy: {
				defaultPayload: 'status-metadata',
				privatePayloadsStayLocal: true
			}
		};
	}

	const lanBase = normalizeBaseUrl(envValue('SPAWNER_MISSION_CONTROL_LAN_URL') || envValue('MISSION_CONTROL_LAN_URL'));
	if (lanBase && !isLoopbackUrl(lanBase)) {
		return {
			mode: 'lan',
			url: appendPath(lanBase, path),
			mobileReachable: false,
			message: 'Mission Control is available only when the phone is on the same private network as this computer.',
			privacy: {
				defaultPayload: 'status-metadata',
				privatePayloadsStayLocal: true
			}
		};
	}

	return {
		mode: 'local-only',
		url: null,
		mobileReachable: false,
		message: 'Mission Control is running locally on this computer. Localhost links will not open from Telegram on a phone.',
		privacy: {
			defaultPayload: 'status-metadata',
			privatePayloadsStayLocal: true
		}
	};
}
