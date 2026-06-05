<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	interface Props {
		onSubmit: (event: CustomEvent<{ name: string; url: string; description?: string }>) => void;
		onCancel: () => void;
	}

	let { onSubmit, onCancel }: Props = $props();

	let name = $state('');
	let url = $state('');
	let description = $state('');
	let testing = $state(false);
	let testResult = $state<{ success: boolean; message: string } | null>(null);

	const dispatch = createEventDispatcher<{
		submit: { name: string; url: string; description?: string };
	}>();

	async function testEndpoint() {
		if (!url) return;

		testing = true;
		testResult = null;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 5000);

			const response = await fetch(url, {
				method: 'GET',
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (response.ok) {
				testResult = { success: true, message: `Endpoint reachable (${response.status})` };
			} else {
				testResult = { success: false, message: `HTTP ${response.status}` };
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				testResult = { success: false, message: 'Request timeout' };
			} else {
				testResult = { success: false, message: 'Failed to reach endpoint (CORS or network error)' };
			}
		} finally {
			testing = false;
		}
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		if (!name.trim() || !url.trim()) return;

		// Validate URL format
		try {
			new URL(url);
		} catch {
			testResult = { success: false, message: 'Invalid URL format' };
			return;
		}

		dispatch('submit', {
			name: name.trim(),
			url: url.trim(),
			description: description.trim() || undefined,
		});
	}

	function isValidUrl(str: string): boolean {
		try {
			new URL(str);
			return true;
		} catch {
			return false;
		}
	}
</script>

<form onsubmit={handleSubmit} class="space-y-4">
	<!-- Service Name -->
	<div>
		<label for="name" class="block text-xs font-mono text-text-tertiary uppercase tracking-wider mb-1">
			Service Name *
		</label>
		<input
			id="name"
			type="text"
			bind:value={name}
			placeholder="e.g., API Gateway"
			class="w-full px-3 py-2 bg-bg-primary border border-surface-border text-text-primary text-sm font-mono focus:border-accent-primary focus:outline-none"
			required
		/>
	</div>

	<!-- Health Endpoint URL -->
	<div>
		<label for="url" class="block text-xs font-mono text-text-tertiary uppercase tracking-wider mb-1">
			Health Endpoint URL *
		</label>
		<div class="flex gap-2">
			<input
				id="url"
				type="url"
				bind:value={url}
				placeholder="https://api.example.com/health"
				class="flex-1 px-3 py-2 bg-bg-primary border border-surface-border text-text-primary text-sm font-mono focus:border-accent-primary focus:outline-none"
				required
			/>
			<button
				type="button"
				onclick={testEndpoint}
				disabled={!url || !isValidUrl(url) || testing}
				class="px-3 py-2 text-xs font-mono border border-surface-border hover:border-text-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-all"
			>
				{testing ? 'Testing...' : 'Test'}
			</button>
		</div>
		{#if testResult}
			<p
				class="mt-1 text-xs {testResult.success ? 'text-green-400' : 'text-red-400'}"
				role={testResult.success ? 'status' : 'alert'}
			>
				<span aria-hidden="true">{testResult.success ? '✓ ' : '✗ '}</span>{testResult.message}
			</p>
		{/if}
	</div>

	<!-- Description (optional) -->
	<div>
		<label for="description" class="block text-xs font-mono text-text-tertiary uppercase tracking-wider mb-1">
			Description (optional)
		</label>
		<textarea
			id="description"
			bind:value={description}
			placeholder="Brief description of this service"
			rows="2"
			class="w-full px-3 py-2 bg-bg-primary border border-surface-border text-text-primary text-sm font-mono focus:border-accent-primary focus:outline-none resize-none"
		></textarea>
	</div>

	<!-- Actions -->
	<div class="flex justify-end gap-2 pt-2">
		<button
			type="button"
			onclick={onCancel}
			class="px-4 py-2 text-sm font-mono text-text-secondary border border-surface-border hover:border-text-tertiary transition-all"
		>
			Cancel
		</button>
		<button
			type="submit"
			disabled={!name.trim() || !url.trim() || !isValidUrl(url)}
			class="px-4 py-2 text-sm font-mono bg-accent-primary text-bg-primary hover:bg-accent-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all"
		>
			Add Service
		</button>
	</div>
</form>
