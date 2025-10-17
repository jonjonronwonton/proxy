const functions = require("firebase-functions");
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { URL } = require("url");

const app = express();

// Parse JSON bodies (keeps non-JSON bodies as streams for streaming uploads)
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors()); // tighten origin in production

// Helpers to get config from environment or functions config
function getConfig() {
  const envAllowed = process.env.PROXY_ALLOWED_HOSTS || process.env.ALLOWED_HOSTS;
  const allowedFromConfig = (functions.config && functions.config().proxy && functions.config().proxy.allowed_hosts) || "";
  const allowed = (envAllowed || allowedFromConfig || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const envApiKey = process.env.PROXY_API_KEY || process.env.API_KEY;
  const apiKeyFromConfig = (functions.config && functions.config().proxy && functions.config().proxy.api_key) || "";
  const apiKey = envApiKey || apiKeyFromConfig || "";

  // Optional timeout in ms (default 30s)
  const timeout = parseInt(process.env.PROXY_TIMEOUT_MS || ((functions.config && functions.config().proxy && functions.config().proxy.timeout_ms) || ""), 10) || 30000;

  return { allowedHosts: allowed, apiKey, timeout };
}

// Simple wildcard matcher: supports exact hostname or leading wildcard like *.example.com
function hostMatches(hostname, pattern) {
  if (pattern.startsWith("*.")) {
    const domain = pattern.slice(2);
    return hostname === domain || hostname.endsWith("." + domain);
  }
  return hostname === pattern;
}

function isHostAllowed(urlStr, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) {
    // Deny by default if not configured
    return false;
  }
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname;
    return allowedHosts.some(p => hostMatches(host, p));
  } catch (e) {
    return false;
  }
}

// Remove hop-by-hop headers
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

// Forward X-Forwarded-* headers and append client info
function appendForwardedHeaders(outgoingHeaders, req) {
  const forwardedFor = req.get("x-forwarded-for");
  const extra = req.ip || (req.connection && req.connection.remoteAddress);
  outgoingHeaders["x-forwarded-for"] = [forwardedFor, extra].filter(Boolean).join(", ");

  if (req.protocol) outgoingHeaders["x-forwarded-proto"] = req.protocol;
  if (req.get("host")) outgoingHeaders["x-forwarded-host"] = req.get("host");
}

// Main proxy handler
app.all("/proxy", async (req, res) => {
  const { allowedHosts, apiKey, timeout } = getConfig();

  // Require API key if set
  if (apiKey) {
    const provided = req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!provided || provided !== apiKey) {
      return res.status(401).json({ error: "Unauthorized: invalid API key" });
    }
  }

  // Get target URL from query param or JSON body
  const target = (req.query && req.query.url) || (req.body && req.body.url);
  if (!target) {
    return res.status(400).json({ error: "Missing 'url' parameter (query or JSON body)" });
  }

  // Validate URL and allowed hosts
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!isHostAllowed(target, allowedHosts)) {
    return res.status(403).json({ error: "Host not allowed by proxy configuration" });
  }

  // Build fetch options
  const method = req.method.toUpperCase();

  const headers = {};
  // Copy request headers but omit hop-by-hop and host
  Object.keys(req.headers || {}).forEach(key => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host") return;
    headers[key] = req.headers[key];
  });

  // Remove origin to avoid CORS mismatch at upstream
  delete headers.origin;

  // Append X-Forwarded headers
  appendForwardedHeaders(headers, req);

  // Determine body to forward
  let bodyForFetch;
  if (method === "GET" || method === "HEAD") {
    bodyForFetch = undefined;
  } else {
    const contentType = req.get("content-type") || "";
    const isJson = contentType.includes("application/json") && req.body && typeof req.body === "object";
    if (isJson) {
      try {
        bodyForFetch = JSON.stringify(req.body);
        if (!headers["content-type"]) headers["content-type"] = "application/json";
      } catch (e) {
        bodyForFetch = req;
      }
    } else {
      // For non-JSON (multipart/form-data, application/octet-stream, etc.) forward the raw request stream.
      bodyForFetch = req;
    }
  }

  // Use AbortController for timeout handling
  const controller = new AbortController();
  const abortTimeout = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOptions = {
      method,
      headers,
      body: bodyForFetch,
      redirect: "follow",
      compress: true,
      signal: controller.signal,
    };

    if (bodyForFetch && bodyForFetch !== req && typeof bodyForFetch === "string") {
      headers["content-length"] = Buffer.byteLength(bodyForFetch);
    }

    const upstreamRes = await fetch(target, fetchOptions);
    clearTimeout(abortTimeout);

    // Relay status
    res.status(upstreamRes.status);

    // Relay headers (filter hop-by-hop)
    upstreamRes.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name.toLowerCase())) {
        try {
          res.set(name, value);
        } catch (e) {
          // ignore headers we cannot set
        }
      }
    });

    // Stream response body (supports chunked responses)
    if (upstreamRes.body) {
      upstreamRes.body.pipe(res);
      upstreamRes.body.on("error", err => {
        console.error("Upstream stream error:", err);
        try { res.end(); } catch (e) {}
      });
    } else {
      res.end();
    }
  } catch (err) {
    clearTimeout(abortTimeout);
    console.error("Proxy error:", err);
    if (err.name === "AbortError") {
      res.status(504).json({ error: "Upstream request timed out" });
    } else {
      res.status(502).json({ error: "Proxy error", details: err.message });
    }
  }
});

// Export the function
exports.proxy = functions.https.onRequest(app);