"use client";

import { useMemo, useRef, useState } from "react";

// 콤마 / 줄바꿈 / 탭 모두 키워드 구분자
function parseKeywords(text, mid) {
  const seen = new Set();
  return text.split(/[\n,\t]/).map((s) => s.trim()).filter(Boolean)
    .filter((k) => (seen.has(k) ? false : (seen.add(k), true)))
    .map((keyword) => ({ keyword, mid: mid || "" }));
}

// 복사: clipboard API 실패 시 execCommand fallback
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

export default function Home() {
  const [keywords, setKeywords] = useState("");
  const [globalMid, setGlobalMid] = useState("");
  const [cut, setCut] = useState(4);
  const [source, setSource] = useState("mobile");
  const [cookie, setCookie] = useState("");
  const [proxy, setProxy] = useState("");
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [copied, setCopied] = useState("");
  const stopRef = useRef(false);

  const jobs = useMemo(() => parseKeywords(keywords, globalMid), [keywords, globalMid]);
  const stats = useMemo(() => {
    const done = rows.filter((r) => r && !r.pending && !r.error);
    const block = done.filter((r) => !r.blocked && r.blockFound).length;
    const blocked = done.filter((r) => r.blocked).length;
    const within = done.filter((r) => r.targetMid && r.myWithinCut).length;
    return { total: rows.length, block, blocked, within };
  }, [rows]);

  // 마지막에 복사할 두 리스트
  const blockList = useMemo(
    () => rows.filter((r) => r && !r.pending && !r.error && !r.blocked && r.blockFound).map((r) => r.keyword).join(","),
    [rows]
  );
  const productList = useMemo(
    () => rows.filter((r) => r && !r.pending && !r.error && !r.blocked && (r.myInBlock || r.myOnPage)).map((r) => r.keyword).join(","),
    [rows]
  );

  async function run() {
    if (running) return;
    const list = parseKeywords(keywords, globalMid);
    if (!list.length) return;
    stopRef.current = false;
    setRunning(true);
    setCopied("");
    setRows(list.map((j) => ({ keyword: j.keyword, targetMid: j.mid || null, pending: true })));
    setProgress({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      if (stopRef.current) break;
      const j = list[i];
      let result;
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyword: j.keyword, targetMid: j.mid, cut, source, cookie, proxy }),
        });
        const data = await res.json();
        result = data.error
          ? { keyword: j.keyword, targetMid: j.mid || null, error: data.error }
          : { ...data, targetMid: j.mid || null };
      } catch (e) {
        result = { keyword: j.keyword, targetMid: j.mid || null, error: e.message };
      }
      setRows((prev) => { const n = [...prev]; n[i] = result; return n; });
      setProgress({ done: i + 1, total: list.length });
      await new Promise((r) => setTimeout(r, 350));
    }
    setRunning(false);
  }
  function stop() { stopRef.current = true; setRunning(false); }

  async function doCopy(text, key) {
    if (!text) return;
    const ok = await copyText(text);
    setCopied(ok ? key : key + "-fail");
    setTimeout(() => setCopied(""), 1600);
  }

  function downloadCsv() {
    const header = ["키워드","가격비교블록","내nvMid","블록내위치",`${cut}등이내`,"페이지내존재","상태","httpStatus","htmlLen"];
    const lines = rows.filter((r) => r && !r.pending).map((r) => {
      if (r.error) return [r.keyword,"오류","","","","","오류","","",r.error];
      if (r.blocked) return [r.keyword,"차단","","","","","차단",r.status??"",r.htmlLen??"",r.blockedReason??""];
      return [
        r.keyword, r.blockFound ? "O" : "X", r.targetMid || "",
        r.myPosInBlock ?? "", r.targetMid ? (r.myWithinCut ? "O" : (r.myInBlock ? "밖" : (r.myOnPage ? "페이지有" : "없음"))) : "",
        r.myOnPage ? "O" : "X", "정상", r.status ?? "", r.htmlLen ?? "",
      ];
    });
    const csv = [header, ...lines].map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `naver_tonggeom_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const hasResults = rows.some((r) => r && !r.pending);

  return (
    <div className="wrap">
      <header className="head">
        <div>
          <h1><span className="g">네이버 통검</span> 가격비교 블록 직접 체커</h1>
          <p className="sub">통합검색 페이지를 직접 긁어서 "네이버 가격비교" 블록이 실제로 뜨는지 + 내 상품이 그 안에 있는지 확인</p>
        </div>
        <span className="ver">{source === "pc" ? "search.naver" : "m.search"} · scrape</span>
      </header>

      <section className="panel">
        <div className="field" style={{ display: "flex", flexDirection: "column" }}>
          <label>키워드 (콤마 또는 줄바꿈으로 구분)</label>
          <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)}
            placeholder={"복숭아,캠핑의자,핸드크림\n또는 한 줄에 하나씩"} spellCheck={false} />
          <div className="hint"><code>키워드1,키워드2</code> 콤마로 쭉 넣어도 되고 줄바꿈도 됨. 중복은 자동 제거.</div>
        </div>
        <div className="side">
          <div className="field">
            <label>내 상품 nvMid (선택)</label>
            <input value={globalMid} onChange={(e) => setGlobalMid(e.target.value)} placeholder="예: 82640123456" inputMode="numeric" />
          </div>
          <div className="row2">
            <div className="field">
              <label>소스</label>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="mobile">통검 모바일</option>
                <option value="pc">통검 PC</option>
              </select>
            </div>
            <div className="field">
              <label>블록내 n등 이내</label>
              <input type="number" min={1} max={50} value={cut}
                onChange={(e) => setCut(Math.min(Math.max(Number(e.target.value) || 1, 1), 50))} />
            </div>
          </div>
          <div className="run">
            <button className="go" onClick={run} disabled={running || jobs.length === 0}>
              {running ? `처리 중… ${progress.done}/${progress.total}` : `체크 시작 (${jobs.length})`}
            </button>
            {running && <button className="stop" onClick={stop}>중지</button>}
          </div>
        </div>
      </section>

      <section className="panel" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="field">
          <label>네이버 세션 쿠키 (로그인용, 선택)</label>
          <textarea className="cookie" value={cookie} onChange={(e) => setCookie(e.target.value)}
            placeholder="필요 시 로그인된 브라우저의 Cookie 값. 블록 확인은 로그아웃으로도 되니 비워둬도 됨." spellCheck={false} />
        </div>
        <div className="field">
          <label>프록시 URL (선택)</label>
          <input value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://user:pass@host:port" />
          <div className="hint">Vercel IP가 막힐 때만. 안 막히면 비워두면 됨.</div>
        </div>
      </section>

      {(hasResults || running) && (
        <>
          <div className="summary">
            <span className="chip">키워드 <b>{stats.total}</b></span>
            <span className="chip green">가격비교 블록 <b>{stats.block}</b></span>
            {stats.within > 0 && <span className="chip green">{cut}등 이내 <b>{stats.within}</b></span>}
            {stats.blocked > 0 && <span className="chip red">차단 <b>{stats.blocked}</b></span>}
            <span className="spacer" />
            <button className="csv" onClick={downloadCsv} disabled={!hasResults}>CSV 다운로드</button>
          </div>
          <div className="progress"><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
        </>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 38 }}>#</th>
              <th>키워드</th>
              <th style={{ width: 120 }}>가격비교 블록</th>
              <th style={{ width: 130 }}>내 상품(블록내)</th>
              <th style={{ width: 110 }}>상태</th>
              <th>디버그</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (<tr><td colSpan={6}><div className="empty">키워드를 입력하고 체크를 시작하세요.</div></td></tr>)}
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="idx">{i + 1}</td>
                <td className="kw">{r.keyword}</td>
                {r?.pending ? (<td colSpan={4}><span className="spin">통검 조회 중…</span></td>)
                  : r?.error ? (<td colSpan={4}><span className="err">{r.error}</span></td>)
                  : r?.blocked ? (<>
                      <td><span className="tag blocked">차단</span></td>
                      <td className="dash">—</td>
                      <td><span className="tag blocked">blocked</span></td>
                      <td className="dbg">{r.blockedReason} · {r.status} · {r.htmlLen}b</td>
                    </>)
                  : (<>
                    <td><span className={`pc ${r.blockFound ? "yes" : "no"}`}>{r.blockFound ? "블록 O" : "블록 X"}</span></td>
                    <td className="num">
                      {!r.targetMid ? <span className="dash">—</span>
                        : r.myWithinCut ? <span className="rank t1">{r.myPosInBlock}번 ✓</span>
                        : r.myInBlock ? <span className="rank t2">{r.myPosInBlock}번</span>
                        : r.myOnPage ? <span className="tag warn">페이지有</span>
                        : <span className="rank none">없음</span>}
                    </td>
                    <td><span className="tag ok">정상</span></td>
                    <td className="dbg">{r.status} · {r.htmlLen}b{r.matchedSignals?.length ? ` · [${r.matchedSignals.join("|")}]` : ""}</td>
                  </>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasResults && (
        <div className="extract">
          <div className="box">
            <div className="top">
              <span className="lbl">가격비교 블록 뜬 키워드 <b>{blockList ? blockList.split(",").length : 0}</b></span>
              <button className={`copy ${copied === "block" ? "done" : copied === "block-fail" ? "fail" : ""}`}
                onClick={() => doCopy(blockList, "block")} disabled={!blockList}>
                {copied === "block" ? "복사됨!" : copied === "block-fail" ? "복사 실패—직접선택" : "복사"}
              </button>
            </div>
            <textarea readOnly value={blockList} onFocus={(e) => e.target.select()}
              placeholder="블록 O 키워드가 여기 모임" />
          </div>
          <div className="box">
            <div className="top">
              <span className="lbl">내 상품 있는 키워드 <b>{productList ? productList.split(",").length : 0}</b></span>
              <button className={`copy ${copied === "prod" ? "done" : copied === "prod-fail" ? "fail" : ""}`}
                onClick={() => doCopy(productList, "prod")} disabled={!productList}>
                {copied === "prod" ? "복사됨!" : copied === "prod-fail" ? "복사 실패—직접선택" : "복사"}
              </button>
            </div>
            <textarea readOnly value={productList} onFocus={(e) => e.target.select()}
              placeholder="nvMid 넣고 돌리면 내 상품 뜬 키워드가 여기 모임" />
          </div>
        </div>
      )}

      <p className="foot">
        · <b>가격비교 블록</b> = 통검 HTML에 "네이버 가격비교" 블록이 실제로 있는지 직접 확인.<br />
        · <b>복사 버튼</b>이 안 먹으면 빨갛게 "직접선택" 뜸 → 아래 텍스트박스 클릭하면 전체 선택되니 Ctrl+C로 복사.<br />
        · <b>차단</b>(htmlLen 작음) 뜨면 쿠키/프록시 또는 상시 서버에서 실행.
      </p>
    </div>
  );
}
