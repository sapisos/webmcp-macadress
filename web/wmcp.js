/**
 * WebMCP adapter.
 *
 * Primary target is Chrome's imperative API (Chrome 149+ behind
 * chrome://flags/#enable-webmcp-testing) and ChatGPT's in-app browser:
 *
 *   document.modelContext.registerTool({
 *     name, description, inputSchema,
 *     execute: async (input) => "<string>",
 *   });
 *
 * `execute` must resolve to a STRING. App code calls
 * defineTool({ name, description, inputSchema, handler }); handlers return any JS
 * value and this module stringifies it. A best-effort fallback to the older
 * `navigator.modelContext.provideContext({ tools })` shape is included so the app
 * still lights up on implementations that have not moved to registerTool yet.
 * Every spec-surface assumption lives in this file.
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

function wrapExecute(handler) {
	return async (inputs, ctx) => {
		try {
			return asString(await handler(inputs || {}, ctx || {}));
		} catch (err) {
			return asString({ error: String((err && err.message) || err) });
		}
	};
}

// Fallback path: batch every tool into one provideContext({ tools }) call for
// hosts that expose the older bulk API instead of registerTool.
let pendingContext = [];
let flushScheduled = false;

function scheduleProvideContext(host) {
	if (flushScheduled) return;
	flushScheduled = true;
	const flush = () => {
		flushScheduled = false;
		const tools = pendingContext;
		pendingContext = [];
		try {
			host.provideContext({ tools });
			for (const t of tools) {
				const entry = results.find((r) => r.name === t.name);
				if (entry) entry.ok = true;
			}
		} catch (err) {
			console.warn('[wmcp] provideContext failed', err);
		}
	};
	if (typeof queueMicrotask === 'function') queueMicrotask(flush);
	else setTimeout(flush, 0);
}

export async function defineTool({ name, description, inputSchema, handler }) {
	const host = getHost();
	const entry = { name, ok: false };
	results.push(entry);

	if (!host) return entry;

	const execute = wrapExecute(handler);

	if (typeof host.registerTool === 'function') {
		try {
			await host.registerTool({ name, description, inputSchema, execute });
			entry.ok = true;
		} catch (err) {
			console.warn('[wmcp] registerTool failed for', name, err);
		}
		return entry;
	}

	if (typeof host.provideContext === 'function') {
		pendingContext.push({ name, description, inputSchema, execute });
		scheduleProvideContext(host);
		return entry;
	}

	return entry;
}
