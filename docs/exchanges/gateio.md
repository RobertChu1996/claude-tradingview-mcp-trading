# Gate.io — API Key Setup

## What you'll get
- API Key
- Secret Key
- No passphrase

---

## Steps

1. Log into your Gate.io account at gate.io
2. Click your profile icon (top right) → **Account** → **API Management**
3. Click **Create API Key**

### Fill in the details

- **Remark** — give it a name like `claude-trading`
- **Password** — enter your account password to confirm
- **Permissions — set these carefully:**
  - **Read Only** — ON ✓
  - **Spot Trade** — ON ✓ (or Futures if using futures)
  - **Withdrawal** — **OFF** — never turn this on
  - **Sub-account transfer** — OFF
- **IP Whitelist** — ON ✓
  - Click **Add**
  - Google "what is my IP address", copy it, paste it in

4. Click **Confirm** and complete your email + 2FA verification

### Copy your credentials

Your **API Key** and **Secret Key** appear on screen.

> ⚠️ The Secret Key is only shown once. Copy it immediately and save it somewhere safe.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_secret_key_here
BITGET_PASSPHRASE=
```

Leave `BITGET_PASSPHRASE` blank — Gate.io doesn't use one.

Set `TRADE_MODE=spot` for spot trading or `TRADE_MODE=futures` for perpetuals.

---

## Notes

- Gate.io requires email verification every time you create a new API key
- Gate.io has a wide range of altcoins — one of the broadest selections available
