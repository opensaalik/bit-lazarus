#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLAR_NETWORKS_JSON="${POLAR_NETWORKS_JSON:-$HOME/.polar/networks/networks.json}"
APP_HOST="${APP_HOST:-127.0.0.1}"
APP_PORT="${APP_PORT:-3300}"
APP_BASE_URL="http://${APP_HOST}:${APP_PORT}"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/.tmp/polar-happy-path}"
FIXTURE_NAME="${FIXTURE_NAME:-fixture-a}"
REVEAL_ROUND="${REVEAL_ROUND:-70}"
REQUESTER_WALLET_ID="${REQUESTER_WALLET_ID:-requester-wallet}"
HUNTER_WALLET_ID="${HUNTER_WALLET_ID:-hunter-wallet}"
BITCOIN_RPC_URL="${BITCOIN_RPC_URL:-http://127.0.0.1:18443}"
BITCOIN_RPC_USER="${BITCOIN_RPC_USER:-polaruser}"
BITCOIN_RPC_PASSWORD="${BITCOIN_RPC_PASSWORD:-polarpass}"
CHANNEL_BOOTSTRAP_BLOCKS="${CHANNEL_BOOTSTRAP_BLOCKS:-6}"
REQUESTER_CHANNEL_SATS="${REQUESTER_CHANNEL_SATS:-40000}"
HUNTER_OUTBOUND_CHANNEL_SATS="${HUNTER_OUTBOUND_CHANNEL_SATS:-10000}"
LAZARUS_TO_HUNTER_CHANNEL_SATS="${LAZARUS_TO_HUNTER_CHANNEL_SATS:-35000}"
CHANNEL_OPEN_HEADROOM_SATS="${CHANNEL_OPEN_HEADROOM_SATS:-5000}"
MIN_CHANNEL_SATS="${MIN_CHANNEL_SATS:-20000}"
LND_PAYMENT_HTTP_TIMEOUT_SECONDS="${LND_PAYMENT_HTTP_TIMEOUT_SECONDS:-5}"
CHANNEL_BOOTSTRAP_REQUIRED=0

cleanup() {
  if [[ -n "${APP_PID:-}" ]]; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need_cmd jq
need_cmd curl
need_cmd node
need_cmd xxd
need_cmd base64

log_step() {
  printf '\n[step] %s\n' "$1"
}

json_get_network() {
  jq -r '.networks[] | select(.name == "bit-lazarus")' "$POLAR_NETWORKS_JSON"
}

json_get_node_field() {
  local network_json="$1"
  local node_name="$2"
  local field="$3"

  printf '%s' "$network_json" | jq -r --arg node_name "$node_name" --arg field "$field" '
    .nodes.lightning[] | select(.name == $node_name) | getpath($field | split("."))
  '
}

json_get_bitcoin_field() {
  local network_json="$1"
  local node_name="$2"
  local field="$3"

  printf '%s' "$network_json" | jq -r --arg node_name "$node_name" --arg field "$field" '
    .nodes.bitcoin[] | select(.name == $node_name) | getpath($field | split("."))
  '
}

hex_from_file() {
  xxd -p -c 999999 "$1" | tr -d '\n'
}

lnd_get() {
  local rest_port="$1"
  local macaroon_path="$2"
  local path="$3"

  curl -sS -k \
    -H "Grpc-Metadata-macaroon: $(hex_from_file "$macaroon_path")" \
    "https://127.0.0.1:${rest_port}${path}"
}

lnd_post() {
  local rest_port="$1"
  local macaroon_path="$2"
  local path="$3"
  local body="$4"

  curl -sS -k \
    -H "Grpc-Metadata-macaroon: $(hex_from_file "$macaroon_path")" \
    -H 'content-type: application/json' \
    -d "$body" \
    "https://127.0.0.1:${rest_port}${path}"
}

bitcoin_rpc() {
  local method="$1"
  local params_json="${2:-[]}"
  local payload
  local response
  local error_message

  payload="$(jq -nc --arg method "$method" --argjson params "$params_json" '{
    jsonrpc: "1.0",
    id: "polar-happy-path",
    method: $method,
    params: $params
  }')"
  response="$(curl -sS --user "${BITCOIN_RPC_USER}:${BITCOIN_RPC_PASSWORD}" -H 'content-type: text/plain;' --data-binary "$payload" "$BITCOIN_RPC_URL")"
  error_message="$(printf '%s' "$response" | jq -r '.error.message // empty')"

  if [[ -n "$error_message" ]]; then
    echo "bitcoin rpc '${method}' failed: ${error_message}" >&2
    printf '%s\n' "$response" >&2
    exit 1
  fi

  printf '%s' "$response"
}

payment_error_message() {
  local payment_response="$1"

  if [[ -z "$payment_response" ]]; then
    return 0
  fi

  printf '%s' "$payment_response" | jq -r '.payment_error // .error // .message // empty'
}

active_local_balance_for_peer() {
  local rest_port="$1"
  local macaroon_path="$2"
  local peer_pubkey="$3"

  lnd_get "$rest_port" "$macaroon_path" "/v1/channels" | jq -r --arg pubkey "$peer_pubkey" '
    [.channels[]? | select(.remote_pubkey == $pubkey and .active == true) | (.local_balance | tonumber)] | add // 0
  '
}

pending_local_balance_for_peer() {
  local rest_port="$1"
  local macaroon_path="$2"
  local peer_pubkey="$3"

  lnd_get "$rest_port" "$macaroon_path" "/v1/channels/pending" | jq -r --arg pubkey "$peer_pubkey" '
    [.pending_open_channels[]? | select(.channel.remote_node_pub == $pubkey) | (.channel.local_balance | tonumber)] | add // 0
  '
}

mine_blocks() {
  local block_count="$1"
  local address

  address="$(bitcoin_rpc "getnewaddress" '[]' | jq -r '.result')"
  [[ -n "$address" && "$address" != "null" ]] || {
    echo "failed to obtain a regtest mining address from bitcoind" >&2
    exit 1
  }

  bitcoin_rpc "generatetoaddress" "$(jq -nc --argjson blocks "$block_count" --arg address "$address" '[$blocks, $address]')" >/dev/null
}

wait_for_channel_local_balance() {
  local source_name="$1"
  local source_rest_port="$2"
  local source_macaroon="$3"
  local peer_pubkey="$4"
  local required_local_sats="$5"
  local attempts=90
  local current_local_balance

  while (( attempts > 0 )); do
    current_local_balance="$(active_local_balance_for_peer "$source_rest_port" "$source_macaroon" "$peer_pubkey")"
    if (( current_local_balance >= required_local_sats )); then
      return 0
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  echo "timed out waiting for ${source_name} to have ${required_local_sats} sats of active local balance towards ${peer_pubkey}" >&2
  printf '%s\n' "$(lnd_get "$source_rest_port" "$source_macaroon" "/v1/channels")" >&2
  printf '%s\n' "$(lnd_get "$source_rest_port" "$source_macaroon" "/v1/channels/pending")" >&2
  exit 1
}

ensure_channel() {
  local source_name="$1"
  local source_rest_port="$2"
  local source_macaroon="$3"
  local target_name="$4"
  local target_pubkey="$5"
  local target_p2p_port="$6"
  local required_local_sats="$7"
  local active_local_balance
  local pending_local_balance
  local connect_resp
  local connect_error
  local open_delta
  local open_resp
  local open_error

  active_local_balance="$(active_local_balance_for_peer "$source_rest_port" "$source_macaroon" "$target_pubkey")"
  pending_local_balance="$(pending_local_balance_for_peer "$source_rest_port" "$source_macaroon" "$target_pubkey")"

  if (( active_local_balance >= required_local_sats )); then
    printf '[info] %s already has %s sats of active outbound capacity to %s\n' "$source_name" "$active_local_balance" "$target_name"
    return 0
  fi

  CHANNEL_BOOTSTRAP_REQUIRED=1

  if (( active_local_balance + pending_local_balance >= required_local_sats )); then
    printf '[info] %s already has %s sats active and %s sats pending towards %s\n' "$source_name" "$active_local_balance" "$pending_local_balance" "$target_name"
    return 0
  fi

  connect_resp="$(lnd_post "$source_rest_port" "$source_macaroon" "/v1/peers" "$(jq -nc \
    --arg pubkey "$target_pubkey" \
    --arg host "127.0.0.1:${target_p2p_port}" \
    '{addr: {pubkey: $pubkey, host: $host}, perm: false}')")"
  connect_error="$(printf '%s' "$connect_resp" | jq -r '.error // .message // empty')"
  if [[ -n "$connect_error" && "$connect_error" != *"already connected"* ]]; then
    echo "failed to connect ${source_name} to ${target_name}: ${connect_error}" >&2
    printf '%s\n' "$connect_resp" >&2
    exit 1
  fi

  open_delta=$((required_local_sats - active_local_balance - pending_local_balance + CHANNEL_OPEN_HEADROOM_SATS))
  if (( open_delta < MIN_CHANNEL_SATS )); then
    open_delta="$MIN_CHANNEL_SATS"
  fi
  printf '[info] opening %s sat channel from %s to %s\n' "$open_delta" "$source_name" "$target_name"
  open_resp="$(lnd_post "$source_rest_port" "$source_macaroon" "/v1/channels" "$(jq -nc \
    --arg pubkey "$target_pubkey" \
    --arg amount "$open_delta" \
    '{
      node_pubkey_string: $pubkey,
      local_funding_amount: $amount,
      private: false,
      min_confs: 0,
      spend_unconfirmed: true
    }')")"
  open_error="$(printf '%s' "$open_resp" | jq -r '.error // .message // empty')"
  if [[ -n "$open_error" ]]; then
    echo "failed to open channel from ${source_name} to ${target_name}: ${open_error}" >&2
    printf '%s\n' "$open_resp" >&2
    exit 1
  fi
}

pay_hold_invoice() {
  local payer_rest_port="$1"
  local payer_macaroon="$2"
  local payment_request="$3"
  local body
  local response=""

  body="$(jq -nc --arg pr "$payment_request" '{payment_request: $pr}')"
  if ! response="$(curl -sS -k --max-time "$LND_PAYMENT_HTTP_TIMEOUT_SECONDS" \
    -H "Grpc-Metadata-macaroon: $(hex_from_file "$payer_macaroon")" \
    -H 'content-type: application/json' \
    -d "$body" \
    "https://127.0.0.1:${payer_rest_port}/v1/channels/transactions")"; then
    printf '%s' ""
    return 0
  fi

  printf '%s' "$response"
}

app_post() {
  local path="$1"
  local body="$2"
  local token="${3:-}"

  if [[ -n "$token" ]]; then
    curl -sS -H 'content-type: application/json' -H "authorization: Bearer ${token}" -d "$body" "${APP_BASE_URL}${path}"
  else
    curl -sS -H 'content-type: application/json' -d "$body" "${APP_BASE_URL}${path}"
  fi
}

app_get() {
  local path="$1"
  local token="${2:-}"

  if [[ -n "$token" ]]; then
    curl -sS -H "authorization: Bearer ${token}" "${APP_BASE_URL}${path}"
  else
    curl -sS "${APP_BASE_URL}${path}"
  fi
}

create_mock_session() {
  local wallet_id="$1"
  local display_name="$2"

  local challenge
  local challenge_id
  local challenge_message

  challenge="$(app_post "/auth/challenges" "{\"walletAddress\":\"${wallet_id}\"}")"
  challenge_id="$(printf '%s' "$challenge" | jq -r '.challenge.id')"
  challenge_message="$(printf '%s' "$challenge" | jq -r '.challenge.message')"

  app_post "/auth/verify" "$(jq -n \
    --arg challengeId "$challenge_id" \
    --arg walletAddress "$wallet_id" \
    --arg signature "mock-signature:${wallet_id}:${challenge_message}" \
    --arg displayName "$display_name" \
    '{challengeId: $challengeId, walletAddress: $walletAddress, signature: $signature, displayName: $displayName}')" \
    | jq -r '.session.token'
}

wait_for_app() {
  local attempts=40

  while (( attempts > 0 )); do
    if curl -sS "${APP_BASE_URL}/health" >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.25
    attempts=$((attempts - 1))
  done

  echo "app did not become healthy at ${APP_BASE_URL}" >&2
  exit 1
}

sync_bounty_until_status() {
  local bounty_id="$1"
  local token="$2"
  local expected_status="$3"
  local attempts="${4:-15}"
  local response=""
  local status=""

  while (( attempts > 0 )); do
    response="$(app_post "/bounties/${bounty_id}/sync-escrow" '{}' "$token")"
    status="$(printf '%s' "$response" | jq -r '.bounty.status')"
    if [[ "$status" == "$expected_status" ]]; then
      printf '%s' "$response"
      return 0
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  printf '%s' "$response"
  return 1
}

sync_bonds_until_state() {
  local contract_id="$1"
  local token="$2"
  local expected_state="$3"
  local attempts="${4:-15}"
  local response=""
  local state=""

  while (( attempts > 0 )); do
    response="$(app_post "/contracts/${contract_id}/sync-bonds" '{}' "$token")"
    state="$(printf '%s' "$response" | jq -r '.contract.state')"
    if [[ "$state" == "$expected_state" ]]; then
      printf '%s' "$response"
      return 0
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  printf '%s' "$response"
  return 1
}

log_step "loading Polar network metadata"
NETWORK_JSON="$(json_get_network)"
if [[ -z "$NETWORK_JSON" || "$NETWORK_JSON" == "null" ]]; then
  echo "Polar network 'bit-lazarus' not found in ${POLAR_NETWORKS_JSON}" >&2
  exit 1
fi

LAZARUS_REST_PORT="$(json_get_node_field "$NETWORK_JSON" lazarus ports.rest)"
LAZARUS_ADMIN_MACAROON="$(json_get_node_field "$NETWORK_JSON" lazarus paths.adminMacaroon)"
LAZARUS_P2P_PORT="$(json_get_node_field "$NETWORK_JSON" lazarus ports.p2p)"
REQUESTER_REST_PORT="$(json_get_node_field "$NETWORK_JSON" requester ports.rest)"
REQUESTER_ADMIN_MACAROON="$(json_get_node_field "$NETWORK_JSON" requester paths.adminMacaroon)"
REQUESTER_P2P_PORT="$(json_get_node_field "$NETWORK_JSON" requester ports.p2p)"
HUNTER_REST_PORT="$(json_get_node_field "$NETWORK_JSON" hunter ports.rest)"
HUNTER_ADMIN_MACAROON="$(json_get_node_field "$NETWORK_JSON" hunter paths.adminMacaroon)"
HUNTER_P2P_PORT="$(json_get_node_field "$NETWORK_JSON" hunter ports.p2p)"
BITCOIN_RPC_PORT="$(json_get_bitcoin_field "$NETWORK_JSON" backend1 ports.rpc)"

BITCOIN_RPC_URL="${BITCOIN_RPC_URL%/}"
if [[ "$BITCOIN_RPC_URL" == "http://127.0.0.1:18443" && -n "$BITCOIN_RPC_PORT" && "$BITCOIN_RPC_PORT" != "null" ]]; then
  BITCOIN_RPC_URL="http://127.0.0.1:${BITCOIN_RPC_PORT}"
fi

for path in "$LAZARUS_ADMIN_MACAROON" "$REQUESTER_ADMIN_MACAROON" "$HUNTER_ADMIN_MACAROON"; do
  [[ -f "$path" ]] || {
    echo "missing macaroon file: $path" >&2
    exit 1
  }
done

log_step "fetching Polar node identities"
REQUESTER_PUBKEY="$(lnd_get "$REQUESTER_REST_PORT" "$REQUESTER_ADMIN_MACAROON" "/v1/getinfo" | jq -r '.identity_pubkey')"
HUNTER_PUBKEY="$(lnd_get "$HUNTER_REST_PORT" "$HUNTER_ADMIN_MACAROON" "/v1/getinfo" | jq -r '.identity_pubkey')"
LAZARUS_PUBKEY="$(lnd_get "$LAZARUS_REST_PORT" "$LAZARUS_ADMIN_MACAROON" "/v1/getinfo" | jq -r '.identity_pubkey')"

for pubkey in "$REQUESTER_PUBKEY" "$HUNTER_PUBKEY" "$LAZARUS_PUBKEY"; do
  [[ -n "$pubkey" && "$pubkey" != "null" ]] || {
    echo "failed to determine one or more LND identity pubkeys" >&2
    exit 1
  }
done

log_step "ensuring funding channels into lazarus"
CHANNEL_BOOTSTRAP_REQUIRED=0
ensure_channel "requester" "$REQUESTER_REST_PORT" "$REQUESTER_ADMIN_MACAROON" "lazarus" "$LAZARUS_PUBKEY" "$LAZARUS_P2P_PORT" "$REQUESTER_CHANNEL_SATS"
ensure_channel "hunter" "$HUNTER_REST_PORT" "$HUNTER_ADMIN_MACAROON" "lazarus" "$LAZARUS_PUBKEY" "$LAZARUS_P2P_PORT" "$HUNTER_OUTBOUND_CHANNEL_SATS"

if (( CHANNEL_BOOTSTRAP_REQUIRED > 0 )); then
  log_step "mining ${CHANNEL_BOOTSTRAP_BLOCKS} regtest blocks to confirm channel funding"
  mine_blocks "$CHANNEL_BOOTSTRAP_BLOCKS"
  wait_for_channel_local_balance "requester" "$REQUESTER_REST_PORT" "$REQUESTER_ADMIN_MACAROON" "$LAZARUS_PUBKEY" "$REQUESTER_CHANNEL_SATS"
  wait_for_channel_local_balance "hunter" "$HUNTER_REST_PORT" "$HUNTER_ADMIN_MACAROON" "$LAZARUS_PUBKEY" "$HUNTER_OUTBOUND_CHANNEL_SATS"
fi

log_step "ensuring lazarus has outbound payout capacity to hunter"
CHANNEL_BOOTSTRAP_REQUIRED=0
ensure_channel "lazarus" "$LAZARUS_REST_PORT" "$LAZARUS_ADMIN_MACAROON" "hunter" "$HUNTER_PUBKEY" "$HUNTER_P2P_PORT" "$LAZARUS_TO_HUNTER_CHANNEL_SATS"

if (( CHANNEL_BOOTSTRAP_REQUIRED > 0 )); then
  log_step "mining ${CHANNEL_BOOTSTRAP_BLOCKS} regtest blocks to confirm payout channel funding"
  mine_blocks "$CHANNEL_BOOTSTRAP_BLOCKS"
  wait_for_channel_local_balance "lazarus" "$LAZARUS_REST_PORT" "$LAZARUS_ADMIN_MACAROON" "$HUNTER_PUBKEY" "$LAZARUS_TO_HUNTER_CHANNEL_SATS"
fi

log_step "starting Bit Lazarus against Polar node 'lazarus'"
mkdir -p "$DATA_DIR"
rm -rf "$DATA_DIR"/*

(
  cd "$ROOT_DIR"
  LIGHTNING_BACKEND=lnd-rest \
  LIGHTNING_LND_REST_URL="https://127.0.0.1:${LAZARUS_REST_PORT}" \
  LIGHTNING_LND_MACAROON_HEX="$(hex_from_file "$LAZARUS_ADMIN_MACAROON")" \
  LIGHTNING_LND_TLS_SKIP_VERIFY=1 \
  WALLET_AUTH_BACKEND=mock \
  HOST="$APP_HOST" \
  PORT="$APP_PORT" \
  DATA_DIR="$DATA_DIR" \
  node src/server.js
) >/tmp/bit-lazarus-polar-happy-path.log 2>&1 &
APP_PID=$!

wait_for_app

log_step "creating requester and hunter sessions"
REQUESTER_TOKEN="$(create_mock_session "$REQUESTER_WALLET_ID" "Requester")"
HUNTER_TOKEN="$(create_mock_session "$HUNTER_WALLET_ID" "Hunter")"

log_step "loading torrent fixture metadata"
TORRENT_PATH="$ROOT_DIR/manual-test/torrents/${FIXTURE_NAME}.torrent"
CONTENT_PATH="$ROOT_DIR/manual-test/content/${FIXTURE_NAME}.bin"
[[ -f "$TORRENT_PATH" ]] || { echo "missing torrent fixture: $TORRENT_PATH" >&2; exit 1; }
[[ -f "$CONTENT_PATH" ]] || { echo "missing content fixture: $CONTENT_PATH" >&2; exit 1; }

META_JSON="$(cd "$ROOT_DIR" && node --input-type=module -e "import { readFileSync } from 'node:fs'; import { parseTorrentMetadata } from './src/torrent-piece-proof.js'; console.log(JSON.stringify(parseTorrentMetadata(readFileSync(process.argv[1]))));" "$TORRENT_PATH")"
INFO_HASH="$(printf '%s' "$META_JSON" | jq -r '.infoHash')"
PIECE_HASH="$(printf '%s' "$META_JSON" | jq -r '.pieces[0]')"
TORRENT_B64="$(node -e "process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('base64'))" "$TORRENT_PATH")"

log_step "creating bounty"
BOUNTY_RESP="$(app_post "/bounties" "$(jq -n \
  --arg infoHash "$INFO_HASH" \
  --arg torrentB64 "$TORRENT_B64" \
  '{
    title: "Fixture recovery",
    description: "Automated Polar happy path",
    torrentInfoHash: $infoHash,
    torrentName: "fixture-a.torrent",
    rewardSats: 25000,
    missingPieces: [0],
    tags: ["polar", "script"],
    torrentFileBase64: $torrentB64
  }')" "$REQUESTER_TOKEN")"
BOUNTY_ID="$(printf '%s' "$BOUNTY_RESP" | jq -r '.bounty.id')"
BOUNTY_INVOICE="$(printf '%s' "$BOUNTY_RESP" | jq -r '.bounty.funding.paymentRequest')"
BOUNTY_PAYMENT_HASH="$(printf '%s' "$BOUNTY_RESP" | jq -r '.bounty.funding.paymentHashHex')"

log_step "funding bounty escrow from Polar node 'requester'"
PAY_RESP="$(pay_hold_invoice "$REQUESTER_REST_PORT" "$REQUESTER_ADMIN_MACAROON" "$BOUNTY_INVOICE")"
PAY_ERROR="$(payment_error_message "$PAY_RESP")"
if [[ -n "$PAY_ERROR" ]]; then
  printf '[info] bounty funding payment returned before settlement: %s\n' "$PAY_ERROR"
fi

SYNC_BOUNTY_RESP="$(sync_bounty_until_status "$BOUNTY_ID" "$REQUESTER_TOKEN" "OPEN")"
BOUNTY_STATUS="$(printf '%s' "$SYNC_BOUNTY_RESP" | jq -r '.bounty.status')"
[[ "$BOUNTY_STATUS" == "OPEN" ]] || { echo "bounty did not open after funding" >&2; printf '%s\n' "$SYNC_BOUNTY_RESP" >&2; exit 1; }

log_step "joining bounty as hunter and opening verification session"
app_post "/bounties/${BOUNTY_ID}/hunt" '{}' "$HUNTER_TOKEN" >/dev/null
SESSION_RESP="$(app_post "/bounties/${BOUNTY_ID}/verification-sessions" '{"pieceIndexes":[0]}' "$HUNTER_TOKEN")"
SESSION_ID="$(printf '%s' "$SESSION_RESP" | jq -r '.verificationSession.id')"

log_step "generating and submitting torrent proof"
PROOF_JSON="$(cd "$ROOT_DIR" && node --input-type=module -e "import { readFileSync } from 'node:fs'; import { generatePieceProof } from './src/torrent-piece-proof.js'; const proof = await generatePieceProof({ torrentBuffer: readFileSync(process.argv[1]), contentBuffer: readFileSync(process.argv[2]), pieceIndex: 0, revealRound: Number.parseInt(process.argv[3], 10) }); console.log(JSON.stringify(proof));" "$TORRENT_PATH" "$CONTENT_PATH" "$REVEAL_ROUND")"
app_post "/verification-sessions/${SESSION_ID}/proof" "$(jq -n \
  --arg infoHash "$INFO_HASH" \
  --argjson proof "$PROOF_JSON" \
  '{proofArtifacts: {torrentInfoHash: $infoHash, torrentName: "fixture-a.torrent", proofs: [$proof]}}')" \
  "$HUNTER_TOKEN" >/dev/null

log_step "recording payer-side proof verification"
app_post "/verification-sessions/${SESSION_ID}/verify" '{"verifiedPieceIndexes":[0],"verificationSummary":"polar script verification"}' "$REQUESTER_TOKEN" >/dev/null

log_step "creating contract and bond escrows"
CONTRACT_RESP="$(app_post "/verification-sessions/${SESSION_ID}/contracts" '{"pieceIndexes":[0]}' "$REQUESTER_TOKEN")"
CONTRACT_ID="$(printf '%s' "$CONTRACT_RESP" | jq -r '.contract.id')"
PAYER_BOND_INVOICE="$(printf '%s' "$CONTRACT_RESP" | jq -r '.payerBondEscrow.funding.paymentRequest')"
HUNTER_BOND_INVOICE="$(printf '%s' "$CONTRACT_RESP" | jq -r '.hunterBondEscrow.funding.paymentRequest')"

log_step "creating hunter payout invoice on Polar node 'hunter'"
HUNTER_PAYOUT_RESP="$(lnd_post "$HUNTER_REST_PORT" "$HUNTER_ADMIN_MACAROON" "/v1/invoices" '{"value":"25000","memo":"Bit Lazarus hunter payout"}')"
HUNTER_PAYOUT_PR="$(printf '%s' "$HUNTER_PAYOUT_RESP" | jq -r '.payment_request')"
[[ -n "$HUNTER_PAYOUT_PR" && "$HUNTER_PAYOUT_PR" != "null" ]] || { echo "failed to create hunter payout invoice" >&2; printf '%s\n' "$HUNTER_PAYOUT_RESP" >&2; exit 1; }

log_step "registering hunter payout invoice with contract"
app_post "/contracts/${CONTRACT_ID}/payout-invoice" "$(jq -n --arg pr "$HUNTER_PAYOUT_PR" '{paymentRequest: $pr}')" "$HUNTER_TOKEN" >/dev/null

log_step "funding both bonds from Polar"
PAYER_BOND_PAY_RESP="$(pay_hold_invoice "$REQUESTER_REST_PORT" "$REQUESTER_ADMIN_MACAROON" "$PAYER_BOND_INVOICE")"
PAYER_BOND_PAY_ERROR="$(payment_error_message "$PAYER_BOND_PAY_RESP")"
if [[ -n "$PAYER_BOND_PAY_ERROR" ]]; then
  printf '[info] payer bond funding returned before settlement: %s\n' "$PAYER_BOND_PAY_ERROR"
fi

HUNTER_BOND_PAY_RESP="$(pay_hold_invoice "$HUNTER_REST_PORT" "$HUNTER_ADMIN_MACAROON" "$HUNTER_BOND_INVOICE")"
HUNTER_BOND_PAY_ERROR="$(payment_error_message "$HUNTER_BOND_PAY_RESP")"
if [[ -n "$HUNTER_BOND_PAY_ERROR" ]]; then
  printf '[info] hunter bond funding returned before settlement: %s\n' "$HUNTER_BOND_PAY_ERROR"
fi

SYNC_BONDS_RESP="$(sync_bonds_until_state "$CONTRACT_ID" "$REQUESTER_TOKEN" "DELIVERY_IN_PROGRESS")"
CONTRACT_STATE="$(printf '%s' "$SYNC_BONDS_RESP" | jq -r '.contract.state')"
[[ "$CONTRACT_STATE" == "DELIVERY_IN_PROGRESS" ]] || { echo "contract did not enter DELIVERY_IN_PROGRESS" >&2; printf '%s\n' "$SYNC_BONDS_RESP" >&2; exit 1; }

log_step "submitting payer receipt"
RECEIPT_MSG="deliveryContractId=${CONTRACT_ID}|pieceIndex=0|pieceHash=${PIECE_HASH}"
RECEIPT_RESP="$(app_post "/contracts/${CONTRACT_ID}/receipts" "$(jq -n \
  --arg msg "$RECEIPT_MSG" \
  --arg wallet "$REQUESTER_WALLET_ID" \
  '{pieceIndex: 0, receiptMessage: $msg, receiptSignature: ("mock-signature:" + $wallet + ":" + $msg), receiptSignerWalletAddress: $wallet}')" \
  "$REQUESTER_TOKEN")"

FINAL_STATE="$(printf '%s' "$RECEIPT_RESP" | jq -r '.contract.state')"
FINAL_READINESS="$(printf '%s' "$RECEIPT_RESP" | jq -r '.contract.resolutionReadiness')"
[[ "$FINAL_STATE" == "RESOLVED_SUCCESS" ]] || { echo "contract did not resolve successfully" >&2; printf '%s\n' "$RECEIPT_RESP" >&2; exit 1; }
[[ "$FINAL_READINESS" == "RESOLVED" ]] || { echo "contract readiness did not resolve" >&2; printf '%s\n' "$RECEIPT_RESP" >&2; exit 1; }

log_step "verifying hunter payout invoice is settled"
HUNTER_R_HASH_B64="$(printf '%s' "$HUNTER_PAYOUT_RESP" | jq -r '.r_hash')"
HUNTER_INVOICE_RESP="$(curl -sS -k \
  -H "Grpc-Metadata-macaroon: $(hex_from_file "$HUNTER_ADMIN_MACAROON")" \
  "https://127.0.0.1:${HUNTER_REST_PORT}/v2/invoices/lookup?payment_hash=$(jq -nr --arg value "$HUNTER_R_HASH_B64" '$value|@uri')")"
HUNTER_INVOICE_STATE="$(printf '%s' "$HUNTER_INVOICE_RESP" | jq -r '.state')"
[[ "$HUNTER_INVOICE_STATE" == "SETTLED" ]] || { echo "hunter payout invoice was not settled" >&2; printf '%s\n' "$HUNTER_INVOICE_RESP" >&2; exit 1; }

printf '\n[summary] PASS\n'
printf '%s\n' "$(jq -n \
  --arg baseUrl "$APP_BASE_URL" \
  --arg bountyId "$BOUNTY_ID" \
  --arg contractId "$CONTRACT_ID" \
  --arg bountyInvoiceHash "$BOUNTY_PAYMENT_HASH" \
  --arg hunterInvoiceState "$HUNTER_INVOICE_STATE" \
  '{
    ok: true,
    appBaseUrl: $baseUrl,
    bountyId: $bountyId,
    contractId: $contractId,
    bountyPaymentHash: $bountyInvoiceHash,
    hunterInvoiceState: $hunterInvoiceState
  }')"
