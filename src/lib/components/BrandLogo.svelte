<!--
	Spark family wordmark — ported from spark-swarm/apps/web/src/components/BrandLogo.tsx.
	Renders SparkMark (curl in accent) + "spark" wordmark + `/spawner` product tag.
-->
<script lang="ts">
	type Size = 'sm' | 'md' | 'lg';
	let {
		size = 'md' as Size,
		showWordmark = true,
		showProduct = true,
		href = '/',
		class: klass = ''
	}: {
		size?: Size;
		showWordmark?: boolean;
		showProduct?: boolean;
		href?: string;
		class?: string;
	} = $props();

	const SIZE_MAP: Record<Size, { gap: string; mark: string; wordmark: string; divider: string; product: string }> = {
		sm: { gap: 'gap-2',   mark: 'w-[26px]', wordmark: 'w-[64px]', divider: 'h-4',    product: 'text-[11px]' },
		md: { gap: 'gap-2.5', mark: 'w-[32px]', wordmark: 'w-[82px]', divider: 'h-5',    product: 'text-[12px]' },
		lg: { gap: 'gap-3',   mark: 'w-[40px]', wordmark: 'w-[104px]', divider: 'h-6',   product: 'text-[13px]' }
	};
	const c = $derived(SIZE_MAP[size]);
</script>

<a {href} class="inline-flex items-center min-w-0 group {c.gap} {klass}" aria-label={showProduct ? 'Spark Spawner home' : 'Spark home'}>
	<svg
		viewBox="0 0 264 113"
		preserveAspectRatio="xMidYMid meet"
		aria-hidden="true"
		class="block shrink-0 h-auto text-accent-primary {c.mark}"
		fill="none"
		style="shape-rendering: geometricPrecision;"
	>
		<path
			fill="currentColor"
			d="M189.07 0.85c-24.3 4.4-39.5 14.7-80.5 54.5-35.2 34.2-37.3 35.9-49.8 39.7-18.4 5.6-39.1-3.2-47.4-20-6.5-13.2-2.6-32.5 8.4-42.1 8.7-7.7 14.1-9.6 27.3-9.6 14.7 0 19.4 2.1 37.4 16.5 12.8 10.3 12.8 10.3 15.4 7.6 2.7-2.7 2.7-2.7-1.3-6.2-25.2-21.9-34.3-26.7-51-26.8-14.7 0-25.7 4.6-35 14.6-30.7 33.2-.9 83.4 44.4 74.8 14-2.6 23.6-9.7 54.3-39.8 46.8-46 63.7-56.2 92.8-56.3 61.2-.1 73.1 80.1 14.2 95.2-24 6.1-50.2-3-81.4-28.3-10.1-8.2-11.3-8.6-14.6-4.5-2.7 3.3 25.8 25.1 43.3 33.2 31.9 14.8 63.1 11.8 82.9-8 31.2-31.2 15.8-83.8-27.5-94-6.8-1.6-24.1-1.8-31.9-.5Z"
		/>
	</svg>

	{#if showWordmark}
		<svg
			viewBox="0 0 218 59"
			preserveAspectRatio="xMidYMid meet"
			aria-hidden="true"
			class="block shrink-0 h-auto text-text-primary {c.wordmark}"
			fill="none"
			style="shape-rendering: geometricPrecision;"
		>
			<g transform="translate(-0.253195,59) scale(0.1,-0.1)" fill="currentColor">
				<path d="M52 435c-38-16-56-56-47-101 9-50 42-65 153-69 100-3 122-13 122-55 0-40-31-50-153-50-112 0-117-1-117-21 0-20 4-20 129-17 155 4 181 17 181 94 0 66-30 84-136 84-101 0-130 10-137 45-9 52 18 65 143 65 103 0 110 1 110 20 0 26-192 29-248 5Z" />
				<path d="M573 443c-31-6-70-48-77-84-14-72-7-349 9-356 24-9 28 1 31 74 1 38 3 69 3 71 1 1 14-4 31-13 73-38 229-11 257 45 17 34 16 163-1 204-23 56-134 82-253 59Zm180-44c63-29 64-209 2-233-53-20-187-2-207 28-10 14-10 168 0 182 22 33 151 48 205 23Z" />
				<path d="M1152 443c-10-4-162-303-162-319 0-2 10-4 23-4 19 0 31 21 86 140 35 77 70 140 76 140 6 0 22-24 34-52 82-188 104-228 127-228l23 0-18 43c-113 256-142 299-189 280Z" />
				<path d="M1520 285c0-158 1-165 20-165 19 0 20 7 20 114 0 63 3 122 6 131 10 25 58 45 109 45 38 0 45 3 45 20 0 25-79 28-124 5-35-18-36-18-36 0 0 8-9 15-20 15-19 0-20-7-20-165Z" />
				<path d="M1880 355c0-228 1-235 20-235 16 0 20 7 20 33 0 26 10 42 46 77l45 45 37-40c20-22 51-57 67-78 23-30 37-38 55-35 23 3 21 6-35 73-33 39-66 78-74 88-13 16-8 25 60 93 72 72 73 74 44 74-25 0-48-18-130-100-55-55-103-100-107-100-5 0-8 77-8 170 0 163-1 170-20 170-19 0-20-7-20-235Z" />
			</g>
		</svg>

		{#if showProduct}
			<span class="w-px shrink-0 bg-surface-border-strong/80 {c.divider}"></span>
			<span class="shrink-0 font-mono font-medium tracking-[0.02em] text-text-secondary/90 {c.product}">
				<span class="text-accent-primary">/</span>spawner
			</span>
		{/if}
	{/if}
</a>
