<script lang="ts">
	import { Tooltip } from 'bits-ui';
	import { mode, toggleMode } from 'mode-watcher';
	import Icon from '$lib/components/Icon.svelte';
	import halfMoon from '$lib/icons/half-moon.json';
	import sunLight from '$lib/icons/sun-light.json';
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger
			onclick={toggleMode}
			aria-label="Toggle theme"
			class="rounded-md border border-line bg-raised p-2 text-ink hover:bg-chrome"
		>
			{#if $mode === 'dark'}
				<Icon data={sunLight} size={16} />
			{:else}
				<Icon data={halfMoon} size={16} />
			{/if}
		</Tooltip.Trigger>
		<Tooltip.Content class="rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink">
			Toggle light and dark
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
