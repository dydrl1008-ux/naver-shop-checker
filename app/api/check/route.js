// app/api/check/route.js
// 모바일 통합검색(m.search.naver.com) 페이지를 직접 긁어서
//  1) "네이버 가격비교" 블록이 실제로 렌더됐는지 (= shp_tli 컨테이너 존재)
//  2) 내 nvMid 상품이 그 블록 안에 있는지 + 광고 제외 N등(기본 4) 이내인지
//
// 핵심: 블록 판별은 data-slog-container="shp_tli" 존재로만 한다.
//       텍스트 "네이버 가격비교"는 블록이 없는 페이지에도 JSON 데이터
//       ("source":"네이버 가격비교") 로 박혀 있어서 오탐난다 -> 신호로 쓰지 않음.

import { request, getGlobalDispatcher, interceptors, ProxyAgent } from "undici";
import { gunzipSync, brotliDecompressSync, inflateSync, inflateRawSync } from "node:zlib";

// 프록시 줄 파싱: "host:port:user:pass" / "host:port" / "user:pass@host:port" / "http://..."
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

// 디버그 표시용: 프록시 URL에서 host:port만 추출
function proxyLabel(u) {
  try {
    const x = new URL(u);
    return x.hostname + ":" + x.port;
  } catch {
    return "?";
  }
}

export const runtime = "nodejs";
export const maxDuration = 30;

// undici v6: request 옵션의 maxRedirections 미지원 -> redirect 인터셉터 사용
const redirectDispatcher = getGlobalDispatcher().compose(
  interceptors.redirect({ maxRedirections: 3 })
);

// 블록 자체가 비어 보일 만큼 HTML이 짧으면 차단(캡차) 의심
const MIN_HTML_LEN = 50_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(s) {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// 지문(fingerprint) 풀 — UA만이 아니라 그에 맞는 헤더 세트 전체를 묶어서 로테이션한다.
// (UA만 바꾸고 나머지 헤더가 동일하면 봇으로 잡힘)
const PROFILES = [
  {
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    lang: "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    chua: '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
    platform: '"Android"',
  },
  {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    lang: "ko-KR,ko;q=0.9",
    safari: true,
  },
  {
    ua: "Mozilla/5.0 (Linux; Android 13; SM-G991N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
    lang: "ko-KR,ko;q=0.9,en;q=0.8",
    chua: '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="99"',
    platform: '"Android"',
  },
  {
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
    lang: "ko-KR,ko;q=0.9,en-US;q=0.7",
    chua: '"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
    platform: '"Android"',
  },
  {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    lang: "ko-KR,ko;q=0.9,en-US;q=0.8",
    safari: true,
  },
  {
    ua: "Mozilla/5.0 (Linux; Android 12; SM-A536N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    lang: "ko-KR,ko;q=0.9",
    chua: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    platform: '"Android"',
  },
  {
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S926N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
    lang: "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    chua: '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    platform: '"Android"',
  },
  {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    lang: "ko-KR,ko;q=0.9,en;q=0.8",
    safari: true,
  },
  {
    ua: "Mozilla/5.0 (Linux; Android 13; SM-A346N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    lang: "ko-KR,ko;q=0.9",
    chua: '"Google Chrome";v="126", "Chromium";v="126", "Not.A/Brand";v="24"',
    platform: '"Android"',
  },
  {
    ua: "Mozilla/5.0 (Linux; Android 14; SM-F956N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
    lang: "ko-KR,ko;q=0.9,en-US;q=0.6",
    chua: '"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
    platform: '"Android"',
  },
  {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    lang: "ko-KR,ko;q=0.9",
    safari: true,
  },
];
const ACCEPTS = [
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
];
// 진입 경로(referer)를 여러 방면으로 — 사람은 다양한 데서 검색에 들어온다
const REFERERS = [
  "https://m.naver.com/",
  "https://www.naver.com/",
  "https://m.search.naver.com/",
  null, // 직접 진입(referer 없음)
  "https://search.naver.com/",
];

// 특정 프로필로 헤더 생성 (한 동선 안에서는 같은 프로필 유지 = 사람은 UA 안 바뀜)
function headersForProfile(p, referer) {
  const h = {
    "user-agent": p.ua,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": p.lang,
    "accept-encoding": "gzip, deflate, br",
  };
  if (referer) h.referer = referer;
  return h;
}

function browserHeaders(idx = 0) {
  return headersForProfile(PROFILES[Math.floor(Math.random() * PROFILES.length)], null);
}

// set-cookie 헤더에서 쿠키 문자열 추출
function collectCookies(setCookie) {
  if (!setCookie) return "";
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr.map((c) => String(c).split(";")[0]).filter(Boolean).join("; ");
}

// "네이버 가격비교</h2>" 렌더 헤더가 있는 블록 영역을 잘라낸다.
// 컨테이너 이름(shp_tli / shp_lis 등)이 키워드마다 달라서 이름으로 안 잡고
// 실제 렌더된 헤더로 판별한다. (텍스트 "네이버 가격비교"는 JSON/"더보기"에도
// 있으므로 반드시 </h2> 붙은 헤더만 인정.)
function sliceBlock(html) {
  const m = html.search(/네이버 가격비교<\/h2>/);
  if (m === -1) return null;
  const start = html.lastIndexOf("<section", m);
  const from = start === -1 ? Math.max(0, m - 2000) : start;
  const end = html.indexOf("</section>", m);
  return html.slice(from, end === -1 ? from + 400_000 : end + 10);
}

// 블록 안의 카드들을 문서 순서대로 파싱
// 카드 경계: data-slog-content="{컨테이너}:{슬롯}" (컨테이너는 shp_lis/shp_tli 등)
function parseCards(blockHtml) {
  const cards = [];
  const re = /data-slog-content="[^":]*:([^"]+)"/g;
  let m;
  const idxs = [];
  while ((m = re.exec(blockHtml)) !== null) idxs.push({ slot: m[1], at: m.index });
  for (let i = 0; i < idxs.length; i++) {
    const seg = blockHtml.slice(idxs[i].at, idxs[i + 1] ? idxs[i + 1].at : blockHtml.length);
    const slot = idxs[i].slot;
    // nvMid: view_type_guide_{nvMid} 가 가장 안정적, 없으면 nv_mid=
    let nvMid = (seg.match(/view_type_guide_(\d+)/) || [])[1] ||
                (seg.match(/nv_mid=(\d+)/) || [])[1] || null;
    const isAd = slot.startsWith("nad-") || /ader\.naver\.com/.test(seg) || />광고</.test(seg);
    const mall = clean((seg.match(/class="PtxugWXH"[^>]*>([^<]+)</) || [])[1] || "");
    const price = (seg.match(/class="mjquFHz_"[^>]*>([\d,]+)</) || [])[1] || "";
    cards.push({ nvMid, isAd, mall, price });
  }
  return cards;
}

async function pingProxy(proxyUrl, timeoutMs = 2500) {
  let agent = null;
  try {
    agent = new ProxyAgent({ uri: proxyUrl, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    const res = await request("https://m.naver.com/", {
      method: "HEAD",
      dispatcher: agent,
      headers: { "user-agent": "Mozilla/5.0", "accept-encoding": "gzip" },
    });
    // 어떤 HTTP 응답이든 오면 = 프록시 연결은 살아있음 (네이버 차단여부는 별개)
    return res.statusCode > 0;
  } catch {
    return false;
  } finally {
    if (agent) { try { await agent.close(); } catch {} }
  }
}

async function fetchSerp(keyword, cookie, uaIdx = 0, proxyUrl = null, timeoutMs = 9000, warmup = true) {
  // 한 동선 = 한 프로필 유지 (사람은 검색 중간에 기기/UA 안 바꿈)
  const profile = PROFILES[Math.floor(Math.random() * PROFILES.length)];

  // 검색 URL (진입 파라미터 다양화)
  const SM = ["mtp_hty.top", "mtp_hty.none", "mtp_jum", "mtb_hty.top", "top_hty"];
  const sm = SM[Math.floor(Math.random() * SM.length)];
  const params = new URLSearchParams({ where: "m", sm, query: keyword });
  if (Math.random() < 0.5) params.set("ie", "utf8");
  const searchUrl = "https://m.search.naver.com/search.naver?" + params.toString();

  // 동선 안에서는 같은 IP 유지하려고 keep-alive 살림 (게이트웨이는 fetchSerp 호출마다 새 에이전트 = 키워드마다 새 IP)
  let proxyAgent = null;
  let dispatcher = redirectDispatcher;
  if (proxyUrl) {
    proxyAgent = new ProxyAgent({ uri: proxyUrl, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    dispatcher = proxyAgent.compose(interceptors.redirect({ maxRedirections: 3 }));
  }

  try {
    let jarCookie = cookie || "";
    let referer = null;

    // === 동선 1단계: 네이버 모바일 메인 먼저 방문 (쿠키 받고 진짜 진입처럼) ===
    if (warmup && !cookie) {
      try {
        const w = await request("https://m.naver.com/", {
          method: "GET",
          headers: headersForProfile(profile, null),
          dispatcher,
        });
        jarCookie = collectCookies(w.headers["set-cookie"]);
        await w.body.dump(); // 본문 버림(메인은 안 봄)
        referer = "https://m.naver.com/";
        // 사람처럼 잠깐 텀 (메인 보고 검색창 누르는 시간)
        await sleep(250 + Math.floor(Math.random() * 600));
      } catch {
        // 워밍업 실패해도 검색은 시도
      }
    }

    // === 동선 2단계: 받은 쿠키 + referer 들고 검색 ===
    const headers = headersForProfile(profile, referer);
    if (jarCookie) headers.cookie = jarCookie;

    const res = await request(searchUrl, { method: "GET", headers, dispatcher });
    const enc = String(res.headers["content-encoding"] || "").toLowerCase();
    const buf = Buffer.from(await res.body.arrayBuffer());
    let html;
    try {
      if (enc.includes("br")) html = brotliDecompressSync(buf).toString("utf8");
      else if (enc.includes("gzip")) html = gunzipSync(buf).toString("utf8");
      else if (enc.includes("deflate")) {
        try { html = inflateSync(buf).toString("utf8"); }
        catch { html = inflateRawSync(buf).toString("utf8"); }
      } else html = buf.toString("utf8");
    } catch {
      html = buf.toString("utf8");
    }
    return { status: res.statusCode, html, err: null };
  } catch (e) {
    // 죽은 프록시/연결 실패 등
    return { status: 0, html: "", err: e?.message || "fetch error" };
  } finally {
    if (proxyAgent) { try { await proxyAgent.close(); } catch {} }
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const keyword = (body.keyword || "").trim();
    const targetMid = (body.targetMid || "").toString().trim();
    const debug = body.debug === true;
    let cut = parseInt(body.cut, 10) || 4;             // 노출 인정 등수 (기본 4)
    cut = Math.min(Math.max(cut, 1), 50);
    const adExclude = body.adExclude !== false;        // 기본 true: 광고 제외하고 순위
    const noLogin = body.noLogin === true;             // 비로그인 모드: 쿠키 무시
    const warmup = body.warmup !== false;              // 사람 동선(메인 방문 후 검색), 기본 ON
    const cookie = noLogin ? "" : (body.cookie || process.env.NAVER_COOKIE || "").trim();
    const proxies = parseProxies(body.proxies || process.env.NAVER_PROXIES || "");
    let proxyStart = parseInt(body.proxyStart, 10);
    if (!Number.isFinite(proxyStart)) proxyStart = 0;
    let timeoutMs = parseInt(body.timeoutMs, 10);
    if (!Number.isFinite(timeoutMs)) timeoutMs = 9000;
    timeoutMs = Math.min(Math.max(timeoutMs, 1500), 15000);

    // 핑 모드: 프록시 생존만 빠르게 확인 (사전 청소용)
    if (body.ping === true) {
      const one = proxies[0];
      if (!one) return Response.json({ alive: false });
      const alive = await pingProxy(one, Math.min(timeoutMs, 3000));
      return Response.json({ alive });
    }

    // IP 테스트 모드: 게이트웨이로 실제 나가는 exit IP를 확인 (로테이션 검증)
    if (body.iptest === true) {
      const one = proxies[0];
      if (!one) return Response.json({ ips: [], error: "프록시 없음" });
      const ips = [];
      for (let k = 0; k < 5; k++) {
        let agent = null;
        try {
          agent = new ProxyAgent({
            uri: one, headersTimeout: 8000, bodyTimeout: 8000,
            pipelining: 0, keepAliveTimeout: 1, keepAliveMaxTimeout: 1,
          });
          const res = await request("https://api.ipify.org/", {
            method: "GET", dispatcher: agent, headers: { "connection": "close" },
          });
          const ip = (await res.body.text()).trim();
          ips.push(ip);
        } catch (e) {
          ips.push("실패(" + (e?.code || e?.message || "?") + ")");
        } finally {
          if (agent) { try { await agent.close(); } catch {} }
        }
      }
      const uniq = [...new Set(ips)].length;
      return Response.json({ ips, unique: uniq });
    }

    if (!keyword) return Response.json({ error: "키워드가 비어 있습니다." }, { status: 400 });

    let attempt;
    let usedProxy = null;
    // 프록시 1개면 1회(클라가 로테이션 담당), 여러개면 개수만큼, 없으면 3회
    const MAX_TRY = proxies.length ? (proxies.length === 1 ? 1 : Math.min(proxies.length, 6)) : 3;
    for (let t = 0; t < MAX_TRY; t++) {
      const fpIdx = Math.floor(Math.random() * PROFILES.length);
      const proxyUrl = proxies.length ? proxies[(proxyStart + t) % proxies.length] : null;
      usedProxy = proxyUrl ? proxyLabel(proxyUrl) : null;
      attempt = await fetchSerp(keyword, cookie, fpIdx, proxyUrl, timeoutMs, warmup);
      if (attempt.status === 200 && attempt.html.length >= MIN_HTML_LEN) break;
      if (t < MAX_TRY - 1) {
        await sleep(proxies.length ? 150 : 500 + t * 600 + Math.floor(Math.random() * 300));
      }
    }
    const { status, html } = attempt;

    // 차단/캡차 의심
    if (status !== 200 || html.length < MIN_HTML_LEN) {
      const why = attempt.err
        ? `프록시/연결 실패 (${attempt.err})`
        : `차단 의심 (status ${status}, ${Math.round(html.length / 1024)}KB)`;
      return Response.json({
        keyword, status, htmlLen: html.length,
        blocked: true,
        usedProxy,
        error: `${why}${usedProxy ? ` [proxy ${usedProxy}]` : ""}. 쿠키/프록시 확인 후 재시도.`,
        ...(debug ? { htmlSample: html } : {}),
      });
    }

    // 진단용: raw HTML에 어떤 후보 신호가 있는지 (블록 판별은 헤더로만)
    const signals = {
      blockHeader: /네이버 가격비교<\/h2>/.test(html), // ★ 실제 판별 기준
      shpTli: html.includes('data-slog-container="shp_tli"'),
      shpLis: html.includes('data-slog-container="shp_lis"'),
      textPriceCompare: html.includes("네이버 가격비교"),
      shoppingApi: /cr\d?\.shopping\.naver\.com|msearch\.shopping\.naver\.com/.test(html),
    };

    // ★ 블록 판별: shp_tli 컨테이너 존재 여부 (텍스트 매칭 X)
    const blockHtml = sliceBlock(html);
    const hasBlock = blockHtml !== null;

    let cards = [], myRank = null, myOrganicRank = null, myItem = null;
    if (hasBlock) {
      cards = parseCards(blockHtml);
      // 같은 nvMid가 광고+오가닉으로 둘 다 뜰 수 있음 -> 오가닉 우선
      let organic = 0;
      let adHit = null;   // 광고로 처음 만난 위치
      let orgHit = null;  // 오가닉으로 만난 위치
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (!c.isAd) organic++;
        if (targetMid && c.nvMid === targetMid) {
          if (c.isAd) {
            if (!adHit) adHit = { rank: i + 1, item: c };
          } else {
            orgHit = { rank: i + 1, organic, item: c };
            break; // 오가닉 찾으면 끝
          }
        }
      }
      if (orgHit) {
        myRank = orgHit.rank;
        myOrganicRank = orgHit.organic;
        myItem = orgHit.item;
      } else if (adHit) {
        myRank = adHit.rank;
        myOrganicRank = null; // 광고로만 노출
        myItem = adHit.item;
      }
    }

    const rankForCut = adExclude ? myOrganicRank : myRank;
    const myWithinCut = rankForCut !== null && rankForCut <= cut;

    return Response.json({
      keyword,
      status,
      htmlLen: html.length,
      blocked: false,
      hasBlock,
      cardCount: cards.length,
      adCount: cards.filter((c) => c.isAd).length,
      targetMid: targetMid || null,
      cut,
      adExclude,
      myFound: myRank !== null,
      myRank,
      myOrganicRank,
      myWithinCut,
      myItem,
      signals,
      usedProxy,
      ...(debug ? { htmlSample: html } : {}),
    });
  } catch (e) {
    return Response.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
