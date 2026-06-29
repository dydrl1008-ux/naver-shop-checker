"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// 키워드 입력 파싱: 줄바꿈/콤마로 키워드 분리, "키워드<탭>nvMid" 면 그 줄만 nvMid 지정
function parseInput(text, globalMid) {
  const out = [];
  text.split("\n").forEach((line) => {
    const tabbed = line.split("\t");
    if (tabbed.length >= 2 && tabbed[1].trim()) {
      const kw = tabbed[0].trim();
      if (kw) out.push({ keyword: kw, mid: tabbed[1].trim() });
      return;
    }
    // 탭 없으면 콤마로 여러 키워드 분리
    line.split(",").map((s) => s.trim()).filter(Boolean).forEach((kw) => {
      out.push({ keyword: kw, mid: globalMid || "" });
    });
  });
  // 중복 키워드 제거 (키워드+mid 기준)
  const seen = new Set();
  return out.filter((x) => {
    const k = x.keyword + "|" + x.mid;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export default function Home() {
  const [keywords, setKeywords] = useState("");
  const [globalMid, setGlobalMid] = useState("");
  const [cut, setCut] = useState(4);
  const [adExclude, setAdExclude] = useState(true);
  const [cookie, setCookie] = useState("");
  const [proxies, setProxies] = useState("");
  const [interval, setIntervalMs] = useState(0);
  const [concurrency, setConcurrency] = useState(5);
  const [aliveCount, setAliveCount] = useState(0);
  const [rows, setRows] = useState([]);
  const deadRef = useRef(new Map()); // proxyLine -> 복귀시각(ts)
  const cursorRef = useRef(0);
  const REVIVE_MS = 10 * 60 * 1000; // 죽은 프록시 10분 뒤 자동 복귀

  const proxyList = useMemo(
    () => proxies.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
    [proxies]
  );
  const proxyCount = proxyList.length;

  function aliveProxies() {
    const now = Date.now();
    return proxyList.filter((p) => {
      const t = deadRef.current.get(p);
      return !t || t <= now; // 데드 기록 없거나 10분 지났으면 살아있음
    });
  }
  function nextAlive() {
    const alive = aliveProxies();
    if (!alive.length) return null;
    const p = alive[cursorRef.current % alive.length];
    cursorRef.current = cursorRef.current + 1;
    return p;
  }
  function markDead(line) {
    if (line) deadRef.current.set(line, Date.now() + REVIVE_MS);
    setAliveCount(aliveProxies().length);
  }

  // 프록시 목록 바뀌면 데드 기록 초기화 + 살아있음 카운트 갱신
  useEffect(() => {
    deadRef.current = new Map();
    cursorRef.current = 0;
    setAliveCount(proxyList.length);
  }, [proxies]); // eslint-disable-line react-hooks/exhaustive-deps
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [copied, setCopied] = useState(false);
  const stopRef = useRef(false);
  const outRef = useRef(null);

  // 블록 O + 내 상품 N등 이내인 키워드만 (중복 제거)
  const goodKeywords = useMemo(() => {
    const seen = new Set();
    return rows
      .filter((r) => r.hasBlock && r.myWithinCut)
      .map((r) => r.keyword)
      .filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
  }, [rows]);
  const goodText = goodKeywords.join(",");

  async function copyGood() {
    const text = goodText;
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // 클립보드 API 막힌 환경 폴백
      const ta = outRef.current || document.createElement("textarea");
      if (!outRef.current) {
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
      }
      ta.focus();
      ta.select();
      try { ok = document.execCommand("copy"); } catch {}
      if (!outRef.current) document.body.removeChild(ta);
    }
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  }

  const list = useMemo(() => parseInput(keywords, globalMid), [keywords, globalMid]);

  async function checkOne(it, { debug = false, proxyLine = "" } = {}) {
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: it.keyword,
          targetMid: it.mid,
          cut: Number(cut) || 4,
          adExclude,
          cookie,
          proxies: proxyLine, // 클라이언트가 고른 1개만 전달
          debug,
        }),
      });
      const r = await res.json();
      r._mid = it.mid;
      return r;
    } catch (e) {
      return { keyword: it.keyword, error: e.message, _mid: it.mid };
    }
  }

  // 프록시 풀에서 살아있는 것들로 순차 시도, 실패한 건 10분 데드 처리
  async function fetchKeyword(it, { debug = false } = {}) {
    if (!proxyList.length) return await checkOne(it, { debug }); // 프록시 없으면 그냥
    const tried = new Set();
    let last = null;
    const limit = Math.max(aliveProxies().length, 1);
    for (let k = 0; k < limit; k++) {
      const p = nextAlive();
      if (!p || tried.has(p)) break;
      tried.add(p);
      const r = await checkOne(it, { debug, proxyLine: p });
      last = r;
      if (!r.blocked && !r.error) {
        setAliveCount(aliveProxies().length);
        return r; // 성공 -> 이 프록시 살려둠
      }
      markDead(p); // 실패 -> 10분 데드, 다음 살아있는 프록시로
    }
    return last || { keyword: it.keyword, error: "살아있는 프록시 없음", _mid: it.mid };
  }

  async function run() {
    if (running) return;
    const items = parseInput(keywords, globalMid);
    if (!items.length) return;
    setRunning(true);
    stopRef.current = false;
    setProgress({ done: 0, total: items.length });
    // 매 실행 시작 시 데드 기록 초기화 -> 항상 전체 프록시로 시작 (지난 런의 데드가 발목 안 잡게)
    deadRef.current = new Map();
    cursorRef.current = 0;
    setAliveCount(proxyList.length);
    const gap = Math.max(0, Number(interval) || 0) * 1000;

    // 결과를 인덱스 순서로 유지 (병렬이라 끝나는 순서가 뒤섞임)
    const results = items.map((it) => ({ keyword: it.keyword, _mid: it.mid, _pending: true }));
    setRows(results.slice());

    // 동시 실행 수: 프록시 있으면 프록시 개수 넘지 않게 (한 프록시 동시타격 방지)
    let n = Math.max(1, Math.min(Number(concurrency) || 1, 20));
    if (proxyList.length) n = Math.min(n, proxyList.length);

    let next = 0;
    let done = 0;
    const worker = async () => {
      while (!stopRef.current) {
        const i = next++;
        if (i >= items.length) return;
        const r = await fetchKeyword(items[i]);
        results[i] = r;
        done++;
        setRows(results.slice());
        setProgress({ done, total: items.length });
        if (gap) await new Promise((res) => setTimeout(res, gap));
      }
    };
    await Promise.all(Array.from({ length: n }, () => worker()));
    setRunning(false);
  }

  // 특정 줄만 다시 실행 (차단/실패 재시도)
  async function retry(i) {
    const r0 = rows[i];
    if (!r0) return;
    setRows((prev) => prev.map((x, idx) => (idx === i ? { ...x, _retrying: true } : x)));
    const r = await fetchKeyword({ keyword: r0.keyword, mid: r0._mid });
    setRows((prev) => prev.map((x, idx) => (idx === i ? r : x)));
  }

  // 서버가 실제로 받는 raw HTML 받아오기 (블록 판별 기준 잡기용)
  async function downloadRawHtml() {
    const kw = (prompt("원본 HTML 받을 키워드 1개 (블록 뜨는 거 추천):", list[0]?.keyword || "") || "").trim();
    if (!kw) return;
    const r = await fetchKeyword({ keyword: kw, mid: "" }, { debug: true });
    if (!r.htmlSample) {
      alert("HTML을 못 받았다: " + (r.error || "응답 없음"));
      return;
    }
    const blob = new Blob([r.htmlSample], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `raw_${kw}_${r.htmlLen}.html`;
    a.click();
  }

  function stop() {
    stopRef.current = true;
    setRunning(false);
  }

  function downloadCsv() {
    const head = ["키워드", "가격비교블록", "내상품nvMid", "블록내순위(raw)", "광고제외순위", `${cut}등이내`, "매칭몰", "카드수/광고수", "상태"];
    const lines = rows.map((r) => {
      const block = r.blocked ? "차단" : r.hasBlock ? "O" : "X";
      const within = r.myWithinCut ? "Y" : r.myFound ? "N" : "";
      const cells = [
        r.keyword,
        block,
        r._mid || "",
        r.myRank ?? "",
        r.myOrganicRank ?? "",
        within,
        r.myItem?.mall || "",
        r.blocked ? "" : `${r.cardCount ?? ""}/${r.adCount ?? ""}`,
        r.error ? r.error : `${r.status || ""}`,
      ];
      return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");
    });
    const csv = "\uFEFF" + [head.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `가격비교블록_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  return (
    <div className="wrap">
      <h1>네이버 통검 가격비교 블록 체커</h1>
      <p className="sub">
        모바일 통합검색 페이지를 직접 긁어 <b>가격비교 블록 실제 노출 여부</b>(shp_tli 컨테이너 기준)와
        <b> 내 상품 N등 이내</b>를 확인합니다.
      </p>

      <div className="grid">
        <label className="full">
          키워드 (줄바꿈 또는 콤마 구분 · <code>키워드[탭]nvMid</code> 형식이면 그 줄만 따로 추적)
          <textarea
            rows={7}
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder={"복숭아, 7kg 8kg, 핸드크림\n캠핑의자\t82640123456"}
          />
        </label>

        <label>
          공통 nvMid (선택)
          <input value={globalMid} onChange={(e) => setGlobalMid(e.target.value)} placeholder="줄에 mid 없으면 이 값 사용" />
        </label>
        <label>
          노출 인정 등수
          <input type="number" min={1} max={50} value={cut} onChange={(e) => setCut(e.target.value)} />
        </label>
        <label className="chk">
          <input type="checkbox" checked={adExclude} onChange={(e) => setAdExclude(e.target.checked)} />
          광고 제외하고 순위 계산
        </label>

        <label>
          요청 간격(초)
          <input type="number" min={0} max={10} step={0.5} value={interval} onChange={(e) => setIntervalMs(e.target.value)} />
        </label>
        <label>
          동시 실행 수
          <input type="number" min={1} max={20} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
        </label>

        <label className="full">
          네이버 쿠키 (선택 · 차단 잦으면 로그인 세션 쿠키 붙여넣기)
          <input value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="NID_AUT=...; NID_SES=..." />
        </label>

        <label className="full">
          프록시 (선택 · 한 줄에 하나, 요청마다 로테이션 / 죽으면 10분 뒤 자동 복귀){" "}
          {proxyCount > 0 && (
            <b style={{ color: "#03c75a" }}>
              {proxyCount}개 · 살아있음 {aliveCount}
              {proxyCount - aliveCount > 0 ? ` · 데드 ${proxyCount - aliveCount}` : ""}
            </b>
          )}
          <textarea
            rows={4}
            value={proxies}
            onChange={(e) => setProxies(e.target.value)}
            placeholder={"호스트:포트:아이디:비번  (Webshare 형식)\n198.23.239.134:6540:user:pass\n107.172.163.27:6543:user:pass"}
          />
        </label>
      </div>

      <div className="btns">
        {!running ? (
          <button className="go" onClick={run} disabled={!list.length}>
            확인 시작 ({list.length})
          </button>
        ) : (
          <button className="stop" onClick={stop}>
            중지
          </button>
        )}
        <button onClick={downloadCsv} disabled={!rows.length}>
          CSV 다운로드
        </button>
        <button onClick={downloadRawHtml} title="서버가 실제로 받는 raw HTML 저장 (블록 판별 기준 잡기용)">
          원본 HTML 받기
        </button>
        {progress.total > 0 && (
          <span className="prog">
            {progress.done} / {progress.total}
          </span>
        )}
      </div>

      <div className="goodbox">
        <div className="goodhead">
          <span>
            블록 O + 내 상품 {cut}등 이내 <b>{goodKeywords.length}</b>개
          </span>
          <button className="copy" onClick={copyGood} disabled={!goodKeywords.length}>
            {copied ? "복사됨 ✓" : "복사"}
          </button>
        </div>
        <textarea
          ref={outRef}
          className="goodout"
          readOnly
          value={goodText}
          placeholder="검사 끝나면 여기 키워드1,키워드2 형식으로 모임 (클릭하면 전체 선택)"
          onClick={(e) => e.target.select()}
          rows={3}
        />
      </div>

      <div className="tablebox">
        <table>
          <thead>
            <tr>
              <th>키워드</th>
              <th>가격비교 블록</th>
              <th>내 상품</th>
              <th>{cut}등 이내</th>
              <th>매칭몰</th>
              <th>카드/광고</th>
              <th>상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="kw">{r.keyword}</td>
                <td>
                  {r._pending || r._retrying ? (
                    <span className="b off">…</span>
                  ) : r.blocked ? (
                    <span className="b blk">차단</span>
                  ) : r.hasBlock ? (
                    <span className="b on">블록 O</span>
                  ) : (
                    <span className="b off">블록 X</span>
                  )}
                </td>
                <td>
                  {!r._mid ? (
                    <span className="dash">—</span>
                  ) : r.myFound ? (
                    <>
                      raw {r.myRank}위
                      {r.myOrganicRank ? ` · 광고제외 ${r.myOrganicRank}위` : " · (광고)"}
                    </>
                  ) : r.hasBlock ? (
                    <span className="dash">블록내 미노출</span>
                  ) : (
                    <span className="dash">—</span>
                  )}
                </td>
                <td>
                  {r.myWithinCut ? (
                    <span className="cut yes">✓</span>
                  ) : r.myFound ? (
                    <span className="cut no">✕</span>
                  ) : (
                    <span className="dash">—</span>
                  )}
                </td>
                <td>{r.myItem?.mall || <span className="dash">—</span>}</td>
                <td>{r.blocked ? "—" : `${r.cardCount ?? "—"}/${r.adCount ?? "—"}`}</td>
                <td className="st">
                  {r._pending ? "진행중…" : r.error ? r.error : `${r.status}·${Math.round((r.htmlLen || 0) / 1024)}KB`}
                  {r.usedProxy && !r.error && !r._pending ? ` · ${r.usedProxy}` : ""}
                </td>
                <td>
                  <button className="rt" onClick={() => retry(i)} disabled={r._retrying}>
                    {r._retrying ? "…" : "재시도"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="foot">
        · <b>블록 판별</b> = HTML에 <code>data-slog-container="shp_tli"</code> 존재 여부. 텍스트 "네이버 가격비교"는
        블록 없는 페이지의 JSON에도 박혀 있어 오탐 → 신호로 쓰지 않음.<br />
        · <b>광고 제외 순위</b> = 블록 카드 중 <code>nad-</code> 광고 카드를 뺀 순서. 블록은 보통 광고 몇 개로 시작함.<br />
        · 데이터센터 IP(Vercel)는 차단/캡차가 날 수 있음. 잦으면 쿠키 붙이거나 간격을 늘릴 것.
      </p>
    </div>
  );
}
