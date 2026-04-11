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

On top of that identity layer, the app now supports torrent reseed bounties.
Users can post a bounty for missing torrent pieces, and other users can join as
bounty hunters who intend to seed the missing data.

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
- `GET /bounties` lists saved bounties.
- `POST /bounties` creates a new bounty as the authenticated user.
- `GET /bounties/:id` returns one bounty.
- `POST /bounties/:id/hunt` joins a bounty as a hunter.
- `POST /bounties/:id/sync-escrow` force-refreshes bounty funding state from its escrow.
- `GET /bounties/:id/verification-sessions` lists bounty verification sessions.
- `POST /bounties/:id/verification-sessions` opens a proof challenge session for a joined hunter.
- `GET /bounties/:id/contracts` lists delivery contracts for a bounty.
- `GET /verification-sessions/:id` returns a verification session.
- `POST /verification-sessions/:id/proof` submits hunter proof artifacts.
- `POST /verification-sessions/:id/verify` records payer-side proof verification.
- `POST /verification-sessions/:id/contracts` creates a delivery contract from a verified proof session.
- `GET /contracts/:id` returns a delivery contract.
- `POST /contracts/:id/bonds` records payer/hunter bond escrow references and funding status.
- `GET /contracts/:id/receipts` lists signed piece receipts.
- `POST /contracts/:id/receipts` records a payer-signed piece receipt.

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
npm run frontend:dev
npm run frontend:build
```

The node persists its state inside `DATA_DIR/`.

## Frontend

The frontend is a Vite + React app with a Three.js hero experience. In
development, run it with:

```bash
npm run frontend:dev
```

By default it proxies API requests to `http://127.0.0.1:3000`.

A production build is served by the backend at:

```text
/app
```

The frontend now includes a protocol workbench for the real torrent-piece proof
flow:

1. Connect a wallet.
2. Create or join a bounty.
3. Open a verification session on an `OPEN` bounty.
4. In the hunter console, load the real `.torrent` file and matching content
   file, then generate a proof for a challenged piece.
5. Submit the proof to the selected verification session.
6. In the payer console, load the same `.torrent` metadata, verify the proof
   locally in the browser, and record the verification.
7. Create a delivery contract, mark both bonds funded, and submit signed piece
   receipts as the payer.

The hunter console computes the SHA1 round-70 artifact from local piece data.
The payer console replays the remaining SHA1 rounds against the `.torrent`
piece hash before the session is marked verified.

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

## Bounties

Each bounty stores:

- `creatorUserId`: the wallet-linked user who posted it
- `title` and `description`: human-readable bounty details
- `torrentInfoHash`: the torrent identifier
- `torrentName`: optional torrent label
- `missingPieces`: piece indices still needed
- `rewardSats`: reward amount in sats
- `escrowId`: attached escrow record created with the bounty
- `escrowStatus`: mirrored escrow funding state
- `funding`: current funding payload from the linked escrow
- `hunters`: users who have joined the bounty
- `status`: currently `AWAITING_FUNDING`, `OPEN`, `COMPLETED`, or `CANCELED`
- `verificationMode`: currently `manual`

Create a bounty:

```bash
curl -X POST http://127.0.0.1:3000/bounties \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <session-token>' \
  -d '{
    "title":"Need the last pieces for a Linux ISO",
    "description":"Missing seeders for a partial torrent restore",
    "torrentInfoHash":"0123456789abcdef0123456789abcdef01234567",
    "torrentName":"linux-archive.iso.torrent",
    "rewardSats":25000,
    "missingPieces":[12,15,18],
    "tags":["linux","archive"]
  }'
```

Join a bounty as a hunter:

```bash
curl -X POST http://127.0.0.1:3000/bounties/<bounty-id>/hunt \
  -H 'authorization: Bearer <session-token>'
```

Each new bounty now creates an attached escrow automatically. New bounties start
as `AWAITING_FUNDING` and become `OPEN` when the linked escrow reports `FUNDED`.

The backend now runs an automatic background sync loop for bounty escrow state.
By default it polls every 30 seconds, and you can change that with:

```bash
BOUNTY_ESCROW_SYNC_INTERVAL_MS=30000
```

You can also force a refresh manually with:

```bash
curl -X POST http://127.0.0.1:3000/bounties/<bounty-id>/sync-escrow \
  -H 'authorization: Bearer <session-token>'
```

The current backend only saves bounty state, attached escrow metadata, and
hunter intent. Piece-proof verification, seeding verification, and fully
automatic completion syncing still need to be implemented later.

## Verification Protocol Backend

The backend now persists the first protocol slice for trust-minimized delivery:

- `verification sessions`: challenge windows for specific missing pieces
- `delivery contracts`: proof-verified contracts with payer and hunter bond state
- `piece receipts`: payer-signed delivery acknowledgements

These records are stored and state-tracked by the backend, but the proof
generation and torrent transfer are still intended to be client-side.

## WebTorrent

The frontend now includes a WebTorrent client boundary in
`frontend/src/lib/webtorrent-client.js` for the upcoming torrent metadata,
download, and seeding workflow. The protocol workbench already uses WebTorrent
to inspect a loaded `.torrent` file in the browser while proof generation and
verification stay client-side.

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
