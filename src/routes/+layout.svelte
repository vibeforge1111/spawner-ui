<script lang="ts">
	import { logger } from '$lib/utils/logger';
	import '../app.css';
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { syncClient } from '$lib/services/sync-client';
	import { initPipelines } from '$lib/stores/pipelines.svelte';
	import { initPersistence } from '$lib/services/persistence';
	import ToastContainer from '$lib/components/ToastContainer.svelte';

	let { children } = $props();

	function skipToMain(event: MouseEvent) {
		event.preventDefault();
		const main = document.querySelector('main');
		if (!main) return;
		if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
		main.focus({ preventScroll: false });
		main.scrollIntoView({ block: 'start' });
	}

	// Initialize app state and optional local sync on app load
	onMount(async () => {
		if (!browser) return;

		// Initialize persistence system (schema migrations, etc.)
		const persistence = initPersistence();
		if (persistence.migrated) {
			logger.info(`[App] Data migrated from v${persistence.fromVersion} to v${persistence.toVersion}`);
		}

		// Initialize pipeline system (ensures localStorage is loaded)
		initPipelines();

		const syncWsUrl = import.meta.env.PUBLIC_SYNC_WS_URL?.trim();
		if (syncWsUrl) {
			tryConnectSync(syncWsUrl);
		}
	});

	// Try to connect WebSocket for real-time sync
	async function tryConnectSync(wsUrl: string) {
		syncClient.configure({ wsUrl });
		const connected = await syncClient.connect();
		if (connected) {
			logger.info('[Sync] Real-time sync connected');
		} else {
			logger.info('[Sync] WebSocket not available, using polling');
		}
	}

	// Cleanup on unmount
	onDestroy(() => {
		if (browser) {
			syncClient.disconnect();
		}
	});
</script>

<svelte:head>
	<link rel="icon" type="image/png" href="/logo.png" />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet" />
	<title>Spawner - Visual Orchestration for AI Skill Chains</title>
	<meta name="description" content="Build AI workflows visually. Connect skills, validate with sharp edges, deploy anywhere." />
</svelte:head>

<a class="skip-link" href="#main-content" onclick={skipToMain}>Skip to main content</a>

{@render children()}
<ToastContainer />

<style>
	.skip-link {
		position: absolute; top: -100px; left: 0; z-index: 100;
		padding: 12px 16px; background: var(--accent, #2fca94);
		color: var(--accent-fg, #0a3820); font: 600 14px/1 ui-sans-serif, system-ui, sans-serif;
		text-decoration: none; border-radius: 0 0 6px 0;
	}
	.skip-link:focus { top: 0; outline: 2px solid var(--text-bright, #fff); outline-offset: 2px; }
</style>
