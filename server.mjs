import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename as pathBasename, extname, join, normalize } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || "0.0.0.0";
const CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
const STATE_DB = process.env.CODEX_STATE_DB || join(CODEX_HOME, "state_5.sqlite");
const PUBLIC_DIR = join(process.cwd(), "public");
const CODEX_RPC_TIMEOUT_MS = Number(process.env.CODEX_RPC_TIMEOUT_MS || 10000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalWeek(date) {
  const day = date.getDay() || 7;
  const start = startOfLocalDay(date);
  start.setDate(start.getDate() - day + 1);
  return start;
}

function unixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function getLanUrls() {
  const urls = [];

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${PORT}`);
      }
    }
  }

  return urls;
}

function normalizeRateWindow(window) {
  if (!window || !Number.isFinite(Number(window.usedPercent))) {
    return null;
  }

  const usedPercent = Math.max(0, Math.min(100, Number(window.usedPercent)));
  const resetsAt = Number(window.resetsAt);

  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes: Number(window.windowDurationMins) || null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    resetsAtIso: Number.isFinite(resetsAt) ? new Date(resetsAt * 1000).toISOString() : null,
  };
}

function normalizeRateLimit(limit) {
  if (!limit) {
    return null;
  }

  return {
    id: limit.limitId || null,
    name: limit.limitName || null,
    planType: limit.planType || null,
    primary: normalizeRateWindow(limit.primary),
    secondary: normalizeRateWindow(limit.secondary),
    credits: limit.credits
      ? {
          hasCredits: Boolean(limit.credits.hasCredits),
          unlimited: Boolean(limit.credits.unlimited),
          balance: limit.credits.balance ?? null,
        }
      : null,
    rateLimitReachedType: limit.rateLimitReachedType || null,
  };
}

function displayNameFromPath(value) {
  if (!value || value === "(unknown)") {
    return value || "(unknown)";
  }

  return pathBasename(value);
}

function sanitizeLocalPaths(value) {
  return String(value ?? "").replaceAll(/\/Users\/[^\s)\]]+/g, (match) => displayNameFromPath(match));
}

async function loadCodexQuota() {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["-s", "read-only", "-a", "untrusted", "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let rateLimits = null;
    let account = null;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill();
      }
      callback(value);
    };

    const send = (payload) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error("Codex app-server RPC timed out"));
    }, CODEX_RPC_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/rateLimits/read", params: {} });
          continue;
        }

        if (message.id === 2) {
          if (message.error) {
            finish(reject, new Error(message.error.message || "Codex rate limit RPC failed"));
            return;
          }

          rateLimits = message.result;
          send({ id: 3, method: "account/read", params: {} });
          continue;
        }

        if (message.id === 3) {
          account = message.result || null;
          const primaryLimit = normalizeRateLimit(rateLimits?.rateLimits);
          const allLimits = Object.values(rateLimits?.rateLimitsByLimitId || {})
            .map(normalizeRateLimit)
            .filter(Boolean);

          finish(resolve, {
            available: Boolean(primaryLimit?.primary || primaryLimit?.secondary),
            source: "codex app-server",
            fetchedAt: new Date().toISOString(),
            planType: primaryLimit?.planType || account?.account?.planType || null,
            primary: primaryLimit?.primary || null,
            secondary: primaryLimit?.secondary || null,
            credits: primaryLimit?.credits || null,
            rateLimitReachedType: primaryLimit?.rateLimitReachedType || null,
            extraLimits: allLimits.filter((limit) => limit.id !== primaryLimit?.id),
          });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(reject, error);
    });

    child.on("exit", (code) => {
      if (!settled && code !== 0) {
        finish(reject, new Error(stderrBuffer.trim() || `Codex app-server exited with code ${code}`));
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex-report-server", version: "0.1.0" } },
    });
  });
}

async function sqliteJson(sql) {
  if (!existsSync(STATE_DB)) {
    throw new Error(`Codex state database not found: ${STATE_DB}`);
  }

  const { stdout } = await execFileAsync("sqlite3", ["-json", STATE_DB, sql], {
    maxBuffer: 1024 * 1024 * 16,
  });

  if (!stdout.trim()) {
    return [];
  }

  return JSON.parse(stdout);
}

async function loadUsage() {
  const now = new Date();
  const fiveHoursAgo = unixSeconds(new Date(now.getTime() - 5 * 60 * 60 * 1000));
  const todayStart = unixSeconds(startOfLocalDay(now));
  const weekStart = unixSeconds(startOfLocalWeek(now));
  const monthStart = unixSeconds(new Date(now.getFullYear(), now.getMonth(), 1));
  const thirtyDaysAgo = unixSeconds(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));

  const [
    summaryRows,
    periodRows,
    dayRows,
    cwdRows,
    modelRows,
    recentRows,
    quotaResult,
  ] = await Promise.all([
    sqliteJson(`
      select
        count(*) as thread_count,
        coalesce(sum(tokens_used), 0) as total_tokens,
        coalesce(avg(nullif(tokens_used, 0)), 0) as avg_tokens,
        coalesce(max(tokens_used), 0) as max_tokens,
        sum(case when archived = 0 then 1 else 0 end) as active_threads,
        sum(case when archived = 1 then 1 else 0 end) as archived_threads,
        min(created_at) as first_seen,
        max(updated_at) as last_seen
      from threads
    `),
    sqliteJson(`
      select
        coalesce(sum(case when updated_at >= ${fiveHoursAgo} then tokens_used else 0 end), 0) as five_hour_tokens,
        sum(case when updated_at >= ${fiveHoursAgo} then 1 else 0 end) as five_hour_threads,
        coalesce(sum(case when updated_at >= ${todayStart} then tokens_used else 0 end), 0) as today_tokens,
        sum(case when updated_at >= ${todayStart} then 1 else 0 end) as today_threads,
        coalesce(sum(case when updated_at >= ${weekStart} then tokens_used else 0 end), 0) as week_tokens,
        sum(case when updated_at >= ${weekStart} then 1 else 0 end) as week_threads,
        coalesce(sum(case when updated_at >= ${monthStart} then tokens_used else 0 end), 0) as month_tokens,
        sum(case when updated_at >= ${monthStart} then 1 else 0 end) as month_threads
      from threads
    `),
    sqliteJson(`
      select
        date(updated_at, 'unixepoch', 'localtime') as day,
        count(*) as threads,
        coalesce(sum(tokens_used), 0) as tokens
      from threads
      where updated_at >= ${thirtyDaysAgo}
      group by day
      order by day asc
    `),
    sqliteJson(`
      select
        case when cwd = '' then '(unknown)' else cwd end as cwd,
        count(*) as threads,
        coalesce(sum(tokens_used), 0) as tokens,
        max(updated_at) as last_seen
      from threads
      group by cwd
      order by tokens desc
      limit 12
    `),
    sqliteJson(`
      select
        case when model is null or model = '' then '(unknown)' else model end as model,
        count(*) as threads,
        coalesce(sum(tokens_used), 0) as tokens
      from threads
      group by model
      order by tokens desc
      limit 10
    `),
    sqliteJson(`
      select
        id,
        case
          when length(title) > 180 then substr(title, 1, 180) || '...'
          else title
        end as title,
        cwd,
        model,
        tokens_used,
        updated_at,
        archived
      from threads
      order by updated_at desc
      limit 16
    `),
    loadCodexQuota()
      .then((quota) => ({ quota }))
      .catch((error) => ({ error: error.message })),
  ]);

  return {
    generatedAt: now.toISOString(),
    source: "Codex local state",
    summary: summaryRows[0] || {},
    periods: periodRows[0] || {},
    days: fillLastThirtyDays(dayRows, now),
    projects: cwdRows.map((row) => ({
      ...row,
      cwd: displayNameFromPath(row.cwd),
    })),
    models: modelRows,
    recent: recentRows.map((row) => ({
      ...row,
      title: sanitizeLocalPaths(row.title),
      cwd: displayNameFromPath(row.cwd),
    })),
    quota: quotaResult.quota || {
      available: false,
      source: "codex app-server",
      error: quotaResult.error || "Codex quota unavailable",
    },
  };
}

function fillLastThirtyDays(rows, now) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days = [];

  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    days.push(byDay.get(key) || { day: key, threads: 0, tokens: 0 });
  }

  return days;
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/usage")) {
    try {
      const usage = await loadUsage();
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(usage));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  await serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Codex usage report: http://127.0.0.1:${PORT}`);
  for (const url of getLanUrls()) {
    console.log(`LAN: ${url}`);
  }
  console.log(`Reading: ${STATE_DB}`);
});
