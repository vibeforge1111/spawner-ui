<script lang="ts">
	import type { Connection, CanvasNode } from '$lib/stores/canvas.svelte';
	import { selectConnection, removeConnection } from '$lib/stores/canvas.svelte';
	import { generatePorts, getPortColor } from '$lib/utils/ports';
	import type { PortType } from '$lib/types/skill';

	let {
		connection,
		nodes,
		selected = false,
		isActive = false,
		isCompleted = false,
		hasError = false,
		nodeWidth = 224,
		nodeHeight = 96
	}: {
		connection: Connection;
		nodes: CanvasNode[];
		selected?: boolean;
		isActive?: boolean;
		isCompleted?: boolean;
		hasError?: boolean;
		nodeWidth?: number;
		nodeHeight?: number;
	} = $props();

	function handleClick(e: MouseEvent) {
		e.stopPropagation();
		selectConnection(connection.id);
	}

	function handleDelete(e: MouseEvent) {
		e.stopPropagation();
		removeConnection(connection.id);
	}

	function handleConnectionKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			selectConnection(connection.id);
		}
	}

	function handleDeleteKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			removeConnection(connection.id);
		}
	}

	const sourceNode = $derived(nodes.find((n) => n.id === connection.sourceNodeId));
	const targetNode = $derived(nodes.find((n) => n.id === connection.targetNodeId));

	// Get source port type for styling
	const sourcePortType = $derived((): PortType => {
		if (!sourceNode) return 'any';
		const ports = generatePorts({
			category: sourceNode.skill.category,
			handoffs: sourceNode.skill.handoffs,
			pairsWell: sourceNode.skill.pairsWell,
			tags: sourceNode.skill.tags
		});
		const port = ports.outputs.find(p => p.id === connection.sourcePortId);
		return port?.type || 'any';
	});

	// Get base connection color based on source port type
	const connectionColor = $derived(getPortColor(sourcePortType()));

	const visualColor = $derived(() => {
		if (hasError) return '#ff6b6b';
		if (isActive) return '#00d4aa';
		if (isCompleted) return '#34d399';
		if (selected) return '#ffffff';
		// Idle edges: always accent teal regardless of port type. Per-type
		// dasharray (from connectionStyle) still encodes type variety visually.
		return '#2FCA94';
	});

	// Get node heights based on port count
	const getNodeHeight = (node: CanvasNode) => {
		const ports = generatePorts({
			category: node.skill.category,
			handoffs: node.skill.handoffs,
			pairsWell: node.skill.pairsWell,
			tags: node.skill.tags
		});
		const maxPorts = Math.max(ports.inputs.length, ports.outputs.length);
		return Math.max(96, 46 + maxPorts * 18);
	};

	// Get port Y position within node
	const getPortY = (node: CanvasNode, portId: string, isOutput: boolean) => {
		const ports = generatePorts({
			category: node.skill.category,
			handoffs: node.skill.handoffs,
			pairsWell: node.skill.pairsWell,
			tags: node.skill.tags
		});
		const portList = isOutput ? ports.outputs : ports.inputs;
		const index = portList.findIndex(p => p.id === portId);
		const nodeH = getNodeHeight(node);
		const spacing = nodeH / (portList.length + 1);
		return spacing * (index + 1);
	};

	// Port centers sit on the node edge. Keep these in sync with SkillNode.svelte.
	const PORT_CENTER_OFFSET = 0;

	const pathD = $derived(() => {
		if (!sourceNode || !targetNode) return '';

		const startX = sourceNode.position.x + nodeWidth + PORT_CENTER_OFFSET;
		const startY = sourceNode.position.y + getPortY(sourceNode, connection.sourcePortId, true);

		const endX = targetNode.position.x - PORT_CENTER_OFFSET;
		const endY = targetNode.position.y + getPortY(targetNode, connection.targetPortId, false);

		const midX = (startX + endX) / 2;

		return 'M ' + startX + ' ' + startY +
			' C ' + midX + ' ' + startY + ', ' + midX + ' ' + endY + ', ' + endX + ' ' + endY;
	});

	// Connection style based on port type + execution state
	const connectionStyle = $derived(() => {
		const type = sourcePortType();
		let dasharray = '8 4';
		let width = 2.5;

		switch (type) {
			case 'skill':
				dasharray = '4 4';
				width = 3.25;
				break;
			case 'text':
				dasharray = '8 4';
				break;
			case 'object':
				dasharray = 'none';
				break;
			case 'array':
				dasharray = '2 2';
				break;
			case 'number':
				dasharray = '12 4';
				break;
			case 'boolean':
				dasharray = '6 2 2 2';
				break;
		}

		if (isActive) {
			dasharray = '10 6';
			width += 1.25;
		}
		if (isCompleted) {
			dasharray = 'none';
		}

		return { dasharray, width };
	});
</script>

{#if sourceNode && targetNode}
	{@const style = connectionStyle()}
	{@const color = visualColor()}
	<g class="connection-group" class:selected class:active={isActive} class:completed={isCompleted} class:error={hasError} onclick={handleClick} onkeydown={handleConnectionKeydown} role="button" tabindex="0">
		<!-- Invisible wider hit area for easier clicking -->
		<path
			d={pathD()}
			fill="none"
			stroke="transparent"
			stroke-width="16"
			class="connection-hitarea"
		/>
		<!-- Selection glow (when selected) -->
		{#if selected}
			<path
				d={pathD()}
				fill="none"
				stroke="#fff"
				stroke-width={style.width + 8}
				class="connection-selection-glow"
				opacity="0.3"
			/>
		{/if}
		<!-- Main connection line -->
		<path
			d={pathD()}
			fill="none"
			stroke={color}
			stroke-width={selected ? style.width + 1.25 : style.width}
			stroke-dasharray={style.dasharray}
			class="connection-line"
			class:animated={style.dasharray !== 'none'}
		/>
		{#if isActive}
			<circle r="3" fill={color} class="connection-traveler">
				<animateMotion dur="1.2s" repeatCount="indefinite" path={pathD()} rotate="auto" />
			</circle>
		{/if}
		<!-- Endpoint circle removed - line runs directly to port dot on node edge -->
		<!-- Delete button on hover/selected -->
		{#if selected}
			{@const midX = (sourceNode.position.x + nodeWidth + PORT_CENTER_OFFSET + targetNode.position.x - PORT_CENTER_OFFSET) / 2}
			{@const midY = (sourceNode.position.y + getPortY(sourceNode, connection.sourcePortId, true) + targetNode.position.y + getPortY(targetNode, connection.targetPortId, false)) / 2}
			<g class="delete-button" transform="translate({midX}, {midY})" onclick={handleDelete} onkeydown={handleDeleteKeydown} role="button" tabindex="0" aria-label="Delete connection">
				<rect x="-8" y="-8" width="16" height="16" fill="var(--bg-secondary, #1a1a24)" stroke="var(--status-error, #ef4444)" stroke-width="1" class="delete-bg" />
				<path d="M-4,-4 L4,4 M-4,4 L4,-4" stroke="var(--status-error, #ef4444)" stroke-width="1.5" />
			</g>
		{/if}
	</g>
{/if}

<style>
	.connection-group {
		pointer-events: none;
		cursor: pointer;
	}

	.connection-hitarea {
		pointer-events: stroke;
	}

	.connection-group:hover .connection-line,
	.connection-group.selected .connection-line {
		filter: drop-shadow(0 0 4px currentColor);
	}

	.connection-line {
		filter: drop-shadow(0 0 2px currentColor);
		transition: stroke-width 0.15s, stroke 0.15s, opacity 0.15s;
	}

	.connection-group.active .connection-line {
		filter: drop-shadow(0 0 6px currentColor);
	}

	.connection-group.completed .connection-line {
		opacity: 0.9;
	}

	.connection-group.error .connection-line {
		opacity: 0.95;
	}

	.connection-traveler {
		filter: drop-shadow(0 0 6px currentColor);
	}

	.connection-line.animated {
		animation: flow 2s linear infinite;
	}

	.connection-selection-glow {
		filter: blur(6px);
	}

	.delete-button {
		pointer-events: all;
		cursor: pointer;
	}

	.delete-button:hover .delete-bg {
		fill: var(--status-error, #ef4444);
	}

	.delete-button:hover path {
		stroke: var(--bg-primary, #0f0f17);
	}

	@keyframes flow {
		from {
			stroke-dashoffset: 24;
		}
		to {
			stroke-dashoffset: 0;
		}
	}
</style>
