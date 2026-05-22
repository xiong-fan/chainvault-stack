#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS=()
LOG_DIR="$ROOT_DIR/.dev-logs"
mkdir -p "$LOG_DIR"

# 可选配置
SIGNER_PASSWORD="${SIGNER_PASSWORD:-12345678}"
FRONTEND_PORT="${FRONTEND_PORT:-3005}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-3000}"
SIGNER_PORT="${SIGNER_PORT:-3001}"
DB_GATEWAY_PORT="${DB_GATEWAY_PORT:-3003}"
RISK_CONTROL_PORT="${RISK_CONTROL_PORT:-3004}"

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

cleanup() {
  log "Stopping services..."
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

start_service() {
  local name="$1"
  local dir="$2"
  local cmd="$3"
  local log_file="$LOG_DIR/${name}.log"

  log "Starting ${name}..."
  mkdir -p "$(dirname "$log_file")"

  (cd "$dir" && eval "$cmd" > "$log_file" 2>&1 &)
  local pid=$!
  PIDS+=("$pid")
  log "${name} started with PID ${pid}, log: ${log_file}"
  echo "$pid"
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local timeout_sec="${3:-45}"
  local interval=2
  local elapsed=0

  log "Waiting for ${name} health: ${url}"
  while (( elapsed < timeout_sec )); do
    if curl -sS --max-time 2 "$url" >/dev/null 2>&1; then
      log "${name} is healthy"
      return 0
    fi
    sleep "$interval"
    ((elapsed += interval))
  done

  log "${name} health check timeout (${timeout_sec}s)"
  return 1
}

# 启动并等待 DB Gateway -> Risk -> Signer -> Wallet
DB_GATEWAY_DIR="$ROOT_DIR/db_gateway"
RISK_DIR="$ROOT_DIR/risk_control"
SIGNER_DIR="$ROOT_DIR/signer"
WALLET_DIR="$ROOT_DIR/wallet"
FRONTEND_DIR="$ROOT_DIR/user-frontend"

# 先判断端口占用（只做基础警告，不阻断）
for port in "$DB_GATEWAY_PORT" "$RISK_CONTROL_PORT" "$SIGNER_PORT" "$API_PORT" "$FRONTEND_PORT"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    log "WARN: port ${port} already in use"
  fi
done

PID_DB=$(start_service "db_gateway" "$DB_GATEWAY_DIR" "npm run dev")
export PID_DB
wait_for_health "db_gateway" "http://localhost:${DB_GATEWAY_PORT}/health" || {
  log "db_gateway failed to start; check ${LOG_DIR}/db_gateway.log"
  exit 1
}

PID_RISK=$(start_service "risk_control" "$RISK_DIR" "npm run dev")
export PID_RISK
wait_for_health "risk_control" "http://localhost:${RISK_CONTROL_PORT}/health" || {
  log "risk_control failed to start; check ${LOG_DIR}/risk_control.log"
  exit 1
}

# 建议：若 signer 首次失败可清理 signer.db 后重试（脚本不默认执行）
PID_SIGNER=$(start_service "signer" "$SIGNER_DIR" "printf '%s\\n' \"$SIGNER_PASSWORD\" | npm run dev")
export PID_SIGNER
wait_for_health "signer" "http://localhost:${SIGNER_PORT}/health" || {
  log "signer failed to start; check ${LOG_DIR}/signer.log"
  log "If this is password-verify related, try: rm -f \"$SIGNER_DIR/signer.db\" then rerun script"
  exit 1
}

PID_WALLET=$(start_service "wallet" "$WALLET_DIR" "npm run dev")
export PID_WALLET
wait_for_health "wallet" "http://localhost:${API_PORT}/health" || {
  log "wallet failed to start; check ${LOG_DIR}/wallet.log"
  exit 1
}

# 启动前端
PID_FRONTEND=$(start_service "user-frontend" "$FRONTEND_DIR" "npm run dev -- --hostname ${FRONTEND_HOST} --port ${FRONTEND_PORT}")
export PID_FRONTEND
wait_for_health "user-frontend" "http://localhost:${FRONTEND_PORT}" 30 || {
  log "user-frontend failed to start; check ${LOG_DIR}/user-frontend.log"
  exit 1
}

log "All services started."
log "Wallet API: http://localhost:${API_PORT}"
log "Signer:     http://localhost:${SIGNER_PORT}"
log "DB Gateway: http://localhost:${DB_GATEWAY_PORT}"
log "Risk Ctrl:  http://localhost:${RISK_CONTROL_PORT}"
log "Frontend:   http://${FRONTEND_HOST}:${FRONTEND_PORT}"
log "Stop all:   Ctrl+C"

wait
