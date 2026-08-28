import type { Port, PortType } from '$lib/types/skill';
import type { SkillCategory } from '$lib/stores/skills.svelte';

/**
 * Generate dynamic ports based on skill category and properties
 */
export function generatePorts(skill: {
	category: string;
	handoffs?: { trigger: string; to: string }[];
	pairsWell?: string[];
	tags?: string[];
}): { inputs: Port[]; outputs: Port[] } {
	const inputs: Port[] = [];
	const outputs: Port[] = [];

	// Base input port (all skills have a primary input)
	inputs.push({
		id: 'input',
		label: 'Input',
		type: getCategoryInputType(skill.category),
		required: true
	});

	// Base output port
	outputs.push({
		id: 'output',
		label: 'Output',
		type: getCategoryOutputType(skill.category),
		required: true
	});

	// Add context port for complex skills
	if (isComplexSkill(skill.category, skill.tags)) {
		inputs.push({
			id: 'context',
			label: 'Context',
			type: 'object',
			required: false
		});
	}

	// Add config port for configurable skills
	if (isConfigurableSkill(skill.category, skill.tags)) {
		inputs.push({
			id: 'config',
			label: 'Config',
			type: 'object',
			required: false
		});
	}

	// Add handoff outputs for skills with handoffs
	if (skill.handoffs && skill.handoffs.length > 0) {
		skill.handoffs.slice(0, 2).forEach((handoff, i) => {
			outputs.push({
				id: `handoff-${i}`,
				label: handoff.to.split('-').slice(0, 2).join('-'),
				type: 'skill',
				required: false,
				skillId: handoff.to // Store full skill ID for click-to-spawn
			});
		});
	}

	// Add error output for development/integration skills
	if (['development', 'frameworks', 'integrations'].includes(skill.category)) {
		outputs.push({
			id: 'error',
			label: 'Error',
			type: 'text',
			required: false
		});
	}

	return { inputs, outputs };
}

/**
 * Get the primary input type based on category
 */
function getCategoryInputType(category: string): PortType {
	const typeMap: Record<string, PortType> = {
		development: 'text',
		frameworks: 'object',
		integrations: 'object',
		'ai-ml': 'text',
		agents: 'object',
		data: 'array',
		design: 'object',
		marketing: 'text',
		strategy: 'text',
		enterprise: 'object',
		finance: 'number',
		legal: 'text',
		science: 'object',
		startup: 'text'
	};
	return typeMap[category] || 'any';
}

/**
 * Get the primary output type based on category
 */
function getCategoryOutputType(category: string): PortType {
	const typeMap: Record<string, PortType> = {
		development: 'text',
		frameworks: 'object',
		integrations: 'object',
		'ai-ml': 'object',
		agents: 'object',
		data: 'array',
		design: 'object',
		marketing: 'text',
		strategy: 'object',
		enterprise: 'object',
		finance: 'object',
		legal: 'text',
		science: 'object',
		startup: 'object'
	};
	return typeMap[category] || 'any';
}

/**
 * Check if skill is complex and needs context
 */
function isComplexSkill(category: string, tags?: string[]): boolean {
	const complexCategories = ['ai-ml', 'agents', 'enterprise', 'strategy'];
	const complexTags = ['rag', 'llm', 'orchestration', 'workflow'];

	if (complexCategories.includes(category)) return true;
	if (tags && tags.some(t => complexTags.includes(t.toLowerCase()))) return true;

	return false;
}

/**
 * Check if skill is configurable
 */
function isConfigurableSkill(category: string, tags?: string[]): boolean {
	const configurableCategories = ['integrations', 'frameworks', 'data'];
	const configurableTags = ['api', 'database', 'auth', 'config'];

	if (configurableCategories.includes(category)) return true;
	if (tags && tags.some(t => configurableTags.includes(t.toLowerCase()))) return true;

	return false;
}

/**
 * Get port color class based on type
 */
export function getPortColorClass(type: PortType): string {
	const colorMap: Record<PortType, string> = {
		text: 'port-text',
		number: 'port-number',
		boolean: 'port-boolean',
		object: 'port-object',
		array: 'port-array',
		any: 'port-any',
		skill: 'port-skill'
	};
	return colorMap[type] || 'port-any';
}

/**
 * Get port color value based on type
 */
export function getPortColor(type: PortType): string {
	const colorMap: Record<PortType, string> = {
		text: '#00D4FF',    // cyan
		number: '#FF6B9D',  // pink
		boolean: '#00C49A', // green
		object: '#A78BFA',  // purple
		array: '#F59E0B',   // orange
		any: '#2FCA94',     // accent teal (was gray — matched spark-agent aesthetic)
		skill: '#3B82F6'    // blue
	};
	return colorMap[type] || '#6B7280';
}

/**
 * Check if two port types are compatible for connection
 * Source is the output port, target is the input port
 */
export function arePortTypesCompatible(sourceType: PortType, targetType: PortType): boolean {
	// 'any' is compatible with everything
	if (sourceType === 'any' || targetType === 'any') {
		return true;
	}

	// Same type is always compatible
	if (sourceType === targetType) {
		return true;
	}

	// Skill type (handoffs) should connect flexibly to most inputs
	// Since handoffs represent semantic workflow transitions, they should work with:
	// - skill: direct skill-to-skill handoff
	// - object: flexible data container
	// - text: marketing/strategy skills often have text inputs
	// - any: always compatible
	if (sourceType === 'skill') {
		return targetType === 'skill' || targetType === 'object' || targetType === 'text';
	}

	// Object can accept most types (flexible container)
	if (targetType === 'object') {
		return true; // Already handled skill above
	}

	// Array can accept arrays or objects
	if (targetType === 'array') {
		return sourceType === 'object' || sourceType === 'array';
	}

	// Text can be coerced from most primitive types
	if (targetType === 'text') {
		return sourceType === 'number' || sourceType === 'boolean' || sourceType === 'text';
	}

	return false;
}

/**
 * Get validation message for port type incompatibility
 */
export function getPortIncompatibilityMessage(sourceType: PortType, targetType: PortType): string {
	if (arePortTypesCompatible(sourceType, targetType)) {
		return '';
	}
	return `Cannot connect ${sourceType} output to ${targetType} input`;
}

/**
 * Check if port 3333 is busy and log warning with conflicting PID
 */
export function checkDefaultPortConflict(): void {
	if (typeof process === 'undefined' || !process.env) return;
	try {
		const { execSync } = require('node:child_process');
		const result = execSync('lsof -ti:3333 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
		if (result) {
			const pids = result.split('\n').filter(Boolean);
			console.warn(`[ports] Port 3333 is already in use by PID(s): ${pids.join(', ')}`);
		}
	} catch {
		// lsof not available or no process found, try netstat alternative
		try {
			const { execSync } = require('node:child_process');
			const result = execSync('netstat -tlnp 2>/dev/null | grep :3333', { encoding: 'utf-8', timeout: 3000 }).trim();
			if (result) {
				console.warn(`[ports] Port 3333 may be in use:\n${result}`);
			}
		} catch {
			// Neither tool available, skip check
		}
	}
}
