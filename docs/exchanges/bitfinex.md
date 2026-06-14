# Bitfinex — API Key Setup

## What you'll get
- API Key
- API Secret
- No passphrase

---

## Steps

1. Log into your Bitfinex account at bitfinex.com
2. Click your profile icon (top right) → **API Keys** (or go via **Settings** → **API**)
3. Click **Create New Key**

### Fill in the details

- **Label** — give it a name like `claude-trading`
- **Key Capabilities — set these carefully:**

  Under **Read:**
  - **Account Fees** — ON ✓
  - **Wallets** — ON ✓
  - **Orders** — ON ✓
  - **Margin Information** — ON ✓ (if using margin)

  Under **Write:**
  - **Orders** — ON ✓
  - **Margin Trading** — ON ✓ (only if using margin)

  Everything under **Withdrawals** — **OFF** — never turn any of these on

- **IP Restriction** — ON ✓
  - Click **Add IP**
  - Google "what is my IP address", copy it, paste it in

4. Click **Generate API Key**
5. Complete the email confirmation Bitfinex sends you

### Copy your credentials

Your **API Key** and **API Secret** appear on screen after email confirmation.

> ⚠️ The API Secret is only shown once. Copy it immediately and save it somewhere safe.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_api_secret_here
BITGET_PASSPHRASE=
```

Leave `BITGET_PASSPHRASE` blank — Bitfinex doesn't use one.

Set `TRADE_MODE=spot`.

---

## Notes

- Bitfinex requires email confirmation before a new API key becomes active — check your inbox
- Bitfinex is one of the older exchanges and is particularly popular for BTC and ETH liquidity
- Not available to US residents
