<script lang="ts">
	import { onMount } from 'svelte';

	type MenuItem = {
		label: string;
		icon?: string;
		action: () => void;
		danger?: boolean;
		disabled?: boolean;
		shortcut?: string;
		divider?: false;
	} | {
		divider: true;
		label?: never;
		icon?: never;
		action?: never;
		danger?: never;
		disabled?: never;
		shortcut?: never;
	};

	let {
		x,
		y,
		items,
		onClose
	}: {
		x: number;
		y: number;
		items: MenuItem[];
		onClose: () => void;
	} = $props();

	let menuEl: HTMLDivElement;

	onMount(() => {
		// Adjust position if menu goes off screen.
		// Clamp to viewport edges with a small inset so the menu never lands
		// half-off-screen on narrow viewports (e.g. menu width > tap x on a phone).
		if (menuEl) {
			const rect = menuEl.getBoundingClientRect();
			const INSET = 8;
			if (rect.right > window.innerWidth) {
				menuEl.style.left = `${Math.max(INSET, x - rect.width)}px`;
			}
			if (rect.bottom > window.innerHeight) {
				menuEl.style.top = `${Math.max(INSET, y - rect.height)}px`;
			}
			// Re-clamp in case the flipped position still overflows the left/top edge
			// (happens when menu width exceeds available space on either side).
			const after = menuEl.getBoundingClientRect();
			if (after.left < 0) menuEl.style.left = `${INSET}px`;
			if (after.top < 0) menuEl.style.top = `${INSET}px`;
		}

		// Close on click outside
		function handleClickOutside(e: MouseEvent) {
			if (menuEl && !menuEl.contains(e.target as Node)) {
				onClose();
			}
		}

		// Close on escape
		function handleKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				onClose();
			}
		}

		document.addEventListener('click', handleClickOutside);
		document.addEventListener('keydown', handleKeydown);

		return () => {
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleKeydown);
		};
	});

	function handleItemClick(item: MenuItem) {
		if (item.disabled) return;
		item.action?.();
		onClose();
	}
</script>

<div
	bind:this={menuEl}
	class="context-menu"
	style="left: {x}px; top: {y}px;"
	role="menu"
>
	{#each items as item}
		{#if item.divider}
			<div class="divider"></div>
		{:else}
			<button
				class="menu-item"
				class:danger={item.danger}
				class:disabled={item.disabled}
				onclick={() => handleItemClick(item)}
				disabled={item.disabled}
				role="menuitem"
			>
				{#if item.icon}
					<span class="icon">{item.icon}</span>
				{/if}
				<span class="label">{item.label}</span>
				{#if item.shortcut}
					<span class="shortcut">{item.shortcut}</span>
				{/if}
			</button>
		{/if}
	{/each}
</div>

<style>
	.context-menu {
		position: fixed;
		z-index: 1000;
		min-width: 180px;
		background: var(--bg-secondary);
		border: 1px solid var(--surface-border);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		padding: 4px 0;
	}

	.menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		color: var(--text-primary);
		font-size: 13px;
		font-family: var(--font-mono);
		transition: background 0.1s;
	}

	.menu-item:hover:not(.disabled) {
		background: var(--surface);
	}

	.menu-item.danger {
		color: var(--status-error);
	}

	.menu-item.danger:hover:not(.disabled) {
		background: rgba(239, 68, 68, 0.1);
	}

	.menu-item.disabled {
		color: var(--text-tertiary);
		cursor: not-allowed;
	}

	.icon {
		width: 16px;
		text-align: center;
	}

	.label {
		flex: 1;
	}

	.shortcut {
		color: var(--text-tertiary);
		font-size: 11px;
	}

	.divider {
		height: 1px;
		background: var(--surface-border);
		margin: 4px 0;
	}
</style>
