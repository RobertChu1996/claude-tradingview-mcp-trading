/**
 * 三策略對照執行
 * A: VWAP + RSI(3) + EMA(8)
 * B: DMC-Inspired (結構 + 量能 + K線)
 * C: BB Breakout + ATR Dynamic Stop
 */
import { execSync } from "child_process";

const run = (label, cmd) => {
  console.log("\n" + "━".repeat(57));
  console.log(`  ${label}`);
  console.log("━".repeat(57));
  try { execSync(cmd, { stdio: "inherit" }); }
  catch (e) { console.error(`執行失敗: ${e.message}`); }
};

run("策略 A：VWAP + RSI(3) + EMA(8)  [4H]", "node bot.js");
run("策略 B：DMC-Inspired             [15m]", "node bot_dmc.js");
run("策略 C：BB Breakout + ATR Stop   [1H]", "node bot_bb.js");
run("策略 D：Opening Range Breakout   [15m]", "node bot_orb.js");

console.log("\n✅ 四策略掃描完成\n");
