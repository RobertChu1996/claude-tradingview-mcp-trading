# MEXC — API Key Setup

## What you'll get
- API Key
- Secret Key
- No passphrase

---

## Steps

1. Log into your MEXC account at mexc.com
2. Click your profile icon (top right) → **API** (or go via **Settings** → **API Management**)
3. Click **Create API Key**

### Fill in the details

- **Remark** — give it a name like `claude-trading`
- **Permissions:**
  - **Read** — ON ✓
  - **Spot Trading** — ON ✓ (or Futures Trading if using futures)
  - **Withdrawals** — **OFF** — never turn this on
- **Bind IP** — ON ✓
  - Click **Add IP**
  - Google "what is my IP address", copy it, paste it in

4. Click **Save** and complete your security verification (email code + 2FA)

### Copy your credentials

Your **API Key** and **Secret Key** appear on the confirmation screen.

> ⚠️ The Secret Key is only shown once. Copy it immediately and save it somewhere safe.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_secret_key_here
BITGET_PASSPHRASE=
```

Leave `BITGET_PASSPHRASE` blank — MEXC doesn't use one.

Set `TRADE_MODE=spot` for spot trading or `TRADE_MODE=futures` for futures.

---

## Notes

- MEXC is known for listing new tokens early — popular for altcoin trading
- MEXC API keys do not expire by default
