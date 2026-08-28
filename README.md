# MAC Inventory Workbench - WebMCP x macadress.com

A WebMCP app where a human and a browser agent triage a network's MAC addresses
on the same surface: paste raw data, enrich every address against
[macadress.com](https://macadress.com), slice the inventory, and export an
allowlist. The seven buttons and the seven WebMCP tools do exactly the same
things, so the agent and the person are editing one shared artifact.

Built for the [WebMCP Challenge](https://webmcp.devpost.com/) (OpenAI x Devpost).

## Why this is a good WebMCP fit

- **Real shared state.** Every tool mutates the same inventory the human sees; there is no separate "agent view".
- **A backend an agent cannot fake.** macadress.com resolves IEEE/OUI registrations, infers device class, detects virtualization and privacy randomization. It is domain data, not an LLM guess.
- **The output goes somewhere.** `export_filter_list` turns the filtered rows into an nftables set, a Zeek annotation file or CSV - the collaboration produces something you can apply.

## WebMCP tools

| Tool | Input | Effect |
|---|---|---|
| `add_mac_addresses` | `text` | Pull every MAC out of pasted text, add pending rows |
| `lookup_mac` | `mac` | Resolve one address, add it |
| `enrich_inventory` | - | Resolve all pending rows (batched, falls back to per-row) |
| `summarize_inventory` | - | Counts: randomized, unregistered, by vendor / device / virtualization |
| `filter_inventory` | `field`, `value?` | Set the visible slice (`randomized`, `vendor`, `device`, ...) |
| `export_filter_list` | `format` | Build `nftables` / `zeek` / `csv` from visible rows |
| `clear_inventory` | - | Reset |

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

1. Chrome 149+ with `chrome://flags/#enable-webmcp-testing`.
2. Install the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) extension (Chrome has no built-in agent).
3. Open the deployed URL. The status line reads `WebMCP connected - 7 tools`.
4. In the Inspector panel: the 7 tools are listed and individually callable, and the prompt box (routed to `gemini-3-flash-preview`) lets you drive them in natural language:

> Load the sample data, add every MAC to the inventory and enrich it. Then tell
> me how many are privacy-randomized, filter to just those, and export an
> nftables set.

Without WebMCP the app still runs fully in manual mode. `web/wmcp.js` is the only
file coupled to the WebMCP surface.

## Security

Layered, because the Worker URL is public:

1. **Key isolation** - `MACADRESS_API_KEY` is a Wrangler secret; the browser never sees it. Use a **dedicated low-quota key** so a leaked/abused URL caps out fast.
2. **Rate limit** - 60 req / 60s per client IP (`RATE_LIMITER` binding).
3. **CORS** - `ALLOWED_ORIGINS` pinned to the deployed page origin (stops browser cross-origin use; not curl).
4. **Shared token** - set the `DEMO_TOKEN` secret and the Worker requires `X-Demo-Token` (or `?t=`) on every `/v1/*` call. `healthz` and CORS preflight are exempt. The web app ships the token in `config.js`, so it is friction + rotation control, not a true secret.
5. **Route allowlist** - only `GET /v1/mac/:mac` and `POST /v1/mac/batch` (capped at `MAX_BATCH`) are proxied; everything else is 404.

## License

[MIT](LICENSE). WebMCP is a W3C Web Machine Learning Community Group draft, not a
standard; the registration surface in `web/wmcp.js` is deliberately isolated so
it can track spec changes.
