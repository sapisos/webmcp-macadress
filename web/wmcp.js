/**
 * WebMCP adapter for Chrome's implementation.
 *
 * Chrome 149+ (chrome://flags/#enable-webmcp-testing) exposes
 * `document.modelContext.registerTool({ name, description, inputSchema, execute })`
 * where `execute(inputs, { signal })` must resolve to a STRING.
 *
 * App code calls defineTool({ name, description, inputSchema, handler }); handlers
 * return any JS value and this module stringifies it for the agent. All the
 * spec-surface assumptions live here so the rest of the app never touches them.
 */

const results = []; // { name, ok }

function getHost() {
	if (typeof document !== 'undefined' && document.modelContext) return document.modelContext;
	if (typeof navigator !== 'undefined' && navigator.modelContext) return navigator.modelContext;
	return null;
}

export function webmcpAvailable() {
	return getHost() !== null;
}

export function toolStatus() {
	return {
		total: results.length,
		registered: results.filter((r) => r.ok).length,
		failed: results.filter((r) => !r.ok).map((r) => r.name),
	};
}

function asString(value) {
	return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

export async function defineTool({ name, description, inputSchema, handler }) {
	const host = getHost();
	const entry = { name, ok: false };
	results.push(entry);

	if (!host || typeof host.registerTool !== 'function') return entry;

	const execute = async (inputs, ctx) => {
		try {
			return asString(await handler(inputs || {}, ctx || {}));
		} catch (err) {
			return asString({ error: String((err && err.message) || err) });
		}
	};

	try {
		await host.registerTool({ name, description, inputSchema, execute });
		entry.ok = true;
	} catch (err) {
		console.warn('[wmcp] registerTool failed for', name, err);
	}
	return entry;
}
