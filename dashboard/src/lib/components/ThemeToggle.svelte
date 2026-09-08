<script lang="ts">
	import { HalfMoon, SunLight } from '@indaco/svelte-iconoir';
	import { Tooltip } from 'bits-ui';
	import { mode, toggleMode } from 'mode-watcher';
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger
			onclick={toggleMode}
			aria-label="Toggle theme"
			class="rounded-md border border-line bg-raised p-2 text-ink hover:bg-chrome"
		>
			{#if $mode === 'dark'}
				<SunLight size={16} />
			{:else}
				<HalfMoon size={16} />
			{/if}
		</Tooltip.Trigger>
		<Tooltip.Content class="rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink">
			Toggle light and dark
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
