/**
 * 一次性腳本：替 E 策略現有 4 筆倉位補掛止盈
 * 做法：取消現有純 SL algo 單 → 重新掛 OCO（SL + TP）
 * 執行：node fix_tp_e.js
 */
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

const OKX = {
  apiKey:     process.env.OKX_API_KEY,
  secretKey:  process.env.OKX_SECRET_KEY,
  passphrase: process.env.OKX_PASSPHRASE,
  baseUrl:    process.env.OKX_BASE_URL || "https://www.okx.com",
};

// 現有 4 筆開倉（從 /positions_e 抓取，2026-05-03）
const OPEN_POSITIONS = [
  { symbol: "ENSUSDT",  side: "long",  entryPrice: 6.09,    stopLoss: 6.037571428571429,   quantity: 16.420361247947454,  algoId: "3531084183475326976" },
  { symbol: "KITEUSDT", side: "long",  entryPrice: 0.1517,  stopLoss: 0.14913071428571428, quantity: 640.2557686961347,   algoId: "3531839425523486720" },
  { symbol: "XLMUSDT",  side: "short", entryPrice: 0.1596,  stopLoss: 0.16107,             quantity: 626.5664160401003,   algoId: "3532111655750864896" },
  { symbol: "AAVEUSDT", side: "short", entryPrice: 92.61,   stopLoss: 93.98728571428572,   quantity: 1.0797969981643452,  algoId: "3532111684238577664" },
];

function sign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", OKX.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}

async function okxPost(path, bodyObj) {
  const ts   = new Date().toISOString();
  const body = JSON.stringify(bodyObj);
  const res  = await fetch(`${OKX.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type":         "application/json",
      "OK-ACCESS-KEY":        OKX.apiKey,
      "OK-ACCESS-SIGN":       sign(ts, "POST", path, body),
      "OK-ACCESS-TIMESTAMP":  ts,
      "OK-ACCESS-PASSPHRASE": OKX.passphrase,
    },
    body,
  });
  return res.json();
}

async function okxGet(path) {
  const ts  = new Date().toISOString();
  const res = await fetch(`${OKX.baseUrl}${path}`, {
    headers: {
      "OK-ACCESS-KEY":        OKX.apiKey,
      "OK-ACCESS-SIGN":       sign(ts, "GET", path),
      "OK-ACCESS-TIMESTAMP":  ts,
      "OK-ACCESS-PASSPHRASE": OKX.passphrase,
    },
  });
  return res.json();
}

const _specCache = {};
async function fetchSpec(instId) {
  if (_specCache[instId]) return _specCache[instId];
  const d = await okxGet(`/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  const i = d.data?.[0];
  if (!i) throw new Error(`找不到合約規格: ${instId}`);
  const spec = { ctVal: parseFloat(i.ctVal), minSz: parseFloat(i.minSz), lotSz: parseFloat(i.lotSz) };
  _specCache[instId] = spec;
  return spec;
}

function floorToLot(value, lotSz) {
  const factor = Math.pow(10, Math.round(-Math.log10(lotSz)));
  return Math.floor(value * factor) / factor;
}

async function main() {
  console.log("🔧 開始為 E 策略 4 筆倉位補掛止盈...\n");

  for (const pos of OPEN_POSITIONS) {
    const instId      = pos.symbol.replace("USDT", "-USDT-SWAP");
    const risk        = Math.abs(pos.entryPrice - pos.stopLoss);
    const tp          = pos.side === "long"
      ? pos.entryPrice + risk * 2
      : pos.entryPrice - risk * 2;
    const exitSide    = pos.side === "long" ? "sell" : "buy";
    const exitPosSide = pos.side === "long" ? "long"  : "short";

    const spec = await fetchSpec(instId);
    const sz   = String(floorToLot(pos.quantity / spec.ctVal, spec.lotSz));

    console.log(`── ${pos.symbol} ${pos.side.toUpperCase()} ──`);
    console.log(`   進場 $${pos.entryPrice} | SL $${pos.stopLoss.toFixed(6)} | TP $${tp.toFixed(6)} | sz ${sz} 張`);

    // 1. 取消現有純 SL 單
    const cancel = await okxPost("/api/v5/trade/cancel-algos", [{ algoId: pos.algoId, instId }]);
    if (cancel.code === "0") {
      console.log(`   ✅ 舊 SL 單取消`);
    } else {
      console.log(`   ⚠️  取消舊單: ${cancel.msg}`);
    }

    // 2. 重新掛 OCO（SL + TP）
    const ocoRes = await okxPost("/api/v5/trade/order-algo", {
      instId,
      tdMode:          "isolated",
      side:            exitSide,
      posSide:         exitPosSide,
      ordType:         "oco",
      sz,
      slTriggerPx:     pos.stopLoss.toFixed(8),
      slOrdPx:         "-1",
      slTriggerPxType: "last",
      tpTriggerPx:     tp.toFixed(8),
      tpOrdPx:         "-1",
      tpTriggerPxType: "last",
    });

    if (ocoRes.code === "0") {
      console.log(`   ✅ OCO 掛單成功 — algoId: ${ocoRes.data?.[0]?.algoId}`);
    } else {
      console.log(`   ❌ OCO 失敗: ${ocoRes.msg}`);
    }

    console.log();
  }

  console.log("完成。請到 OKX 確認每筆倉位都有 SL + TP。");
}

main().catch(console.error);
