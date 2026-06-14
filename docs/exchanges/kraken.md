# Kraken — API Key Setup

## What you'll get
- API Key
- Private Key (this is your secret)
- No passphrase

---

## Steps

1. Log into your Kraken account at kraken.com
2. Click your name (top right) → **Security** → **API**
3. Click **Add key**

### Fill in the details

- **Key description** — something like `claude-trading`
- **Key permissions — set these carefully:**
  - Under **Query:**
    - **Query Funds** — ON ✓
    - **Query open orders & trades** — ON ✓
    - **Query closed orders & trades** — ON ✓
  - Under **Orders and trades:**
    - **Create & modify orders** — ON ✓
    - **Cancel/close orders** — ON ✓
  - Under **Funding:**
    - Everything — **OFF** — no deposit, no withdrawal permissions
- **Nonce window** — leave at default
- **Key expiration** — optional, leave blank for no expiry

4. Click **Generate Key**

### Copy your credentials

Your **API Key** and **Private Key** appear on screen.

> ⚠️ The Private Key is only shown once. Copy it immediately.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_private_key_here
BITGET_PASSPHRASE=
```

Leave `BITGET_PASSPHRASE` blank — Kraken doesn't use one.

Set `TRADE_MODE=spot`.

---

## Notes

- Kraken has very granular permission controls — only enable exactly what you need
- Kraken Pro (kraken.com/u/trade) offers lower fees and is the interface most traders use
- Kraken does not currently support perpetuals for all regions
