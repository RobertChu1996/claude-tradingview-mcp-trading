# Strategy Extraction Prompt

Use this after scraping YouTube transcripts with Apify.
Paste the transcript content below, then run this prompt in Claude Code.

---

I have pasted the transcripts from one or more traders below.

Read through all of the content and extract their trading strategy in structured form.
Answer these questions precisely — do not invent details that aren't in the transcripts:

1. **What indicators do they use?**
   List each one, what settings they use (if mentioned), and what they use it for.

2. **What conditions define a valid entry?**
   What specific things need to be true before they would enter a trade?
   Separate LONG entries from SHORT entries.

3. **What makes them avoid a trade?**
   What red flags do they explicitly mention? What conditions make them stay out?

4. **How do they manage risk?**
   Position sizing, stop loss placement, take profit targets — what do they say?

5. **What timeframes do they use?**
   Higher timeframe for bias, lower timeframe for entry?

Once you have extracted the strategy, format it as a `rules.json` file using this exact structure:

```json
{
  "watchlist": ["BTCUSD"],
  "default_timeframe": "4H",
  "strategy": {
    "name": "[strategy name]",
    "sources": ["[trader name and handle]"]
  },
  "indicators": {
    "[indicator_key]": "[what it tells you]"
  },
  "bias_criteria": {
    "bullish": ["condition 1", "condition 2"],
    "bearish": ["condition 1", "condition 2"],
    "neutral": ["condition 1"]
  },
  "entry_rules": {
    "long": ["condition 1", "condition 2"],
    "short": ["condition 1", "condition 2"]
  },
  "exit_rules": ["rule 1", "rule 2"],
  "risk_rules": ["rule 1", "rule 2"],
  "notes": ""
}
```

Save the output as `rules.json` in the current directory.

---

[PASTE TRANSCRIPT CONTENT BELOW THIS LINE]
