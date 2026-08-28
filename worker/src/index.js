/**
 * WebMCP x macadress.com - API proxy
 *
 * Keeps the macadress.com API key server-side. The browser app and its WebMCP
 * tools call this Worker instead of api.macadress.com directly.
 *
 * Routes (allowlisted):
 *   GET  /v1/mac/:mac      single lookup
 *   POST /v1/mac/batch     { "macs": [...] }  (capped at MAX_BATCH)
 *   GET  /healthz          liveness, no upstream call
 */

const UPSTREAM = 'https://api.macadress.com';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const cors = corsHeaders(env, request.headers.get('Origin') || '');

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		if (url.pathname === '/healthz') {
			return json({ ok: true }, 200, cors);
		}

		if (env.RATE_LIMITER) {
			const ip = request.headers.get('CF-Connecting-IP') || 'anon';
			const { success } = await env.RATE_LIMITER.limit({ key: ip });
			if (!success) {
				return json({ error: 'Rate limit exceeded, slow down.' }, 429, cors);
			}
		}

		const single = url.pathname.match(/^\/v1\/mac\/([^/]+)$/);
		if (request.method === 'GET' && single && single[1] !== 'batch') {
			return proxy(env, `/v1/mac/${encodeURIComponent(single[1])}`, { method: 'GET' }, cors);
		}

		if (request.method === 'POST' && url.pathname === '/v1/mac/batch') {
			let body;
			try {
				body = await request.json();
			} catch {
				return json({ error: 'Request body must be JSON.' }, 400, cors);
			}
			const macs = Array.isArray(body?.macs) ? body.macs : null;
			const max = Number(env.MAX_BATCH || 50);
			if (!macs || macs.length === 0) {
				return json({ error: 'Expected { "macs": [ ... ] }.' }, 400, cors);
			}
			if (macs.length > max) {
				return json({ error: `Batch limited to ${max} addresses.` }, 400, cors);
			}
			return proxy(
				env,
				'/v1/mac/batch',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ macs }),
				},
				cors,
			);
		}

		return json({ error: 'Not found.' }, 404, cors);
	},
};

async function proxy(env, path, init, cors) {
	if (!env.MACADRESS_API_KEY) {
		return json({ error: 'Worker is missing MACADRESS_API_KEY (wrangler secret put).' }, 500, cors);
	}
	let res;
	try {
		res = await fetch(UPSTREAM + path, {
			...init,
			headers: {
				...(init.headers || {}),
				Authorization: `Bearer ${env.MACADRESS_API_KEY}`,
				Accept: 'application/json',
				'User-Agent': 'webmcp-macadress-proxy',
			},
		});
	} catch (err) {
		return json({ error: `Upstream request failed: ${err}` }, 502, cors);
	}
	const text = await res.text();
	return new Response(text, {
		status: res.status,
		headers: {
			...cors,
			'Content-Type': 'application/json',
			'Cache-Control': res.ok ? 'public, max-age=86400' : 'no-store',
		},
	});
}

function corsHeaders(env, origin) {
	const allow = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
	const value = allow.includes('*') ? '*' : allow.includes(origin) ? origin : allow[0] || '';
	return {
		'Access-Control-Allow-Origin': value,
		'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		Vary: 'Origin',
	};
}

function json(obj, status, cors) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json' },
	});
}
