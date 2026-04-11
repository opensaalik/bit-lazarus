# Bit Lazarus

Bit Lazarus is a lightweight peer-to-peer wallet node built with the Node.js
standard library. Each node keeps local wallet balances, records transfers in a
shared ledger, and gossips new transactions to configured peers over HTTP.

## API

- `POST /wallets` creates a wallet.
- `GET /wallets` lists wallets known by the node.
- `GET /wallets/:id` returns wallet details and balance.
- `POST /transactions` submits a transfer.
- `GET /transactions` lists known transfers.
- `POST /peers` registers a peer node.
- `GET /peers` lists configured peers.
- `GET /events` returns the replicated event log.

## Running A Node

```bash
PORT=3000 DATA_DIR=./data/node-a npm start
```

## Running Two Peers

Start node A:

```bash
PORT=3000 DATA_DIR=./data/node-a npm start
```

Start node B in a second shell:

```bash
PORT=3001 DATA_DIR=./data/node-b npm start
```

Connect node B to node A:

```bash
curl -X POST http://127.0.0.1:3001/peers \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:3000"}'
```

Create wallets and transfer funds on one node:

```bash
curl -X POST http://127.0.0.1:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"walletId":"alice","owner":"Alice","initialBalance":100}'

curl -X POST http://127.0.0.1:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"walletId":"bob","owner":"Bob","initialBalance":25}'

curl -X POST http://127.0.0.1:3000/transactions \
  -H 'content-type: application/json' \
  -d '{"from":"alice","to":"bob","amount":30}'
```

Check the replicated balances from node B:

```bash
curl http://127.0.0.1:3001/wallets/alice
curl http://127.0.0.1:3001/wallets/bob
```

## Development

```bash
npm test
npm start
```

The node persists its state to `DATA_DIR/state.json`.
