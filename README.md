# Bit Lazarus

Bit Lazarus is a hackathon demo for recovering a dead torrent with a bonded requester/hunter flow.

The demo flow is:

1. A requester creates a bounty from a real `.torrent` file.
2. The backend funds the requester escrow from a Polar-backed Lightning node.
3. A hunter joins the bounty.
4. The requester creates the delivery contract.
5. Both sides lock bonds.
6. The hunter seeds the recovered file over WebTorrent.
7. The requester downloads it, hashes it, and the backend settles if the SHA-256 matches.

## Requirements

- Node `>=20`
- [Polar](https://lightningpolar.com/)

## Polar Setup

This repo includes the Polar network export you should use for the demo:

- [bit-lazarus.polar.zip](/home/croxx/vixen/bit-lazarus/bit-lazarus.polar.zip)

In Polar:

1. Import `bit-lazarus.polar.zip`
2. Start the network
3. Load the nodes with funds before running the app

The imported network is expected to provide:

- `lazarus` for the app backend
- `requester` for requester-side demo payments
- `hunter` for hunter-side demo payments

## Install

```bash
npm install
```

## Run The Backend

Start the backend from the repo root:

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
POLAR_DEMO_BITCOIN_RPC_URL='http://127.0.0.1:18443' \
POLAR_DEMO_BITCOIN_RPC_USER='polaruser' \
POLAR_DEMO_BITCOIN_RPC_PASSWORD='polarpass' \
POLAR_DEMO_REQUESTER_BITCOIN_WALLET='requester-auth' \
POLAR_DEMO_HUNTER_BITCOIN_WALLET='hunter-auth' \
WEBTORRENT_TRACKER_HOST='127.0.0.1' \
WEBTORRENT_TRACKER_PORT='8001' \
WEBTORRENT_TRACKER_PUBLIC_HOST='127.0.0.1' \
WEBTORRENT_TRACKER_PUBLIC_PORT='8001' \
PORT=3000 \
DATA_DIR=./data/polar-demo \
npm start
```

The backend runs on:

- `http://127.0.0.1:3000`

## Run The Frontend

In a second terminal:

```bash
npm run frontend:dev
```

Open the Vite URL it prints, usually:

- `http://127.0.0.1:5173`

## Logging In

Use two separate browser profiles or one normal window plus one private window.

On the Home page:

- click `Login as Requester` in one browser profile
- click `Login as Hunter` in the other

Those buttons use the backend's Polar/Bitcoin Core integration, so no shell auth step or token copy/paste is needed.

## Demo Files

Use the bundled fixture files:

- [fixture-a.torrent](/home/croxx/vixen/bit-lazarus/manual-test/torrents/fixture-a.torrent)
- [fixture-a.bin](/home/croxx/vixen/bit-lazarus/manual-test/content/fixture-a.bin)

## Demo Flow

1. Log in as requester and hunter in separate browser profiles.
2. As requester, create a bounty with `fixture-a.torrent`.
3. As hunter, open the bounty and click `Hunt bounty`.
4. As requester, create the delivery contract.
5. As hunter, create and register the payout invoice.
6. Both sides pay their bond from Polar.
7. As hunter, load `fixture-a.bin`, commit the SHA-256, and start seeding.
8. As requester, start the download.
9. After the download completes, save the file with `Download recovered file`.

## Verification

```bash
npm test
npm run frontend:build
```
