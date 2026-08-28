/**
 * Tiny WebMCP adapter.
 *
 * WebMCP is a moving W3C Web ML Community Group draft. The tool-registration
 * surface has shifted across revisions (document.modelContext / navigator.modelContext,
 * registerTool(object) / registerTool(positional), provideContext({tools})).
 * This module is the ONE place that has to change if the spec moves under us.
 *
 * App code calls defineTool({ name, description, inputSchema, handler }); the
 * handler returns any JS value and this adapter shapes it into the MCP-style
 * result the agent expects.
 */

const registered = [];

function getHost() {
	if (typeof document !== 'undefined' && document.modelContext) return document.modelContext;
	if (typeof navigator !== 'undefined' && navigator.modelContext) return navigator.modelContext;
	if (typeof window !== 'undefined' && window.modelContext) return window.modelContext;
	if (typeof window !== 'undefined' && window.mcp) return window.mcp; // older explainer name
	return null;
}

export function webmcpAvailable() {
	return getHost() !== null;
}

function toResult(value) {
	if (value && typeof value === 'object' && Array.isArray(value.content)) return value;
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: 'text', text }] };
}

export function defineTool({ name, description, inputSchema, handler }) {
	const host = getHost();
	const wrapped = async (args) => {
		try {
			return toResult(await handler(args || {}));
		} catch (err) {
			return toResult({ error: String(err && err.message ? err.message : err) });
		}
	};

	registered.push({ name, description });
	if (!host) return false;

	const spec = { name, description, inputSchema, execute: wrapped, run: wrapped, handler: wrapped };

	try {
		if (typeof host.registerTool === 'function') {
			// Object form (current draft).
			try {
				host.registerTool(spec);
				return true;
			} catch {
				// Positional form (older drafts): (name, description, schema, fn)
				host.registerTool(name, description, inputSchema, wrapped);
				return true;
			}
		}
		if (typeof host.provideContext === 'function') {
			host.provideContext({ tools: [spec] });
			return true;
		}
		if (typeof host.addTool === 'function') {
			host.addTool(spec);
			return true;
		}
	} catch (err) {
		console.warn('[wmcp] registration failed for', name, err);
		return false;
	}
	return false;
}

export function registeredTools() {
	return registered.slice();
}
