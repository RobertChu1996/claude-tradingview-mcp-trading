/**
 * 補救腳本：
 * 1. 查詢 OKX 實際開倉
 * 2. 若 OKX 有倉但本地已關閉（SUI）→ 市價平倉
 * 3. 查詢現有 algo 訂單，取消後重掛正確 SL+TP
 */
import crypto from "crypto";
import { readFileSync } from "fs";
import dotenv from "dotenv";
dotenv.config();

const OKX_BASE = process.env.OKX_BASE_URL || "https://www.okx.com";
const API_KEY   = process.env.OKX_API_KEY;
const SECRET    = process.env.OKX_SECRET_KEY;
const PASS      = process.env.OKX_PASSPHRASE;

function sign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", SECRET).update(`${ts}${method}${path}${body}`).digest("base64");
}

function headers(ts, method, path, body = "") {
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": API_KEY,
    "OK-ACCESS-SIGN": sign(ts, method, path, body),
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": PASS,
  };
}

async function get(path) {
  const ts  = new Date().toISOString();
  const res = await fetch(`${OKX_BASE}${path}`, { headers: headers(ts, "GET", path) });
  return res.json();
}

async function post(path, bodyObj) {
  const ts   = new Date().toISOString();
  const body = JSON.stringify(bodyObj);
  const res  = await fetch(`${OKX_BASE}${path}`, {
    method: "POST",
    headers: headers(ts, "POST", path, body),
    body,
  });
  return res.json();
}

// 本地已關閉但 OKX 可能還開著的幣種
const LOCAL_CLOSED = ["SUIUSDT"];
// 本地還開著、需要修正 TP 的持倉
const LOCAL_OPEN = JSON.parse(readFileSync("positions.json", "utf8")).open;

async function main() {
  // ─── Step 1：取得 OKX 實際持倉 ───────────────────────────────────────────
  console.log("=== OKX 實際倉位 ===");
  const posData = await get("/api/v5/account/positions?instType=SWAP");
  if (posData.code !== "0") { console.error("查詢失敗:", posData.msg); process.exit(1); }
  const okxPositions = posData.data;
  for (const p of okxPositions) {
    console.log(`  ${p.instId} ${p.posSide} ${p.pos} 張 | 進場均價 ${p.avgPx}`);
  }

  // ─── Step 2：平掉本地已關閉但 OKX 還在的倉 ──────────────────────────────
  for (const sym of LOCAL_CLOSED) {
    const instId = sym.replace("USDT", "-USDT-SWAP");
    const okxPos = okxPositions.find(p => p.instId === instId);
    if (!okxPos || parseFloat(okxPos.pos) === 0) {
      console.log(`\n[跳過] ${sym} OKX 已無倉`);
      continue;
    }
    const side      = okxPos.posSide === "long" ? "sell" : "buy";
    const posSide   = okxPos.posSide;
    const sz        = okxPos.pos;
    console.log(`\n[平倉] ${instId} ${posSide} ${sz} 張...`);
    const r = await post("/api/v5/trade/order", { instId, tdMode: "isolated", side, posSide, ordType: "market", sz });
    console.log(r.code === "0" ? `  ✅ 平倉成功 ordId:${r.data[0].ordId}` : `  ❌ 失敗: ${r.msg}`);
  }

  // ─── Step 3：取消舊 algo，重掛 SL+TP ────────────────────────────────────
  console.log("\n=== 現有 Algo 訂單 ===");
  const algoData = await get("/api/v5/trade/orders-algo-pending?ordType=conditional&instType=SWAP");
  if (algoData.code !== "0") { console.error("查詢 algo 失敗:", algoData.msg); process.exit(1); }
  const algoOrders = algoData.data || [];
  for (const a of algoOrders) {
    console.log(`  ${a.instId} algoId:${a.algoId} SL:${a.slTriggerPx} TP:${a.tpTriggerPx}`);
  }

  for (const pos of LOCAL_OPEN) {
    const instId  = pos.symbol.replace("USDT", "-USDT-SWAP");
    const okxPos  = okxPositions.find(p => p.instId === instId);
    if (!okxPos) { console.log(`\n[跳過] ${pos.symbol} OKX 無倉`); continue; }

    const entryPx = parseFloat(okxPos.avgPx) || pos.entryPrice;
    const sl      = pos.stopLoss;
    const tp      = pos.side === "long"
      ? entryPx + Math.abs(entryPx - sl) * 2
      : entryPx - Math.abs(entryPx - sl) * 2;

    console.log(`\n[修正] ${pos.symbol} ${pos.side.toUpperCase()}`);
    console.log(`  進場均價: ${entryPx.toFixed(6)}`);
    console.log(`  SL: ${sl.toFixed(6)}`);
    console.log(`  TP: ${tp.toFixed(6)} (2:1 R:R)`);

    // 取消該幣種的舊 algo
    const existing = algoOrders.filter(a => a.instId === instId);
    if (existing.length > 0) {
      const cancelBody = existing.map(a => ({ algoId: a.algoId, instId }));
      const cr = await post("/api/v5/trade/cancel-algos", cancelBody);
      console.log(cr.code === "0" ? `  ✅ 舊 algo 已取消 (${existing.length}筆)` : `  ⚠️ 取消失敗: ${cr.msg}`);
    }

    // 重新掛 SL+TP combo
    const exitSide    = pos.side === "long" ? "sell" : "buy";
    const exitPosSide = pos.side === "long" ? "long"  : "short";
    const sz          = okxPos.pos;
    const nr = await post("/api/v5/trade/order-algo", {
      instId, tdMode: "isolated",
      side: exitSide, posSide: exitPosSide,
      ordType: "conditional", sz,
      slTriggerPx: sl.toFixed(6), slOrdPx: "-1", slTriggerPxType: "last",
      tpTriggerPx: tp.toFixed(6), tpOrdPx: "-1", tpTriggerPxType: "last",
    });
    if (nr.code === "0") {
      console.log(`  ✅ SL+TP 掛單成功 algoId:${nr.data[0].algoId}`);
    } else {
      console.log(`  ❌ 掛單失敗: ${nr.msg}`);
    }
  }

  console.log("\n完成。");
}

main().catch(console.error);
