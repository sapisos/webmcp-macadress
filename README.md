# MAC Inventory Workbench - WebMCP x macadress.com

A WebMCP app where a human and a browser agent triage a network's MAC addresses
on the same surface: paste raw data, enrich every address against
[macadress.com](https://macadress.com), slice the inventory, and export an
allowlist. The buttons and the WebMCP tools do exactly the same things, so the
agent and the person are editing one shared artifact.

Built for the [WebMCP Challenge](https://webmcp.devpost.com/) (OpenAI x Devpost).

## Why this is a good WebMCP fit

- **Real shared state.** Every tool mutates the same inventory the human sees; there is no separate "agent view".
- **A backend an agent cannot fake.** macadress.com resolves IEEE/OUI registrations, infers device class, detects virtualization and privacy randomization. It is domain data, not an LLM guess.
- **The output goes somewhere.** `export_filter_list` turns the filtered rows into an nftables set, a Zeek annotation file or CSV - the collaboration produces something you can apply.

## WebMCP tools

| Tool | Input | Effect |
|---|---|---|
| `add_mac_addresses` | `text` | Pull every MAC out of pasted text, add pending rows |
| `load_sample_data` | - | Load the bundled sample capture and add every MAC in it |
| `lookup_mac` | `mac` | Resolve one address, add it |
| `enrich_inventory` | - | Resolve all pending rows (batched, falls back to per-row) |
| `summarize_inventory` | - | Counts: randomized, unregistered, by vendor / device / virtualization |
| `filter_inventory` | `field`, `value?` | Set the visible slice (`randomized`, `vendor`, `device`, ...) |
| `export_filter_list` | `format` | Build `nftables` / `zeek` / `csv` from visible rows |
| `clear_inventory` | - | Reset |

## How WebMCP is implemented

Every tool is registered with the imperative API:

```js
document.modelContext.registerTool({
  name: "load_sample_data",
  description: "Load the bundled sample capture and add every MAC in it",
  inputSchema: { /* JSON Schema */ },
  execute: async (input) => { /* returns a string */ },
});
```

- [`web/wmcp.js`](web/wmcp.js) is the only file coupled to the spec. It resolves
  the host (`document.modelContext`, falling back to `navigator.modelContext` and
  to the older `provideContext({ tools })` shape), wraps each handler so its
  return value is stringified for the agent, and reports how many tools actually
  registered.
- [`web/app.js`](web/app.js) defines the tool list (`TOOLS`) and an `ops` object.
  The on-page buttons and the tool handlers both call `ops`, so the agent and the
  human mutate one shared inventory. No separate agent view, no build step.

## Layout

```
worker/   Cloudflare Worker - proxies api.macadress.com, keeps the API key server-side
web/      the WebMCP app - static HTML/CSS/JS, no build step
```

## Run it

### 1. Worker (API proxy)

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars        # put a macadress.com key in it for local dev
npx wrangler dev                      # http://localhost:8787
```

Deploy:

```sh
npx wrangler login
npx wrangler secret put MACADRESS_API_KEY     # required
npx wrangler secret put DEMO_TOKEN            # optional shared token (see Security)
npx wrangler deploy
```

Free Cloudflare plan is enough (100k req/day, no card).

`worker/wrangler.toml` also has:

- a per-IP rate limit (`60 / 60s`) via the free rate-limit binding
- a custom domain: `webmcp.macadress.com` (`custom_domain = true`). The zone must
  be in the same Cloudflare account; wrangler provisions DNS + TLS. Drop the
  `routes` block to use the `*.workers.dev` URL instead.

### 2. Web app

Edit `web/config.js` so `window.MACADRESS_PROXY` points at the Worker, then serve
`web/` as static files:

```sh
cd web
npx serve .                           # or: python3 -m http.server
```

Deploy `web/` to Cloudflare Pages, Vercel or Netlify - it is plain static files.
Set the Worker's `ALLOWED_ORIGINS` to the deployed origin before the demo.

### 3. Drive it with an agent

**ChatGPT in-app browser** - supports WebMCP natively. Open the deployed URL in it
and ask ChatGPT to use the page tools directly.

**Chrome 149+:**

1. Enable `chrome://flags/#enable-webmcp-testing`.
2. Install the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) extension (Chrome has no built-in agent).
3. Open the deployed URL. The status line reads `WebMCP connected - 8 tools`.
4. In the Inspector panel the tools are listed and individually callable, and the prompt box (routed to `gemini-3.6-flash`) lets you drive them in natural language.

Example prompt:

> Load the sample data, enrich every MAC, tell me how many are privacy-randomized,
> filter to just those, and export an nftables set.

Without WebMCP the app still runs fully in manual mode. `web/wmcp.js` is the only
file coupled to the WebMCP surface.

## Bring your own key

The page runs on a shared demo key with a per-IP rate limit. Anyone who does not
want those limits can open the **Demo key** disclosure in the header and paste
their own [macadress.com](https://macadress.com) key. The key is stored in that
browser's `localStorage` and sent to the Worker as `X-Macadress-Key`; the Worker
forwards it upstream instead of `MACADRESS_API_KEY` and skips both the
`DEMO_TOKEN` gate and the shared rate limit for that call. Own-key responses are
returned `no-store` so they never land in a shared cache. Clearing the field
returns the page to the demo key.

`api.macadress.com` sends no CORS headers, so the key still goes through the
Worker rather than straight from the browser.

## Security

Layered, because the Worker URL is public:

1. **Key isolation** - `MACADRESS_API_KEY` is a Wrangler secret; the browser never sees it. Use a **dedicated low-quota key** so a leaked/abused URL caps out fast.
2. **Single entry point** - `workers_dev = false`, so the only hostname is `webmcp.macadress.com`. No `*.workers.dev` URL to bypass the edge rule below.
3. **Origin lock (edge)** - a Cloudflare WAF custom rule on the `macadress.com` zone blocks any request to `webmcp.macadress.com` whose `Origin` header is not the demo page. `/healthz` stays open. Blocked requests never reach the Worker.

   ```
   (http.host eq "webmcp.macadress.com"
     and http.request.uri.path ne "/healthz"
     and not any(http.request.headers["origin"][*] eq "https://webmcp-macadress.pages.dev"))
   ```

4. **Rate limit** - 60 req / 60s per client IP (`RATE_LIMITER` binding).
5. **CORS** - `ALLOWED_ORIGINS` pinned to the deployed page origin (response headers only; the Origin lock in 3 is what actually rejects non-browser callers).
6. **Shared token** - set the `DEMO_TOKEN` secret and the Worker requires `X-Demo-Token` (or `?t=`) on every `/v1/*` call. `healthz` and CORS preflight are exempt. The web app ships the token in `config.js`, so it is friction + rotation control, not a true secret.
7. **Route allowlist** - only `GET /v1/mac/:mac` and `POST /v1/mac/batch` (capped at `MAX_BATCH`) are proxied; everything else is 404.

The Origin lock is spoofable by a non-browser client, so it is not cryptographic;
it is layered on top of the low-quota key and rate limit. If the page ever moves
onto `webmcp.macadress.com` itself (same origin), swap the rule to check
`http.referer`, since browsers drop `Origin` on same-origin GETs.

## License

[MIT](LICENSE). WebMCP is a W3C Web Machine Learning Community Group draft, not a
standard; the registration surface in `web/wmcp.js` is deliberately isolated so
it can track spec changes.
