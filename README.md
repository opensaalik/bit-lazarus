# Bit Lazarus

Bit Lazarus is a lightweight peer-to-peer wallet node built with Express.js.
Each node keeps local wallet balances, records transfers in a shared ledger,
and gossips new transactions to configured peers over HTTP.

The project now also includes an escrow service scaffold backed by Lightning
hold invoices. The payment plumbing is in place for Bitcoin Lightning testnet,
while the final escrow contract rules can be added later.

The server now also supports wallet-linked user accounts. Instead of passwords,
clients obtain a challenge, sign it with their wallet, and exchange the signed
challenge for a session token.

## API

- `POST /wallets` creates a wallet.
- `GET /wallets` lists wallets known by the node.
- `GET /wallets/:id` returns wallet details and balance.
- `POST /transactions` submits a transfer.
- `GET /transactions` lists known transfers.
- `POST /peers` registers a peer node.
- `GET /peers` lists configured peers.
- `GET /events` returns the replicated event log.
- `POST /escrows` creates a Lightning-backed escrow and returns its hold invoice.
- `GET /escrows` lists escrow records.
- `GET /escrows/:id` returns an escrow record.
- `POST /escrows/:id/sync` refreshes invoice state from the Lightning backend.
- `POST /escrows/:id/release` settles a funded hold invoice.
- `POST /escrows/:id/cancel` cancels an unpaid or unresolved hold invoice.
- `POST /auth/challenges` issues a wallet login challenge.
- `POST /auth/verify` verifies a signed challenge and returns a session token.
- `POST /auth/logout` revokes the current session token.
- `GET /me` returns the authenticated user and current session.
- `GET /users/me` returns the authenticated user profile.
- `PATCH /users/me` updates the authenticated user profile.
- `GET /users/:id` returns a saved user profile.

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

The node persists its state inside `DATA_DIR/`.

## Wallet Auth

The current auth flow is wallet-first:

1. `POST /auth/challenges` with a wallet address.
2. Sign the returned `challenge.message` in the client wallet.
3. `POST /auth/verify` with the challenge ID, wallet address, and signature.
4. Use the returned session token as `Authorization: Bearer <token>`.

For local development, the default backend is `WALLET_AUTH_BACKEND=mock`. The
mock verifier accepts this signature format:

```text
mock-signature:<walletAddress>:<challenge.message>
```

Example:

```bash
curl -X POST http://127.0.0.1:3000/auth/challenges \
  -H 'content-type: application/json' \
  -d '{"walletAddress":"tb1qexamplebuyer"}'
```

Then verify:

```bash
curl -X POST http://127.0.0.1:3000/auth/verify \
  -H 'content-type: application/json' \
  -d '{
    "challengeId":"<challenge-id>",
    "walletAddress":"tb1qexamplebuyer",
    "signature":"mock-signature:tb1qexamplebuyer:<challenge.message>",
    "displayName":"Alice"
  }'
```

Escrow endpoints now require authentication and are scoped to participating
users. New escrows always use the authenticated user as `buyerId`.

The app now treats these wallet-linked users as the core project identity:
- `id`: stable internal user ID
- `walletAddress`: login wallet
- `displayName`: optional public profile name
- `bio`: optional profile text for bounty creators and hunters

To use a real Bitcoin verifier, switch the auth backend:

```bash
WALLET_AUTH_BACKEND=bitcoin-cli
BITCOIN_CLI_PATH=/usr/bin/bitcoin-cli
BITCOIN_CLI_DATADIR=/home/croxx/vixen/bit-lazarus/.bitcoin-testnet
BITCOIN_CLI_CHAIN=testnet4
PORT=3000 DATA_DIR=./data/node-a npm start
```

This backend now supports two real verification paths:

- Modern BIP-322 signatures for SegWit and Taproot-style wallets using `bip322-js`
- Legacy `signmessage` / `verifymessage` compatibility through `bitcoin-cli`

For legacy compatibility, it can call:

```bash
bitcoin-cli -datadir=... -testnet4 verifymessage <address> <signature> <message>
```

So the client wallet can now use either a modern BIP-322 signature flow or the
older Bitcoin Core compatible signed-message flow for the same address and
challenge text. The mock backend remains useful for local UI development.

## Escrow Setup

By default, the server uses a mock Lightning backend so local development and
tests work without an external node:

```bash
LIGHTNING_BACKEND=mock npm start
```

To use an LND node on Bitcoin Lightning testnet, configure the REST backend:

```bash
LIGHTNING_BACKEND=lnd-rest
LIGHTNING_LND_REST_URL=https://127.0.0.1:8080
LIGHTNING_LND_MACAROON_HEX=...
LIGHTNING_LND_TLS_SKIP_VERIFY=1
PORT=3000 DATA_DIR=./data/node-a npm start
```

`LIGHTNING_LND_TLS_SKIP_VERIFY=1` is only for local or self-signed testnet
setups. In a real deployment, trust the node certificate instead.

Example escrow creation:

```bash
curl -X POST http://127.0.0.1:3000/escrows \
  -H 'content-type: application/json' \
  -d '{
    "escrowId":"escrow-001",
    "buyerId":"alice",
    "sellerId":"bob",
    "amountSats":25000,
    "description":"example escrow on lightning testnet"
  }'
```

That response includes the Lightning hold invoice (`paymentRequest`) that the
buyer should pay on testnet. Once the invoice is accepted by the Lightning
node, call `POST /escrows/:id/sync` to refresh status to `FUNDED`. Release and
cancel are currently manual operator actions until the contract logic is
specified.
