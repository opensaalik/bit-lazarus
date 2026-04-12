# Bit Lazarus Demo

Bit Lazarus is a hackathon demo for recovering a dead torrent through a bonded requester/hunter workflow:

1. The requester creates a bounty from a real `.torrent` file.
2. The server funds the requester escrow from a Polar-backed Lightning node.
3. A hunter joins and the requester opens the bonded delivery contract.
4. The hunter seeds the recovered file over WebTorrent.
5. The requester downloads it, hashes it, and the backend settles the contract if the SHA-256 matches.

Everything in this repo is trimmed to that demo path.

## Requirements

- Node `>=20`
- A local Polar network with:
  - `lazarus` LND node for the app backend
  - `requester` LND node for requester demo payments
  - `hunter` LND node for hunter demo payments
  - Bitcoin Core RPC enabled on regtest

## Run

Start the backend:

```bash
WALLET_AUTH_BACKEND=bitcoin-cli \
BITCOIN_CLI_CHAIN=regtest \
BITCOIN_CLI_RPCCONNECT=127.0.0.1 \
BITCOIN_CLI_RPCPORT=18443 \
BITCOIN_CLI_RPCUSER=polaruser \
BITCOIN_CLI_RPCPASSWORD=polarpass \
LIGHTNING_BACKEND=lnd-rest \
LIGHTNING_LND_REST_URL='https://127.0.0.1:8084' \
LIGHTNING_LND_MACAROON_HEX="$(xxd -p -c 999999 ~/.polar/networks/1/volumes/lnd/lazarus/data/chain/bitcoin/regtest/admin.macaroon | tr -d '\n')" \
LIGHTNING_LND_TLS_SKIP_VERIFY=1 \
POLAR_DEMO_REQUESTER_LND_REST_URL='https://127.0.0.1:8085' \
POLAR_DEMO_REQUESTER_LND_MACAROON_HEX="$(xxd -p -c 999999 ~/.polar/networks/1/volumes/lnd/requester/data/chain/bitcoin/regtest/admin.macaroon | tr -d '\n')" \
POLAR_DEMO_REQUESTER_LND_TLS_SKIP_VERIFY=1 \
POLAR_DEMO_HUNTER_LND_REST_URL='https://127.0.0.1:8081' \
POLAR_DEMO_HUNTER_LND_MACAROON_HEX="$(xxd -p -c 999999 ~/.polar/networks/1/volumes/lnd/hunter/data/chain/bitcoin/regtest/admin.macaroon | tr -d '\n')" \
POLAR_DEMO_HUNTER_LND_TLS_SKIP_VERIFY=1 \
WEBTORRENT_TRACKER_HOST='127.0.0.1' \
WEBTORRENT_TRACKER_PORT='8001' \
WEBTORRENT_TRACKER_PUBLIC_HOST='127.0.0.1' \
WEBTORRENT_TRACKER_PUBLIC_PORT='8001' \
PORT=3000 \
DATA_DIR=./data/polar-demo \
npm start
```

Start the frontend in another terminal:

```bash
npm run frontend:dev
```

## Demo Auth

Use two browser profiles and log in directly from the Home page:

- `Login as Requester`
- `Login as Hunter`

Those buttons use the backend's Polar/Bitcoin Core integration to create the session for you.

The old shell helper still exists if you need it:

```bash
npm run auth:token -- --wallet requester-auth --display-name Requester
npm run auth:token -- --wallet hunter-auth --display-name Hunter
```

## Demo Files

Use these bundled fixtures:

- `manual-test/torrents/fixture-a.torrent`
- `manual-test/content/fixture-a.bin`

## Frontend Flow

1. Requester creates and funds the bounty.
2. Hunter joins the bounty.
3. Requester creates the delivery contract.
4. Hunter registers the payout invoice.
5. Both sides pay their bonds.
6. Hunter commits the file SHA-256 and starts seeding.
7. Requester downloads the file over WebTorrent.
8. The backend compares both SHA-256 hashes and settles the contract on match.

## Verification

```bash
npm test
npm run frontend:build
```
