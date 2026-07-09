import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

/**
 * Serve la SPA buildata (web/dist) dallo stesso processo del signaling:
 * un solo container e un solo vhost sul reverse proxy. Ritorna null se la
 * build non esiste (es. sviluppo locale, dove ci pensa Vite).
 */
export function createStaticHandler(root: string): StaticHandler | null {
  const rootDir = resolve(root);
  if (!existsSync(join(rootDir, "index.html"))) return null;

  return (req, res) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(req.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    let filePath = join(rootDir, normalize(pathname));
    if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // Fallback SPA: gli URL applicativi (es. /r/<stanza>) servono index.html
      filePath = join(rootDir, "index.html");
    }

    const ext = extname(filePath);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      // Gli asset Vite hanno hash nel nome: cache aggressiva. Tutto il
      // resto (index.html) va rivalidato per non servire build vecchie.
      "cache-control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    createReadStream(filePath).pipe(res);
  };
}
