// Deployed Cloudflare Worker (see /worker).
window.MACADRESS_PROXY = 'https://webmcp.macadress.com';

// Must match the Worker's DEMO_TOKEN secret. This is shipped to the browser,
// so it is friction + rotation control, not a secret. Leave '' if the Worker
// has no DEMO_TOKEN set (e.g. local dev).
window.MACADRESS_DEMO_TOKEN = '';
