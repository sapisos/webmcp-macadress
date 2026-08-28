import { defineTool, webmcpAvailable, toolStatus } from './wmcp.js';

const PROXY = (window.MACADRESS_PROXY || '').replace(/\/$/, '');
const DEMO_TOKEN = window.MACADRESS_DEMO_TOKEN || '';

function apiHeaders(extra) {
	const h = { ...(extra || {}) };
	if (DEMO_TOKEN) h['X-Demo-Token'] = DEMO_TOKEN;
	return h;
}

/* ------------------------------------------------------------------ state */

const state = {
	order: [], // MAC strings, insertion order
	rows: new Map(), // mac -> { mac, status, data, error }
	filter: { field: 'all', value: null },
};

const listeners = new Set();
const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn());

/* ------------------------------------------------------------------ helpers */

const MAC_RE =
	/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}|\b[0-9a-f]{12}\b/gi;

function normalizeMac(raw) {
	const hex = raw.replace(/[^0-9a-f]/gi, '').toLowerCase();
	if (hex.length !== 12) return null;
	return hex.match(/.{2}/g).join(':');
}

function extractMacs(text) {
	const out = [];
	const seen = new Set();
	for (const m of String(text || '').matchAll(MAC_RE)) {
		const mac = normalizeMac(m[0]);
		if (mac && !seen.has(mac)) {
			seen.add(mac);
			out.push(mac);
		}
	}
	return out;
}

function addRows(macs) {
	let added = 0;
	for (const mac of macs) {
		if (!state.rows.has(mac)) {
			state.rows.set(mac, { mac, status: 'pending', data: null, error: null });
			state.order.push(mac);
			added++;
		}
	}
	emit();
	return added;
}

function isRandomized(d) {
	return !!(
		d &&
		d.potentially_randomized &&
		['possible', 'likely'].includes(d.randomization_confidence)
	);
}

function visibleRows() {
	const rows = state.order.map((m) => state.rows.get(m));
	const { field, value } = state.filter;
	if (field === 'all' || !field) return rows;
	return rows.filter((r) => {
		const d = r.data || {};
		if (field === 'randomized') return isRandomized(d);
		if (field === 'unregistered') return r.status === 'ok' && !d.organization;
		if (field === 'virtualization') {
			const v = d.virtualization || {};
			return v.detected && (!value || (v.platform || 'virtual') === value);
		}
		if (field === 'vendor') return (d.organization || '').toLowerCase() === String(value || '').toLowerCase();
		if (field === 'device') return ((d.device && d.device.category) || '') === value;
		return true;
	});
}

/* ------------------------------------------------------------------ api (via Worker) */

async function apiGet(mac) {
	if (!PROXY) throw new Error('Set window.MACADRESS_PROXY in config.js to your Worker URL.');
	const res = await fetch(`${PROXY}/v1/mac/${encodeURIComponent(mac)}`, {
		headers: apiHeaders(),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
	return body;
}

async function apiBatch(macs) {
	const map = new Map();
	for (let i = 0; i < macs.length; i += 40) {
		const chunk = macs.slice(i, i + 40);
		const res = await fetch(`${PROXY}/v1/mac/batch`, {
			method: 'POST',
			headers: apiHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({ macs: chunk }),
		});
		if (!res.ok) throw new Error(`batch HTTP ${res.status}`);
		const body = await res.json();
		const list = Array.isArray(body) ? body : body.results || body.data || body.macs || [];
		for (const item of list) {
			const key = normalizeMac(item.mac || item.address || '');
			if (key) map.set(key, item);
		}
	}
	return map;
}

async function enrichPending() {
	const pending = state.order.filter((m) => state.rows.get(m).status !== 'ok');
	if (pending.length === 0) return { enriched: 0 };

	let map = null;
	try {
		map = await apiBatch(pending);
	} catch {
		map = null; // fall back to sequential
	}

	let ok = 0;
	let failed = 0;
	for (const mac of pending) {
		const row = state.rows.get(mac);
		try {
			const data = map && map.has(mac) ? map.get(mac) : await apiGet(mac);
			row.data = data;
			row.status = 'ok';
			row.error = null;
			ok++;
		} catch (err) {
			row.status = 'error';
			row.error = String(err.message || err);
			failed++;
		}
		emit();
	}
	return { enriched: ok, failed };
}

/* ------------------------------------------------------------------ operations (shared by UI + tools) */

const ops = {
	addMacs(text) {
		const macs = extractMacs(text);
		const added = addRows(macs);
		return { found: macs.length, added, total: state.rows.size };
	},

	async lookup(macRaw) {
		const mac = normalizeMac(macRaw);
		if (!mac) throw new Error(`"${macRaw}" is not a MAC address`);
		addRows([mac]);
		const row = state.rows.get(mac);
		try {
			row.data = await apiGet(mac);
			row.status = 'ok';
		} catch (err) {
			row.status = 'error';
			row.error = String(err.message || err);
			emit();
			throw err;
		}
		emit();
		return row.data;
	},

	enrich() {
		return enrichPending();
	},

	summarize() {
		const rows = [...state.rows.values()].filter((r) => r.status === 'ok').map((r) => r.data);
		const tally = (fn) => {
			const c = {};
			for (const d of rows) {
				const k = fn(d);
				if (k) c[k] = (c[k] || 0) + 1;
			}
			return c;
		};
		return {
			total: state.rows.size,
			enriched: rows.length,
			randomized: rows.filter(isRandomized).length,
			locally_administered: rows.filter((d) => d.locally_administered).length,
			unregistered: rows.filter((d) => !d.organization).length,
			by_vendor: tally((d) => d.organization),
			by_device: tally((d) => d.device && d.device.category),
			by_virtualization: tally((d) => d.virtualization && d.virtualization.detected && (d.virtualization.platform || 'virtual')),
		};
	},

	setFilter(field, value) {
		state.filter = { field: field || 'all', value: value ?? null };
		emit();
		return { field: state.filter.field, value: state.filter.value, matches: visibleRows().length };
	},

	exportList(format) {
		const rows = visibleRows().filter((r) => r.status === 'ok');
		const label = (d) =>
			[d.organization || 'unknown-vendor', d.device && d.device.category, isRandomized(d) && 'randomized']
				.filter(Boolean)
				.join(' / ');
		if (format === 'zeek') {
			const lines = rows.map((r) => `${r.mac}\t${label(r.data)}`);
			return `# fields\tmac\tannotation\n${lines.join('\n')}\n`;
		}
		if (format === 'csv') {
			const lines = rows.map((r) => {
				const d = r.data;
				return [r.mac, d.organization || '', (d.device && d.device.category) || '', isRandomized(d), d.country || '']
					.map((x) => `"${String(x).replace(/"/g, '""')}"`)
					.join(',');
			});
			return `mac,vendor,device,randomized,country\n${lines.join('\n')}\n`;
		}
		// nftables default
		const set = rows.map((r) => `        ${r.mac}, # ${label(r.data)}`).join('\n');
		return `table bridge filter {\n    set inventory {\n        type ether_addr\n        elements = {\n${set}\n        }\n    }\n}\n`;
	},

	clear() {
		state.order = [];
		state.rows = new Map();
		state.filter = { field: 'all', value: null };
		emit();
		return { cleared: true };
	},
};

/* ------------------------------------------------------------------ WebMCP tools */

const TOOLS = [
	{
		name: 'add_mac_addresses',
		description:
			'Extract every MAC address from a block of text (ARP table, DHCP leases, nmap/pcap output, a spreadsheet paste) and add each one to the inventory as a pending row.',
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string', description: 'Raw text containing MAC addresses in any common format.' } },
			required: ['text'],
		},
		handler: ({ text }) => ops.addMacs(text),
	},
	{
		name: 'lookup_mac',
		description:
			'Look up a single MAC address and add it to the inventory. Returns the full macadress.com record (vendor, device category, virtualization, special-use, randomization).',
		inputSchema: {
			type: 'object',
			properties: { mac: { type: 'string', description: 'A MAC address in any format (colon, hyphen, dotted, or bare hex).' } },
			required: ['mac'],
		},
		handler: ({ mac }) => ops.lookup(mac),
	},
	{
		name: 'enrich_inventory',
		description: 'Resolve every pending MAC address in the inventory against macadress.com. Safe to call repeatedly; only unresolved rows are fetched.',
		inputSchema: { type: 'object', properties: {} },
		handler: () => ops.enrich(),
	},
	{
		name: 'summarize_inventory',
		description:
			'Return counts across the enriched inventory: totals, how many are privacy-randomized, locally administered or unregistered, and breakdowns by vendor, device category and virtualization platform.',
		inputSchema: { type: 'object', properties: {} },
		handler: () => ops.summarize(),
	},
	{
		name: 'filter_inventory',
		description:
			'Set the table filter so the human sees a specific slice. field is one of: all, randomized, unregistered, virtualization, vendor, device. For vendor and device also pass value.',
		inputSchema: {
			type: 'object',
			properties: {
				field: { type: 'string', enum: ['all', 'randomized', 'unregistered', 'virtualization', 'vendor', 'device'] },
				value: { type: 'string', description: 'Required when field is "vendor" (exact organization name) or "device" (category).' },
			},
			required: ['field'],
		},
		handler: ({ field, value }) => ops.setFilter(field, value),
	},
	{
		name: 'export_filter_list',
		description:
			'Turn the currently visible (filtered) rows into a text artifact: an nftables ether_addr set, a Zeek annotation file, or CSV. Use after filter_inventory to hand the human something actionable.',
		inputSchema: {
			type: 'object',
			properties: { format: { type: 'string', enum: ['nftables', 'zeek', 'csv'], default: 'nftables' } },
			required: ['format'],
		},
		handler: ({ format }) => ({ format, text: ops.exportList(format) }),
	},
	{
		name: 'clear_inventory',
		description: 'Remove every row and reset the filter. Use when starting a new investigation.',
		inputSchema: { type: 'object', properties: {} },
		handler: () => ops.clear(),
	},
];

function registerTools() {
	return Promise.all(TOOLS.map((t) => defineTool(t)));
}

/* ------------------------------------------------------------------ UI */

const $ = (sel) => document.querySelector(sel);

function badge(text, kind) {
	return `<span class="badge ${kind || ''}">${text}</span>`;
}

function renderSummary() {
	const s = ops.summarize();
	$('#summary').innerHTML = [
		badge(`${s.total} MACs`),
		badge(`${s.enriched} enriched`, 'ok'),
		s.randomized ? badge(`${s.randomized} randomized`, 'warn') : '',
		s.unregistered ? badge(`${s.unregistered} unregistered`, 'muted') : '',
		Object.keys(s.by_virtualization).length ? badge(`${Object.values(s.by_virtualization).reduce((a, b) => a + b, 0)} virtual`, 'muted') : '',
	]
		.filter(Boolean)
		.join(' ');
}

function renderChips() {
	const s = ops.summarize();
	const chips = [['all', 'All']];
	if (s.randomized) chips.push(['randomized', `Randomized (${s.randomized})`]);
	if (s.unregistered) chips.push(['unregistered', `Unregistered (${s.unregistered})`]);
	for (const [cat, n] of Object.entries(s.by_device)) chips.push([`device:${cat}`, `${cat} (${n})`]);
	for (const [plat, n] of Object.entries(s.by_virtualization)) chips.push([`virtualization:${plat}`, `${plat} (${n})`]);
	$('#chips').innerHTML = chips
		.map(([key, label]) => {
			const [field, value] = key.includes(':') ? key.split(':') : [key, null];
			const active = state.filter.field === field && (state.filter.value || null) === (value || null);
			return `<button class="chip ${active ? 'active' : ''}" data-field="${field}" data-value="${value || ''}">${label}</button>`;
		})
		.join('');
}

function renderTable() {
	const rows = visibleRows();
	if (rows.length === 0) {
		$('#tbody').innerHTML = `<tr><td colspan="6" class="empty">No rows. Paste data and hit Parse, or ask the agent to add some.</td></tr>`;
		return;
	}
	$('#tbody').innerHTML = rows
		.map((r) => {
			const d = r.data || {};
			if (r.status === 'pending') return `<tr><td class="mono">${r.mac}</td><td colspan="5" class="muted">pending…</td></tr>`;
			if (r.status === 'error') return `<tr><td class="mono">${r.mac}</td><td colspan="5" class="err">${r.error}</td></tr>`;
			return `<tr>
				<td class="mono">${r.mac}</td>
				<td>${d.organization || (d.locally_administered ? '<span class="muted">locally administered</span>' : '<span class="muted">unregistered</span>')}${d.country ? ` <span class="muted">(${d.country})</span>` : ''}</td>
				<td>${(d.device && d.device.category) || ''}</td>
				<td>${d.virtualization && d.virtualization.detected ? d.virtualization.platform || 'virtual' : ''}</td>
				<td>${isRandomized(d) ? badge('randomized', 'warn') : d.locally_administered ? badge('local', 'muted') : ''}</td>
				<td class="muted small">${d.explanation || ''}</td>
			</tr>`;
		})
		.join('');
}

function render() {
	renderSummary();
	renderChips();
	renderTable();
}

function wireUI() {
	$('#parse').addEventListener('click', () => {
		const r = ops.addMacs($('#input').value);
		toast(`Found ${r.found}, added ${r.added}`);
	});
	$('#enrich').addEventListener('click', async () => {
		$('#enrich').disabled = true;
		const r = await ops.enrich();
		$('#enrich').disabled = false;
		toast(`Enriched ${r.enriched}${r.failed ? `, ${r.failed} failed` : ''}`);
	});
	$('#clear').addEventListener('click', () => ops.clear());
	$('#sample').addEventListener('click', async () => {
		const txt = await fetch('./sample-data.txt').then((r) => r.text());
		$('#input').value = txt;
	});
	$('#chips').addEventListener('click', (e) => {
		const btn = e.target.closest('.chip');
		if (!btn) return;
		ops.setFilter(btn.dataset.field, btn.dataset.value || null);
	});
	$('#export').addEventListener('click', () => {
		const text = ops.exportList($('#format').value);
		$('#output').value = text;
		$('#output').hidden = false;
	});
}

let toastTimer;
function toast(msg) {
	const el = $('#toast');
	el.textContent = msg;
	el.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

/* ------------------------------------------------------------------ boot */

async function boot() {
	wireUI();
	onChange(render);
	render();

	if (!webmcpAvailable()) {
		$('#wmcp-status').innerHTML = `${badge('WebMCP not detected', 'muted')} manual mode - open in Chrome 149+ with chrome://flags/#enable-webmcp-testing and the Model Context Tool Inspector extension`;
		return;
	}

	await registerTools();
	const s = toolStatus();
	$('#wmcp-status').innerHTML =
		s.registered === s.total
			? `${badge('WebMCP connected', 'ok')} ${s.registered} tools exposed to the agent`
			: `${badge('WebMCP partial', 'warn')} ${s.registered}/${s.total} tools registered - ${s.failed.join(', ')} failed (see console)`;
}

boot();
