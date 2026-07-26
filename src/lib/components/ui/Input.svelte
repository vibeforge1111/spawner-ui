<script lang="ts">
	interface Props {
		type?: 'text' | 'email' | 'password' | 'url' | 'search' | 'number';
		value?: string;
		placeholder?: string;
		label?: string;
		error?: string;
		disabled?: boolean;
		id?: string;
		name?: string;
		class?: string;
		oninput?: (e: Event) => void;
		onkeydown?: (e: KeyboardEvent) => void;
	}

	let {
		type = 'text',
		value = $bindable(''),
		placeholder = '',
		label = '',
		error = '',
		disabled = false,
		id = '',
		name = '',
		class: className = '',
		oninput,
		onkeydown
	}: Props = $props();

	const errorId = `input-error-${Math.random().toString(36).slice(2, 10)}`;
</script>

<div class="w-full">
	{#if label}
		<label for={id} class="block text-xs text-text-tertiary mb-1 font-mono">{label}</label>
	{/if}
	<input
		{type}
		{id}
		{name}
		{placeholder}
		{disabled}
		bind:value
		{oninput}
		{onkeydown}
		class="input {className}"
		class:border-status-error={error}
		class:focus:border-status-error={error}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? errorId : undefined}
	/>
	{#if error}
		<p id={errorId} class="mt-1 text-xs text-status-error" role="alert">{error}</p>
	{/if}
</div>
