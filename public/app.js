const numberFormat = new Intl.NumberFormat("zh-CN");
const compactFormat = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const fullDateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const percentFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 1,
});
const POLL_INTERVAL_MS = 60 * 1000;
let isLoading = false;

const els = {
  source: document.querySelector("#source"),
  refresh: document.querySelector("#refresh"),
  totalTokens: document.querySelector("#totalTokens"),
  threadCount: document.querySelector("#threadCount"),
  fiveHourTokens: document.querySelector("#fiveHourTokens"),
  fiveHourThreads: document.querySelector("#fiveHourThreads"),
  todayTokens: document.querySelector("#todayTokens"),
  todayThreads: document.querySelector("#todayThreads"),
  weekTokens: document.querySelector("#weekTokens"),
  weekThreads: document.querySelector("#weekThreads"),
  monthTokens: document.querySelector("#monthTokens"),
  monthThreads: document.querySelector("#monthThreads"),
  updatedAt: document.querySelector("#updatedAt"),
  quotaSource: document.querySelector("#quotaSource"),
  quotaDetails: document.querySelector("#quotaDetails"),
  chart: document.querySelector("#chart"),
  projects: document.querySelector("#projects"),
  models: document.querySelector("#models"),
  recent: document.querySelector("#recent"),
};

function formatTokens(value, compact = false) {
  const number = Number(value || 0);
  return compact ? compactFormat.format(number) : numberFormat.format(number);
}

function formatThreads(count) {
  return `${numberFormat.format(Number(count || 0))} 个会话`;
}

function formatUnix(seconds) {
  if (!seconds) {
    return "-";
  }

  return dateTimeFormat.format(new Date(Number(seconds) * 1000));
}

function formatReset(seconds) {
  if (!seconds) {
    return "无 reset 时间";
  }

  return `重置 ${formatUnix(seconds)}`;
}

function renderOfficialRemaining(valueEl, detailEl, windowData, fallbackUsed, fallbackThreads) {
  if (!windowData) {
    valueEl.textContent = "不可用";
    detailEl.textContent = `本地已用 ${formatTokens(fallbackUsed, true)} · ${formatThreads(
      fallbackThreads,
    )}`;
    return;
  }

  valueEl.textContent = `${percentFormat.format(windowData.remainingPercent)}%`;
  detailEl.textContent = `已用 ${percentFormat.format(windowData.usedPercent)}% · ${formatReset(
    windowData.resetsAt,
  )}`;
}

function basename(path) {
  if (!path || path === "(unknown)") {
    return path || "(unknown)";
  }

  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
}

function sanitizeLocalPaths(text) {
  return String(text ?? "").replaceAll(/\/Users\/[^\s)\]]+/g, (match) => basename(match));
}

function renderMetrics(data) {
  const { summary, periods } = data;
  const quota = data.quota || {};

  els.totalTokens.textContent = formatTokens(summary.total_tokens, true);
  els.threadCount.textContent = `${formatThreads(summary.thread_count)} · 平均 ${formatTokens(
    summary.avg_tokens,
    true,
  )}`;
  renderOfficialRemaining(
    els.fiveHourTokens,
    els.fiveHourThreads,
    quota.primary,
    periods.five_hour_tokens,
    periods.five_hour_threads,
  );
  els.todayTokens.textContent = formatTokens(periods.today_tokens, true);
  els.todayThreads.textContent = formatThreads(periods.today_threads);
  renderOfficialRemaining(
    els.weekTokens,
    els.weekThreads,
    quota.secondary,
    periods.week_tokens,
    periods.week_threads,
  );
  els.monthTokens.textContent = formatTokens(periods.month_tokens, true);
  els.monthThreads.textContent = formatThreads(periods.month_threads);
}

function renderQuotaDetails(quota) {
  if (!quota?.available) {
    els.quotaSource.textContent = quota?.error || "官方额度不可用";
    els.quotaDetails.innerHTML = `<div class="empty">无法从 Codex app-server 读取官方额度</div>`;
    return;
  }

  const details = [
    ["来源", quota.source || "codex app-server"],
    ["Plan", quota.planType || "-"],
    ["5 小时", `${percentFormat.format(quota.primary?.usedPercent || 0)}% 已用 · ${formatReset(quota.primary?.resetsAt)}`],
    ["本周", `${percentFormat.format(quota.secondary?.usedPercent || 0)}% 已用 · ${formatReset(quota.secondary?.resetsAt)}`],
  ];

  if (quota.credits) {
    details.push([
      "Credits",
      quota.credits.unlimited
        ? "unlimited"
        : quota.credits.hasCredits
          ? `${quota.credits.balance ?? 0} 剩余`
          : "无",
    ]);
  }

  els.quotaSource.textContent = `更新于 ${fullDateTimeFormat.format(new Date(quota.fetchedAt))}`;
  els.quotaDetails.replaceChildren(
    ...details.map(([label, value]) => {
      const item = document.createElement("div");
      item.className = "quota-item";
      item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
      return item;
    }),
  );
}

function renderChart(days) {
  const max = Math.max(...days.map((day) => Number(day.tokens || 0)), 1);

  els.chart.replaceChildren(
    ...days.map((day) => {
      const tokens = Number(day.tokens || 0);
      const bar = document.createElement("div");
      const height = Math.max((tokens / max) * 100, tokens > 0 ? 2 : 0);
      bar.className = "bar";
      bar.style.height = `${height}%`;
      bar.dataset.hot = tokens === max && max > 0 ? "true" : "false";
      bar.setAttribute(
        "aria-label",
        `${day.day}: ${formatTokens(tokens)} Token, ${formatThreads(day.threads)}`,
      );
      bar.title = bar.getAttribute("aria-label");
      return bar;
    }),
  );
}

function renderRankList(container, rows, nameKey) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty">暂无数据</div>`;
    return;
  }

  const max = Math.max(...rows.map((row) => Number(row.tokens || 0)), 1);
  container.replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement("div");
      item.className = "rank-item";
      const name = row[nameKey] || "(unknown)";
      const percent = Math.max((Number(row.tokens || 0) / max) * 100, 1);
      const displayName = nameKey === "cwd" ? basename(name) : name;

      item.innerHTML = `
        <div class="rank-row">
          <span class="rank-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
          <span class="rank-value">${formatTokens(row.tokens, true)} · ${formatThreads(
            row.threads,
          )}</span>
        </div>
        <div class="rank-track" aria-hidden="true">
          <div class="rank-fill" style="width: ${percent}%"></div>
        </div>
      `;
      return item;
    }),
  );
}

function renderRecent(rows) {
  if (!rows.length) {
    els.recent.innerHTML = `<tr><td colspan="5" class="empty">暂无数据</td></tr>`;
    return;
  }

  els.recent.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement("tr");
      const title = sanitizeLocalPaths(row.title || row.id || "(untitled)");
      tr.innerHTML = `
        <td>
          <strong class="recent-title">${escapeHtml(title)}</strong>
          ${row.archived ? '<div class="muted">已归档</div>' : ""}
        </td>
        <td><span class="path">${escapeHtml(basename(row.cwd))}</span></td>
        <td>${escapeHtml(row.model || "(unknown)")}</td>
        <td>${formatTokens(row.tokens_used)}</td>
        <td>${formatUnix(row.updated_at)}</td>
      `;
      return tr;
    }),
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function load() {
  if (isLoading) {
    return;
  }

  isLoading = true;
  els.refresh.disabled = true;
  els.source.textContent = "刷新中";

  try {
    const response = await fetch(`/api/usage?ts=${Date.now()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "读取失败");
    }

    renderMetrics(data);
    renderQuotaDetails(data.quota);
    renderChart(data.days);
    renderRankList(els.projects, data.projects, "cwd");
    renderRankList(els.models, data.models, "model");
    renderRecent(data.recent);

    els.source.textContent = data.quota?.available ? "官方额度已同步" : "本地用量已同步";
    els.updatedAt.textContent = `更新于 ${fullDateTimeFormat.format(new Date(data.generatedAt))}`;
  } catch (error) {
    els.source.textContent = error.message;
    els.chart.innerHTML = `<div class="empty">读取失败：${escapeHtml(error.message)}</div>`;
  } finally {
    isLoading = false;
    els.refresh.disabled = false;
  }
}

els.refresh.addEventListener("click", load);
load();
setInterval(load, POLL_INTERVAL_MS);
