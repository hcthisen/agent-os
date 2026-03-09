import http from "node:http";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const PORT = parseInt(process.env.PORT || "3002", 10);

let browser: Browser | null = null;
const sessions = new Map<string, Page>();

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;

  browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  return browser;
}

async function createSession(id: string): Promise<{ sessionId: string }> {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  sessions.set(id, page);
  return { sessionId: id };
}

async function navigate(
  sessionId: string,
  url: string
): Promise<{ title: string; url: string }> {
  const page = sessions.get(sessionId);
  if (!page) throw new Error(`Session ${sessionId} not found`);

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  const title = await page.title();
  return { title, url: page.url() };
}

async function getContent(sessionId: string): Promise<{ html: string }> {
  const page = sessions.get(sessionId);
  if (!page) throw new Error(`Session ${sessionId} not found`);

  const html = await page.content();
  return { html };
}

async function screenshot(
  sessionId: string
): Promise<{ base64: string }> {
  const page = sessions.get(sessionId);
  if (!page) throw new Error(`Session ${sessionId} not found`);

  const buf = await page.screenshot({ encoding: "base64" });
  return { base64: buf as string };
}

async function closeSession(sessionId: string): Promise<void> {
  const page = sessions.get(sessionId);
  if (page) {
    await page.close();
    sessions.delete(sessionId);
  }
}

// HTTP API
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  res.setHeader("Content-Type", "application/json");

  try {
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
      return;
    }

    // Parse body for POST requests
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }

    if (url.pathname === "/session/create" && req.method === "POST") {
      const id =
        (body.id as string) || `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const result = await createSession(id);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } else if (url.pathname === "/session/navigate" && req.method === "POST") {
      const result = await navigate(body.sessionId as string, body.url as string);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } else if (url.pathname === "/session/content" && req.method === "POST") {
      const result = await getContent(body.sessionId as string);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } else if (url.pathname === "/session/screenshot" && req.method === "POST") {
      const result = await screenshot(body.sessionId as string);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } else if (url.pathname === "/session/close" && req.method === "POST") {
      await closeSession(body.sessionId as string);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  } catch (err: any) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Browser service listening on port ${PORT}`);
});

// Cleanup on shutdown
process.on("SIGTERM", async () => {
  for (const [id] of sessions) await closeSession(id);
  if (browser) await browser.close();
  server.close();
  process.exit(0);
});
