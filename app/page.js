"use client";

import { useMemo, useRef, useState } from "react";

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
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const stopRef = useRef(false);

  const list = useMemo(() => parseInput(keywords, globalMid), [keywords, globalMid]);

  async function run() {
    if (running) return;
    const items = parseInput(keywords, globalMid);
    if (!items.length) return;
    setRunning(true);
    stopRef.current = false;
    setRows([]);
    setProgress({ done: 0, total: items.length });

    for (let i = 0; i < items.length; i++) {
      if (stopRef.current) break;
      const it = items[i];
      let r;
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
          }),
        });
        r = await res.json();
      } catch (e) {
        r = { keyword: it.keyword, error: e.message };
      }
      r._mid = it.mid;
      setRows((prev) => [...prev, r]);
      setProgress({ done: i + 1, total: items.length });
      await new Promise((res) => setTimeout(res, 350)); // 차단 회피용 간격
    }
    setRunning(false);
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

        <label className="full">
          네이버 쿠키 (선택 · 차단 잦으면 로그인 세션 쿠키 붙여넣기)
          <input value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="NID_AUT=...; NID_SES=..." />
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
        {progress.total > 0 && (
          <span className="prog">
            {progress.done} / {progress.total}
          </span>
        )}
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
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="kw">{r.keyword}</td>
                <td>
                  {r.blocked ? (
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
                <td className="st">{r.error ? r.error : `${r.status}·${Math.round((r.htmlLen || 0) / 1024)}KB`}</td>
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
