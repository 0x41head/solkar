# SolKar

**Crypto tax for Indian Solana users.** Paste a wallet address and get your ITR **Schedule VDA** rows: every transfer valued in rupees, cost basis matched FIFO, and tax computed under Section 115BBH (30% + 4% cess). Runs entirely in your browser, so no wallet data leaves your device.

**Live app:** https://0x41head.github.io/solkar/ · **Sample report:** https://0x41head.github.io/solkar/?demo=1

**Videos:** [Pitch (2 min)](https://0x41head.github.io/solkar/media/solkar-pitch.mp4) · [Demo walkthrough](https://0x41head.github.io/solkar/media/solkar-demo.mp4)

## Why

India taxes every crypto transfer, including crypto-to-crypto swaps, at a flat 30%. Losses can't offset gains, and each transfer has to be reported in Schedule VDA with its acquisition date, cost and sale value in INR. Indian exchanges hand users a tax statement. DeFi users on Solana get nothing: they have hundreds of Jupiter swaps and a blank form. Global tools like Koinly charge in dollars, don't follow 115BBH's no-set-off rule by default, and require uploading your full history to their servers.

SolKar is free, open source, India-specific, and runs locally.

## How it works

1. **Read the chain.** It pulls the wallet's successful transactions over plain Solana JSON-RPC and computes the owner's net balance change per transaction. Network fees, token-account rent and wSOL wrapping are netted out. ([`src/parse.js`](src/parse.js))
2. **Classify.** A transaction where something left and something arrived is a trade (a taxable transfer of what left). Plain receipts and sends go to a review queue where the user marks each as a purchase or own-wallet move, income, a gift, or a sale.
3. **Value in INR.**
   - Stablecoins count as $1, and major tokens use Binance hourly prices.
   - USD converts at the ECB reference rate for that IST date.
   - For a crypto-to-crypto trade, the consideration is the value of what was received, so long-tail tokens are priced from the other side of the trade. ([`src/prices.js`](src/prices.js))
4. **Apply 115BBH.** Cost lots are matched FIFO and only the cost of acquisition is deducted. Each transfer's income stands alone: losses are shown but never offset gains. Tax is 30% plus 4% cess. ([`src/ledger.js`](src/ledger.js))
5. **Export.**
   - A CSV in Schedule VDA column order.
   - A detailed audit CSV linking each row to Solscan.
   - A printable report.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
npm test                      # ledger + parser unit tests (Node 20+)
```

No build step and no dependencies. For large wallets, add a free [Helius](https://dashboard.helius.dev/) RPC URL under *Advanced*, because the public RPC is heavily rate-limited. Fetched history is cached in IndexedDB, so re-runs only fetch new transactions.

## Limitations

- **Single wallet.** Coins bought on an exchange or in another wallet show as receipts. Mark them, or their cost is taken at the value when they arrived.
- **No-price tokens.** Tokens with no price on either side of a trade, such as an NFT-for-memecoin swap, are flagged and left out of totals.
- **LP positions, lending and perps** are treated by their net token flows, which may not match your CA's treatment.
- **TDS under §194S** isn't computed.

**Not tax advice.** Verify with a chartered accountant before filing.

## License

MIT
