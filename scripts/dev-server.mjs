// Local development server: serves public/ and routes /api/* to the same handler
// that runs on Vercel. Without MONGODB_URI it stores data in .data/local-store.json.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
if (!process.env.LEAD_ADMIN_PASSWORD) {
  process.env.LEAD_ADMIN_PASSWORD = "admin";
  console.warn('LEAD_ADMIN_PASSWORD is not set; using "admin" for local development only.');
}

const { createServerHandler } = await import("../server/app.mjs");
const handle = await createServerHandler();
const publicDir = join(root, "public");
const port = Number(process.env.PORT) || 3000;
const types = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

async function serveApi(req, res, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  headers.set("x-real-ip", req.socket.remoteAddress || "local");
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined
  });
  const response = await handle(request);
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(res, url) {
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
  const file = join(publicDir, relative.endsWith("/") ? `${relative}index.html` : relative);
  if (!file.startsWith(publicDir)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }
  try {
    const body = await readFile(file);
    res.setHeader("content-type", types[extname(file)] || "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);
  try {
    if (url.pathname.startsWith("/api/")) await serveApi(req, res, url);
    else await serveStatic(res, url);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end("Internal error");
  }
}).listen(port, () => {
  console.log(`Leads app running at http://localhost:${port} (storage: ${process.env.MONGODB_URI ? "MongoDB" : ".data/local-store.json"})`);
});
