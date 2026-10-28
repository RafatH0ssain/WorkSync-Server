#!/usr/bin/env bash
# Manual security verification for WorkSync-Server.
#
# Boots the server with dummy env vars (no MongoDB, no Google credentials)
# and checks the security boundary without touching any real data:
#   (a) the server boots and answers with JSON instead of crashing
#   (b) protected routes refuse requests without a valid x-admin-token
#   (c) POST /users rejects userType "admin"
#   (d) POST /process-payment is blocked when the guard is on
#
# Usage: bash verify-security.sh   (or: npm test)

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${VERIFY_PORT:-5099}"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0
SERVER_PID=""

check() {
    local label="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        echo "PASS  [$actual] $label"
        PASS=$((PASS + 1))
    else
        echo "FAIL  [$actual, wanted $expected] $label"
        FAIL=$((FAIL + 1))
    fi
}

status_of() {
    # $1 = method, $2 = path, $3 = optional x-admin-token, $4 = optional JSON body
    local args=(-s -o /dev/null -w '%{http_code}' -X "$1" --max-time 5)
    if [ -n "${3:-}" ]; then
        args+=(-H "x-admin-token: $3")
    fi
    if [ -n "${4:-}" ]; then
        args+=(-H 'Content-Type: application/json' -d "$4")
    fi
    curl "${args[@]}" "$BASE$2"
}

start_server() {
    # $1 = ADMIN_TOKEN value (empty disables the admin routes)
    # env execs node, so $! is the server process itself.
    env PORT="$PORT" DB_USER=x DB_PW=y ADMIN_TOKEN="$1" \
        GOOGLE_APPLICATION_CREDENTIALS= node "$DIR/index.js" \
        >"/tmp/worksync-verify-$$.log" 2>&1 &
    SERVER_PID=$!
    local i
    for i in $(seq 1 50); do
        if curl -s -o /dev/null --max-time 2 "$BASE/"; then
            return 0
        fi
        sleep 0.2
    done
    echo "FAIL  server did not boot; log follows"
    cat "/tmp/worksync-verify-$$.log"
    exit 1
}

stop_server() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null
        wait "$SERVER_PID" 2>/dev/null
        SERVER_PID=""
    fi
}

trap stop_server EXIT

echo "== Run 1: ADMIN_TOKEN unset (safe default) =="
start_server ""

check "(a) GET / answers while MongoDB is down" \
    "503" "$(status_of GET /)"
check "(a) GET / body is JSON" \
    "json" "$(curl -s --max-time 5 "$BASE/" | grep -q '"status"' && echo json || echo not-json)"
check "(b) GET /users is disabled without ADMIN_TOKEN" \
    "503" "$(status_of GET /users)"
check "(d) POST /process-payment is blocked without ADMIN_TOKEN" \
    "503" "$(status_of POST /process-payment '' '{"email":"a@b.c","amount":1,"paidBy":"x","entries":[{"_id":"507f1f77bcf86cd799439011"}]}')"
check "(c) POST /users is disabled without ADMIN_TOKEN" \
    "503" "$(status_of POST /users '' '{"name":"n","email":"a@b.c","uid":"u1","userType":"admin"}')"

stop_server

echo "== Run 2: ADMIN_TOKEN set (guard on) =="
start_server "sekret-test-token"

check "(b) GET /users without token is rejected" \
    "401" "$(status_of GET /users)"
check "(b) GET /users with wrong token is rejected" \
    "401" "$(status_of GET /users wrong-token)"
check "(b) GET /users with the token passes auth (503 only because MongoDB is down)" \
    "503" "$(status_of GET /users sekret-test-token)"
check "(c) POST /users with userType admin is rejected" \
    "400" "$(status_of POST /users sekret-test-token '{"name":"n","email":"a@b.c","uid":"u1","userType":"admin"}')"
check "(c) POST /users with userType hr is rejected" \
    "400" "$(status_of POST /users sekret-test-token '{"name":"n","email":"a@b.c","uid":"u1","userType":"hr"}')"
check "(c) POST /users without token is rejected" \
    "401" "$(status_of POST /users '' '{"name":"n","email":"a@b.c","uid":"u1","userType":"admin"}')"
check "(c) NoSQL operator object in email is rejected" \
    "400" "$(status_of POST /users sekret-test-token '{"name":"n","email":{"$gt":""},"uid":"u1"}')"
check "(d) POST /process-payment without token is rejected" \
    "401" "$(status_of POST /process-payment '' '{"email":"a@b.c","amount":1,"paidBy":"x","entries":[{"_id":"507f1f77bcf86cd799439011"}]}')"
check "(d) POST /process-payment with wrong token is rejected" \
    "401" "$(status_of POST /process-payment wrong-token '{"email":"a@b.c","amount":1,"paidBy":"x","entries":[{"_id":"507f1f77bcf86cd799439011"}]}')"
# With MongoDB down this answer is 503 (db gate) rather than 400 (input gate);
# either way the request must never be accepted.
junk_code="$(status_of POST /process-payment sekret-test-token '{"email":"a@b.c","amount":1,"paidBy":"x","entries":[{"_id":"junk"}]}')"
case "$junk_code" in
    2*) echo "FAIL  [$junk_code] (d) POST /process-payment with junk entry ids must be rejected"
        FAIL=$((FAIL + 1)) ;;
    *)  echo "PASS  [$junk_code] (d) POST /process-payment with junk entry ids is rejected"
        PASS=$((PASS + 1)) ;;
esac
check "GET / still answers with the guard on" \
    "503" "$(status_of GET /)"
check "server process is still alive after all probes" \
    "alive" "$(kill -0 "$SERVER_PID" 2>/dev/null && echo alive || echo dead)"

stop_server

echo
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    echo "Server log: /tmp/worksync-verify-$$.log"
    exit 1
fi
rm -f "/tmp/worksync-verify-$$.log"
exit 0
