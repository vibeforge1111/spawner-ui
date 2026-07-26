<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Spark Live Access</title>
</svelte:head>

<main class="min-h-screen bg-[rgb(18,20,20)] px-4 py-10 text-text-primary">
	<section class="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md flex-col justify-center">
		<div class="mb-8">
			<p class="overline text-accent-primary">Spark Live</p>
			<h1 class="mt-3 font-display text-4xl font-semibold text-text-bright">Open Mission Control</h1>
			<p class="mt-4 text-sm leading-6 text-text-secondary">
				Enter the access key from your Spark Live environment. Spark will remember this browser with a secure server-side cookie.
			</p>
		</div>

		<form method="POST" class="space-y-4 rounded-lg border border-surface-border bg-surface-primary p-5 shadow-xl shadow-black/20">
			<input type="hidden" name="next" value={form?.next || data.next || '/'} />

			{#if data.workspaceRequired}
				<label class="block">
					<span class="text-sm font-medium text-text-bright">Workspace ID</span>
					<input
						class="mt-2 w-full rounded-md border border-surface-border bg-bg-secondary px-3 py-3 font-mono text-base text-text-primary outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/30"
						name="workspaceId"
						type="text"
						autocomplete="username"
						placeholder="your-private-workspace"
						value={form?.workspaceId || ''}
						required
					/>
				</label>
			{:else}
				<input type="hidden" name="workspaceId" value={form?.workspaceId || ''} />
			{/if}

			<label class="block">
				<span class="text-sm font-medium text-text-bright">Access key</span>
				<input
					class="mt-2 w-full rounded-md border border-surface-border bg-bg-secondary px-3 py-3 font-mono text-base text-text-primary outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/30"
					name="uiKey"
					type="password"
					autocomplete="current-password"
					placeholder="Paste your Spark Live access key"
					required
				/>
			</label>

			{#if form?.message}
				<p class="rounded-md border border-status-red/30 bg-status-red/10 px-3 py-2 text-sm text-status-red">{form.message}</p>
			{/if}

			<button class="w-full rounded-md bg-accent-primary px-4 py-3 text-sm font-semibold text-accent-fg transition hover:bg-accent-hover" type="submit">
				Continue
			</button>
		</form>

		<p class="mt-5 text-xs leading-5 text-text-tertiary">
			This hosted preview is workspace-gated. Keep the ID and key private. If either is shared accidentally, rotate
			<span class="font-mono">SPARK_WORKSPACE_ID</span> and <span class="font-mono">SPARK_UI_API_KEY</span> in your host settings.
		</p>
	</section>
</main>
