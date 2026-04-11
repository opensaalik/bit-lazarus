# Bit Lazarus

Bit Lazarus is a lightweight peer-to-peer wallet node built with the Node.js
standard library. Each node keeps local wallet balances, records transfers in a
shared ledger, and gossips new transactions to configured peers over HTTP.

## Planned API

- `POST /wallets` creates a wallet.
- `GET /wallets/:id` returns wallet details and balance.
- `POST /transactions` submits a transfer.
- `GET /transactions` lists known transfers.
- `POST /peers` registers a peer node.
- `GET /peers` lists configured peers.

## Development

```bash
npm test
npm start
```
