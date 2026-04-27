/**
 * Centralized file paths — all state files go to DATA_DIR (Railway Volume).
 * Set DATA_DIR=/data in Railway env vars. Defaults to "." locally.
 *
 * Rules files (rules_*.json) are seeded from git on first run if missing from DATA_DIR.
 */
import { join } from "path";
import { existsSync, copyFileSync } from "fs";

const D = process.env.DATA_DIR || ".";

// ── State files (must persist across deploys) ────────────────────────────────
export const LAST_RUN_FILE  = join(D, "last_optimized.txt");
export const PF_FILE        = join(D, "symbol_pf.json");
export const WATCHLIST_FILE = join(D, "watchlist_master.json");

// Per-strategy positions + logs
export const POSITIONS_FILE     = join(D, "positions.json");
export const POSITIONS_BB_FILE  = join(D, "positions_bb.json");
export const POSITIONS_DMC_FILE = join(D, "positions_dmc.json");
export const POSITIONS_ORB_FILE = join(D, "positions_orb.json");
export const POSITIONS_E_FILE   = join(D, "positions_e.json");
export const POSITIONS_K_FILE   = join(D, "positions_k.json");

export const STATS_FILE = join(D, "symbol_stats.json");

export const LOG_FILE     = join(D, "safety-check-log.json");
export const LOG_BB_FILE  = join(D, "safety-check-log-bb.json");
export const LOG_DMC_FILE = join(D, "safety-check-log-dmc.json");
export const LOG_ORB_FILE = join(D, "safety-check-log-orb.json");
export const LOG_E_FILE   = join(D, "safety-check-log-e.json");
export const LOG_K_FILE   = join(D, "safety-check-log-k.json");

export const CSV_FILE     = join(D, "trades.csv");
export const CSV_BB_FILE  = join(D, "trades_bb.csv");
export const CSV_DMC_FILE = join(D, "trades_dmc.csv");
export const CSV_ORB_FILE = join(D, "trades_orb.csv");
export const CSV_E_FILE   = join(D, "trades_e.csv");
export const CSV_K_FILE   = join(D, "trades_k.csv");

// ── Rules files (git seed → volume) ─────────────────────────────────────────
const RULES = ["rules.json", "rules_dmc.json", "rules_bb.json", "rules_orb.json", "rules_e.json", "rules_k.json"];

function seedRules() {
  if (D === ".") return; // local dev: use cwd directly
  for (const f of RULES) {
    const dest = join(D, f);
    if (existsSync(f)) {
      copyFileSync(f, dest); // always overwrite — rules are config, not state
      console.log(`[paths] Updated ${dest} from git`);
    }
  }
}
seedRules();

export const RULES_A_FILE   = existsSync(join(D, "rules.json"))     ? join(D, "rules.json")     : "rules.json";
export const RULES_B_FILE   = existsSync(join(D, "rules_dmc.json")) ? join(D, "rules_dmc.json") : "rules_dmc.json";
export const RULES_BB_FILE  = existsSync(join(D, "rules_bb.json"))  ? join(D, "rules_bb.json")  : "rules_bb.json";
export const RULES_ORB_FILE = existsSync(join(D, "rules_orb.json")) ? join(D, "rules_orb.json") : "rules_orb.json";
export const RULES_E_FILE   = existsSync(join(D, "rules_e.json"))   ? join(D, "rules_e.json")   : "rules_e.json";
export const RULES_K_FILE   = existsSync(join(D, "rules_k.json"))   ? join(D, "rules_k.json")   : "rules_k.json";
