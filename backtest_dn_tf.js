/**
 * Donchian 時間框架比較回測
 *
 * 比較四種版本（雙向，24個月，43幣）：
 *   V1: 1D  N30/N15        — 基準（每日一次）
 *   V2: 4H  N180/N90       — 等效日線（30天×6根）
 *   V3: 4H  N60/N30        — 縮短版（10天×6根）
 *   V4: 1H  N720/N360      — 等效日線（30天×24根）
 *
 * BTC MA200（日線）過濾方向：牛市做多 / 熊市做空
 */

import { existsSync, writeFileSync } from "fs";

const MONTHS     = 24;
const SYMBOLS    = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOGEUSDT","DOTUSDT","LINKUSDT",
  "LTCUSDT","NEARUSDT","UNIUSDT","AAVEUSDT","ATOMUSDT",
  "FILUSDT","ETCUSDT","XLMUSDT","ALGOUSDT",
  "CRVUSDT","INJUSDT","APTUSDT","ARBUSDT","OPUSDT",
  "LDOUSDT","RUNEUSDT","SEIUSDT","SUIUSDT","TIAUSDT",
  "STXUSDT","ORDIUSDT","WLDUSDT","PENDLEUSDT",
  "FETUSDT","RENDERUSDT","BCHUSDT","TRXUSDT","ICPUSDT",
  "HBARUSDT","VETUSDT","DYDXUSDT","GMXUSDT","ZECUSDT",
];

const PORTFOLIO  = 10000;
const RISK_PCT   = 0.01;
const MAX_TRADE  = 2000;
const TP_RATIO   = 3.0;
const COOLDOWN   = 3 * 24 * 3600 * 1000; // 3天（毫秒）

const VERSIONS = [
  { name: "1D  N30/15 ", tf: "1d", nH: 30,  nL: 15,  label: "日線基準" },
  { name: "4H  N180/90", tf: "4h", nH: 180, nL: 90,  label: "4H等效日線" },
  { name: "4H  N60/30 ", tf: "4h", nH: 60,  nL: 30,  label: "4H縮短版" },
  { name: "1H  N720/360",tf: "1h", nH: 720, nL: 360, label: "1H等效日線" },
];

// ─── Binance 資料下載（分頁）─────────────────────────────────────────────────
async function fetchKlines(symbol, interval, totalBars) {
  const MAX_PER_REQ = 1000;
  const bars = [];
  let endTime = Date.now();

  while (bars.length < totalBars) {
    const need = Math.min(MAX_PER_REQ, totalBars - bars.length);
    const url  = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${need}&endTime=${endTime}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!raw.length) break;
    bars.unshift(...raw.map(k => ({ t: +k[0], h: +k[2], l: +k[3], c: +k[4] })));
    endTime = raw[0][0] - 1;
    if (raw.length < need) break;
    await new Promise(r => setTimeout(r, 60));
  }
  return bars;
}

async function fetchDaily(symbol, limit) {
  return fetchKlines(symbol, "1d", limit);
}

// ─── BTC MA200 日期地圖（日線） ───────────────────────────────────────────────
async function buildBtcBullMap(totalDays) {
  console.log("  下載 BTC 日線...");
  const bars = await fetchDaily("BTCUSDT", 200 + totalDays + 10);
  const map  = {};
  for (let i = 200; i < bars.length; i++) {
    const ma  = bars.slice(i - 200, i).reduce((s, b) => s + b.c, 0) / 200;
    const key = new Date(bars[i].t).toISOString().slice(0, 10);
    map[key]  = bars[i].c >= ma;
  }
  return map;
}

// 將任意時間戳取 UTC 日期字串
function toDate(ts) { return new Date(ts).toISOString().slice(0, 10); }

// ─── 滾動最高/最低 ───────────────────────────────────────────────────────────
function rollHigh(arr, n) { return Math.max(...arr.slice(-n)); }
function rollLow (arr, n) { return Math.min(...arr.slice(-n)); }

// ─── 單版本回測 ───────────────────────────────────────────────────────────────
function simulate(allBars, btcBullMap, nH, nL) {
  const startMs  = Date.now() - MONTHS * 30 * 86400000;
  const needed   = nH + nL;
  const cooldown = {};
  let equity = PORTFOLIO;
  let maxEq  = PORTFOLIO;
  let maxDD  = 0;
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
  const monthly = {};

  for (const [sym, bars] of Object.entries(allBars)) {
    const open = [];  // 模擬持倉

    for (let i = needed; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.t < startMs) continue;

      const dateStr = toDate(bar.t);
      const isBull  = btcBullMap[dateStr] ?? true;

      // ── 出場檢查（先於進場）
      for (let pi = open.length - 1; pi >= 0; pi--) {
        const pos = open[pi];
        let exitPrice = null, exitReason = null;

        if (pos.side === "long") {
          // 追蹤止損上移
          const newSL = rollLow(bars.slice(Math.max(0, i - nL), i + 1).map(b => b.l), nL);
          if (newSL > pos.sl) pos.sl = newSL;
          if (bar.l <= pos.sl) { exitPrice = pos.sl; exitReason = "SL"; }
          else if (bar.h >= pos.tp) { exitPrice = pos.tp; exitReason = "TP"; }
        } else {
          const newSL = rollHigh(bars.slice(Math.max(0, i - nL), i + 1).map(b => b.h), nL);
          if (newSL < pos.sl) pos.sl = newSL;
          if (bar.h >= pos.sl) { exitPrice = pos.sl; exitReason = "SL"; }
          else if (bar.l <= pos.tp) { exitPrice = pos.tp; exitReason = "TP"; }
        }

        if (exitPrice !== null) {
          const sign = pos.side === "long" ? 1 : -1;
          const pnl  = sign * (exitPrice - pos.entry) * pos.qty;
          equity += pnl;
          if (pnl > 0) { wins++; grossWin += pnl; }
          else         { losses++; grossLoss += Math.abs(pnl); }
          maxEq = Math.max(maxEq, equity);
          maxDD = Math.max(maxDD, maxEq - equity);
          const mon = dateStr.slice(0, 7);
          monthly[mon] = (monthly[mon] || 0) + pnl;
          cooldown[sym] = bar.t;
          open.splice(pi, 1);
        }
      }

      // ── 進場信號
      if (cooldown[sym] && bar.t - cooldown[sym] < COOLDOWN) continue;
      if (open.length >= 8) continue;  // 全域最大倉位（跨幣）

      const prev  = bars.slice(i - nH, i);
      const win   = bars.slice(i - nL, i + 1);
      let sig = null;

      if (isBull) {
        const prevHigh = rollHigh(prev.map(b => b.h), nH);
        if (bar.c > prevHigh) {
          const sl    = rollLow(win.map(b => b.l), nL);
          const slPct = (bar.c - sl) / bar.c;
          if (sl < bar.c && slPct >= 0.003 && slPct <= 0.25) {
            sig = { side: "long", entry: bar.c, sl, tp: bar.c + (bar.c - sl) * TP_RATIO, slPct };
          }
        }
      } else {
        const prevLow = rollLow(prev.map(b => b.l), nH);
        if (bar.c < prevLow) {
          const sl    = rollHigh(win.map(b => b.h), nL);
          const slPct = (sl - bar.c) / bar.c;
          if (sl > bar.c && slPct >= 0.003 && slPct <= 0.25) {
            sig = { side: "short", entry: bar.c, sl, tp: bar.c - (sl - bar.c) * TP_RATIO, slPct };
          }
        }
      }

      if (sig) {
        const riskUSD = PORTFOLIO * RISK_PCT;
        const qty     = Math.min(riskUSD / sig.slPct, MAX_TRADE) / sig.entry;
        open.push({ sym, side: sig.side, entry: sig.entry, sl: sig.sl, tp: sig.tp, qty });
      }
    }
  }

  const trades = wins + losses;
  const pf     = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const wr     = trades > 0 ? (wins / trades * 100).toFixed(1) : "0.0";
  const pnl    = equity - PORTFOLIO;
  const annRet = ((equity / PORTFOLIO) ** (1 / (MONTHS / 12)) - 1) * 100;
  const profitMonths = Object.values(monthly).filter(v => v > 0).length;
  const totalMonths  = Object.keys(monthly).length;

  return { trades, wr, pf, pnl, annRet, maxDD, monthly, profitMonths, totalMonths };
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n════════════════════════════════════════════════════════");
  console.log("  Donchian 時間框架比較（雙向，24個月，43幣）");
  console.log("════════════════════════════════════════════════════════\n");

  const totalDays = MONTHS * 31;
  const btcBullMap = await buildBtcBullMap(totalDays);

  // 每種 timeframe 下載一次，避免重複下載
  const cache = {};  // `${symbol}_${tf}` → bars[]

  const tfNeeded = [...new Set(VERSIONS.map(v => v.tf))];

  console.log("下載 K 線資料...");
  for (const tf of tfNeeded) {
    const barsPerDay = tf === "1d" ? 1 : tf === "4h" ? 6 : 24;
    const totalBars  = totalDays * barsPerDay + 800;  // 加 lookback buffer
    for (let si = 0; si < SYMBOLS.length; si++) {
      const sym = SYMBOLS[si];
      const key = `${sym}_${tf}`;
      process.stdout.write(`\r  [${tf}] ${si+1}/${SYMBOLS.length} ${sym}          `);
      try {
        cache[key] = await fetchKlines(sym, tf, totalBars);
      } catch(e) {
        cache[key] = [];
        process.stdout.write(` ERROR:${e.message}`);
      }
      await new Promise(r => setTimeout(r, 80));
    }
    console.log();
  }

  // 跑各版本回測
  const results = [];
  for (const ver of VERSIONS) {
    process.stdout.write(`\n  模擬 ${ver.name}...`);
    const allBars = {};
    for (const sym of SYMBOLS) {
      const key = `${sym}_${ver.tf}`;
      if (cache[key]?.length) allBars[sym] = cache[key];
    }
    const r = simulate(allBars, btcBullMap, ver.nH, ver.nL);
    results.push({ ...ver, ...r });
    console.log(` ${r.trades}筆 WR${r.wr}% PF${r.pf === Infinity ? "∞" : r.pf.toFixed(2)} +$${r.pnl.toFixed(0)}`);
  }

  // ─── 輸出比較表
  console.log("\n════════════════════════════════════════════════════════════════════");
  console.log("  比較表（24個月，43幣，雙向）");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("  版本           筆數   WR      PF      總損益    年化    最大回撤  盈利月");
  console.log("  " + "─".repeat(78));
  for (const r of results) {
    const pf  = r.pf === Infinity ? "  ∞  " : r.pf.toFixed(2).padStart(5);
    const pnl = (r.pnl >= 0 ? "+" : "") + "$" + Math.abs(r.pnl).toFixed(0);
    const ann = (r.annRet >= 0 ? "+" : "") + r.annRet.toFixed(1) + "%";
    const dd  = "$" + r.maxDD.toFixed(0);
    console.log(
      `  ${r.name}  ${String(r.trades).padStart(4)}  ${r.wr.padStart(5)}%  ${pf}  ${pnl.padStart(8)}  ${ann.padStart(7)}  ${dd.padStart(8)}  ${r.profitMonths}/${r.totalMonths}`
    );
  }
  console.log("  " + "─".repeat(78));

  // ─── 月度明細（每個版本）
  for (const r of results) {
    console.log(`\n  【${r.name}】${r.label}`);
    console.log("  月份      損益        累積");
    let cumul = 0;
    for (const [mon, pnl] of Object.entries(r.monthly).sort()) {
      cumul += pnl;
      const bar = pnl >= 0
        ? "🟢" + "▓".repeat(Math.min(15, Math.round(pnl / 100)))
        : "🔴" + "░".repeat(Math.min(15, Math.round(Math.abs(pnl) / 100)));
      console.log(`  ${mon}  ${(pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(0).padStart(6)}  ${(cumul >= 0 ? "+" : "") + "$" + cumul.toFixed(0).padStart(7)}  ${bar}`);
    }
  }

  console.log("\n════════════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("錯誤:", e.message); process.exit(1); });
