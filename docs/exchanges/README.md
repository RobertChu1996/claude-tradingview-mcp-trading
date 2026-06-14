# API Key Setup — Top 10 Exchanges

Step-by-step instructions for creating an API key on each exchange.

**Two rules that apply to every exchange:**
- **Withdrawals: OFF** — your bot never needs this permission
- **IP whitelist: ON** — your key only works from your machine

Pick your exchange:

1. [Binance](binance.md)
2. [BitGet](bitget.md)
3. [Bybit](bybit.md)
4. [OKX](okx.md)
5. [Coinbase Advanced](coinbase.md)
6. [Kraken](kraken.md)
7. [KuCoin](kucoin.md)
8. [Gate.io](gateio.md)
9. [MEXC](mexc.md)
10. [Bitfinex](bitfinex.md)

Once you have your key, secret, and passphrase (not all exchanges use a passphrase — check your guide), paste them into your `.env` file:

```
BITGET_API_KEY=your_key_here
BITGET_SECRET_KEY=your_secret_here
BITGET_PASSPHRASE=your_passphrase_here
```

Then update `TRADE_MODE` in `.env` to match your exchange account type:
- `spot` — for regular spot trading accounts
- `futures` — for perpetuals / futures accounts
