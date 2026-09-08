<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { BarChart as BarChartIcon, Dashboard, List, MessageText } from '@indaco/svelte-iconoir';
	import { ModeWatcher } from 'mode-watcher';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { cn } from '$lib/utils';

	const links = [
		{ href: '/', label: 'Overview', icon: Dashboard },
		{ href: '/conversations', label: 'Conversations', icon: MessageText },
		{ href: '/logs', label: 'Logs', icon: List }
	];
</script>

<ModeWatcher />

<div class="flex min-h-screen">
	<aside class="flex w-56 shrink-0 flex-col gap-1 border-r border-line bg-chrome p-3">
		<p class="px-2 py-2 text-sm font-semibold tracking-tight">Cokuy Monitor</p>
		<nav class="flex flex-col gap-1">
			{#each links as l (l.href)}
				<a
					href={l.href}
					class={cn(
						'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
						page.url.pathname === l.href
							? 'bg-canvas font-medium text-ink shadow-sm'
							: 'text-subtle hover:bg-canvas hover:text-ink'
					)}
				>
					<svelte:component this={l.icon} size={16} />
					{l.label}
				</a>
			{/each}
		</nav>
		<div class="mt-auto flex items-center justify-between px-2 py-1 text-xs text-subtle">
			<span class="flex items-center gap-1.5">
				<BarChartIcon size={14} />
				local only
			</span>
			<ThemeToggle />
		</div>
	</aside>
	<main class="min-w-0 flex-1 p-6">
		<slot />
	</main>
</div>
