/**
 * Dev-only log server for the Collection extension.
 * Receives fire-and-forget POST /log requests from background.js (flog())
 * and appends them as newline-delimited JSON to collection-debug.ndjson.
 *
 * Usage:
 *   node log-server.js
 *
 * Auto-start on Windows (choose one):
 *   A) Startup folder: add a .bat to shell:startup that runs this script.
 *   B) PM2:  pm2 start log-server.js --name collection-logger
 *            pm2 save && pm2 startup   (run the printed command as admin)
 *
 * Read logs:
 *   Get-Content collection-debug.ndjson                  # all entries
 *   Get-Content collection-debug.ndjson | Select-Object -Last 50  # last 50
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PORT = 7700;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "collection-debug.ndjson");

const server = http.createServer((req, res) => {
  // Allow the extension origin (chrome-extension://*) to POST here.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "POST" && req.url === "/log") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        // Validate JSON before writing so the file stays parseable.
        const entry = JSON.parse(body);
        fs.appendFileSync(OUT, JSON.stringify(entry) + "\n", "utf8");
        const rest = { ...entry };
        delete rest.t; delete rest.ts; delete rest.event;
        const label = `[${entry.ts ?? new Date().toISOString()}] ${entry.event ?? "?"}`;
        const detail = Object.keys(rest).length ? " — " + JSON.stringify(rest) : "";
        console.log(label + detail);
      } catch {
        // Malformed body — skip silently.
      }
      res.writeHead(204); res.end();
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║         Collection Extension — Dev Log Server               ║");
  console.log("║                                                              ║");
  console.log("║  Captures Ctrl+Space / overlay events from the Collection   ║");
  console.log("║  browser extension while you use Edge/Chrome normally.      ║");
  console.log("║                                                              ║");
  console.log("║  You can safely minimise this window — do NOT close it.     ║");
  console.log("║  It auto-starts at login via Task Scheduler.                ║");
  console.log("║                                                              ║");
  console.log(`║  Listening : http://127.0.0.1:${PORT}                          ║`);
  console.log(`║  Log file  : collection-debug.ndjson (same folder)          ║`);
  console.log("║                                                              ║");
  console.log("║  To read logs:                                               ║");
  console.log("║  Get-Content collection-debug.ndjson | Select -Last 20      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
});
