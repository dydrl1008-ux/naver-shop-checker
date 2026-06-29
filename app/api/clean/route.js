// app/api/clean/route.js
// 프록시 풀을 받아서 서버 내부에서 한꺼번에 핑 돌려 살아있는 것만 돌려준다.
// (브라우저가 하나씩 핑하면 왕복이 많아 느림 -> 서버가 일괄 처리)

import { request, ProxyAgent } from "undici";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseProxies(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^https?:\/\//i.test(line)) return line;
      if (line.includes("@")) return "http://" + line;
      const p = line.split(":");
      if (p.length === 4) {
        const [host, port, user, pass] = p;
        return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      }
      if (p.length === 2) return `http://${p[0]}:${p[1]}`;
      return null;
    })
    .filter(Boolean);
}

async function ping(proxyUrl, timeoutMs) {
  let agent = null;
  try {
    agent = new ProxyAgent({ uri: proxyUrl, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    const res = await request("https://m.naver.com/", {
      method: "HEAD",
      dispatcher: agent,
      headers: { "user-agent": "Mozilla/5.0", "accept-encoding": "gzip" },
    });
    return res.statusCode > 0;
  } catch {
    return false;
  } finally {
    if (agent) { try { await agent.close(); } catch {} }
  }
}

// 동시성 제한 풀 실행
async function pool(items, conc, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      const ok = await fn(items[idx]);
      if (ok) out.push(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const lines = String(body.proxies || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return Response.json({ alive: [], total: 0 });

    let timeoutMs = parseInt(body.timeoutMs, 10);
    if (!Number.isFinite(timeoutMs)) timeoutMs = 1200;
    timeoutMs = Math.min(Math.max(timeoutMs, 600), 4000);

    let conc = parseInt(body.concurrency, 10);
    if (!Number.isFinite(conc)) conc = 200;
    conc = Math.min(Math.max(conc, 10), 400);

    // 라인 원본을 유지하면서 핑 (반환은 원본 형식 그대로)
    const urls = lines.map((l) => ({ raw: l, url: parseProxies(l)[0] })).filter((x) => x.url);
    const aliveRaw = await pool(urls, conc, async (x) => await ping(x.url, timeoutMs));
    const alive = aliveRaw.map((x) => x.raw);

    return Response.json({ alive, total: lines.length, aliveCount: alive.length });
  } catch (e) {
    return Response.json({ error: e?.message || "청소 실패" }, { status: 500 });
  }
}
