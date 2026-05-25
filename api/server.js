// Vercel Node.js serverless function that bridges the TanStack Start
// SSR worker (built to dist/server/index.js) into Vercel's request/response model.
import handler from "../dist/server/index.js";

// Vercel auto-detects this as a Node.js serverless function — do not add
// `export const config = { runtime: ... }` (causes "Function Runtimes must
// have a valid version") and do not add a `functions` block in vercel.json.

function buildRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = `${proto}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value != null) {
      headers.set(key, String(value));
    }
  }

  const method = req.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url, {
    method,
    headers,
    body: hasBody ? req : undefined,
    // @ts-expect-error - Node fetch requires duplex for streaming bodies
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export default async function vercelHandler(req, res) {
  try {
    const request = buildRequest(req);
    const response = await handler.fetch(request, process.env, {});
    await sendResponse(res, response);
  } catch (err) {
    console.error("[vercel/api/server] handler error:", err);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  }
}
