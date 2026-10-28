#!/usr/bin/env bash
# Manual security verification for WorkSync-Server.
#
# Boots the server with dummy env vars (no MongoDB, no Google credentials)
# and checks the security boundary without touching any real data:
#   (a) the server boots and answers with JSON instead of crashing
#   (b) protected routes refuse requests without a valid x-admin-token
#   (c) POST /users rejects userType "admin"
#   (d) POST /process-payment is blocked when the guard is on
#   (e) list endpoints cap scans and reject operator-object / junk ids
#   (f) security headers are present on API responses
#   (g) rate limiting kicks in and health stays exempt
#   (h) an async handler rejection cannot kill the process
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

check_not() {
    # label, banned status, actual
    local label="$1" banned="$2" actual="$3"
    if [ "$actual" = "$banned" ]; then
        echo "FAIL  [$actual] $label"
        FAIL=$((FAIL + 1))
    else
        echo "PASS  [$actual] $label"
        PASS=$((PASS + 1))
    fi
}

status_of() {
    # $1 = method, $2 = path, $3 = optional x-admin-token, $4 = optional JSON body
    local args=(-s -g -o /dev/null -w '%{http_code}' -X "$1" --max-time 5)
    if [ -n "${3:-}" ]; then
        args+=(-H "x-admin-token: $3")
    fi
    if [ -n "${4:-}" ]; then
        args+=(-H 'Content-Type: application/json' -d "$4")
    fi
    curl "${args[@]}" "$BASE$2"
}

body_of() {
    # $1 = method, $2 = path, $3 = optional x-admin-token
    local args=(-s -g --max-time 5 -X "$1")
    if [ -n "${3:-}" ]; then
        args+=(-H "x-admin-token: $3")
    fi
    curl "${args[@]}" "$BASE$2"
}

start_server() {
    # $1 = ADMIN_TOKEN value (empty disables the admin routes)
    # remaining args = extra KEY=VAL environment pairs for this run
    local admin="$1"
    shift
    # env execs node, so $! is the server process itself.
    env PORT="$PORT" DB_USER=x DB_PW=y ADMIN_TOKEN="$admin" \
        GOOGLE_APPLICATION_CREDENTIALS= "$@" \
        node "$DIR/index.js" \
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

echo "== Run 0: helper unit checks (no server) =="
if node -e "
const assert = require('assert');
const app = require('$DIR/index.js');
assert.strictEqual(app.parseLimit(undefined), 200);
assert.strictEqual(app.parseLimit(''), 200);
assert.strictEqual(app.parseLimit('10'), 10);
assert.strictEqual(app.parseLimit('9999'), 200);
assert.strictEqual(app.parseLimit('0'), null);
assert.strictEqual(app.parseLimit('-1'), null);
assert.strictEqual(app.parseLimit('abc'), null);
assert.strictEqual(app.parseLimit({ '\$gt': '' }), null);
assert.strictEqual(app.parseLimit(['1']), null);
assert.strictEqual(app.isValidObjectId('507f1f77bcf86cd799439011'), true);
assert.strictEqual(app.isValidObjectId(undefined), false);
assert.strictEqual(app.isValidObjectId({ '\$gt': '' }), false);
assert.strictEqual(app.isValidObjectId('junk'), false);
assert.strictEqual(app.isValidObjectId('507f1f77bcf86cd79943901'), false);
assert.strictEqual(app.isValidObjectId(123), false);
let nextErr = null;
app.asyncHandler(async () => { throw new Error('boom'); })({}, {}, (e) => { nextErr = e; });
setImmediate(() => {
  assert.ok(nextErr && nextErr.message === 'boom');
  process.exit(0);
});
"; then
    echo "PASS  [ok] parseLimit / isValidObjectId / asyncHandler unit checks"
    PASS=$((PASS + 1))
else
    echo "FAIL  [err] parseLimit / isValidObjectId / asyncHandler unit checks"
    FAIL=$((FAIL + 1))
fi

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
check "(c) POST /users is open (signup) but still rejects admin without a token" \
    "400" "$(status_of POST /users '' '{"name":"n","email":"a@b.c","uid":"u1","userType":"admin"}')"

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
check "(c) POST /users is open (signup) but still rejects admin with a wrong token" \
    "400" "$(status_of POST /users wrong-token '{"name":"n","email":"a@b.c","uid":"u1","userType":"admin"}')"
check "(c) POST /users signup with valid employee payload passes input gate (503 db)" \
    "503" "$(status_of POST /users '' '{"name":"n","email":"a@b.c","uid":"u1"}')"
check "(c) POST /submit-query contact form is open (503 db, not 401)" \
    "503" "$(status_of POST /submit-query '' '{"heading":"h","designation":"d","details":"x","email":"a@b.c"}')"
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

# (e) ObjectId / operator-object injection: input gates run before the db gate,
# so these answer 400 even with MongoDB down.
check "(e) POST /make-hr/junk id is rejected" \
    "400" "$(status_of POST /make-hr/junk sekret-test-token)"
check "(e) POST /make-hr with operator-object id is rejected" \
    "400" "$(status_of POST /make-hr/%7B%22%24gt%22%3A%22%22%7D sekret-test-token)"
check "(e) POST /toggle-verification/junk id is rejected" \
    "400" "$(status_of POST /toggle-verification/junk sekret-test-token '{"isVerified":true}')"
check "(e) PUT /worksheet/junk id is rejected" \
    "400" "$(status_of PUT /worksheet/junk sekret-test-token '{"task":"t"}')"
check "(e) DELETE /worksheet/junk id is rejected" \
    "400" "$(status_of DELETE /worksheet/junk sekret-test-token)"
check "(e) PUT /approve-payment/junk id is rejected" \
    "400" "$(status_of PUT /approve-payment/junk sekret-test-token '{"status":"paid"}')"
check "(e) operator-object _id in process-payment entries is rejected" \
    "400" "$(status_of POST /process-payment sekret-test-token '{"email":"a@b.c","amount":1,"paidBy":"x","entries":[{"_id":{"$gt":""}}]}')"
check "(e) operator-object email in query string is rejected" \
    "400" "$(status_of GET '/queries?email[$gt]=' sekret-test-token)"
check "(e) bad limit query value is rejected" \
    "400" "$(status_of GET '/users?limit=abc' sekret-test-token)"
check "(e) zero limit is rejected" \
    "400" "$(status_of GET '/users?limit=0' sekret-test-token)"
check "(e) valid limit passes the input gate (503 only because MongoDB is down)" \
    "503" "$(status_of GET '/users?limit=5' sekret-test-token)"
traversal_code="$(status_of GET '/users/..%2F..%2F' sekret-test-token)"
check_not "(e) path-traversal uid must not answer 500" "500" "$traversal_code"
check_not "(e) path-traversal uid must not answer 200" "200" "$traversal_code"

# (f) security headers on every response
hdrs="$(curl -s -D - -o /dev/null --max-time 5 "$BASE/")"
check "(f) X-Content-Type-Options: nosniff" \
    "yes" "$(printf '%s' "$hdrs" | grep -qi '^X-Content-Type-Options: *nosniff' && echo yes || echo no)"
check "(f) Referrer-Policy: no-referrer" \
    "yes" "$(printf '%s' "$hdrs" | grep -qi '^Referrer-Policy: *no-referrer' && echo yes || echo no)"
check "(f) X-Frame-Options: DENY" \
    "yes" "$(printf '%s' "$hdrs" | grep -qi '^X-Frame-Options: *DENY' && echo yes || echo no)"
check "(f) Cache-Control: no-store" \
    "yes" "$(printf '%s' "$hdrs" | grep -qi '^Cache-Control: *no-store' && echo yes || echo no)"
check "(f) X-Request-Id is present" \
    "yes" "$(printf '%s' "$hdrs" | grep -qi '^X-Request-Id: *[0-9a-f-]' && echo yes || echo no)"
check "(f) CORS allows x-admin-token on preflight" \
    "yes" "$(curl -s -D - -o /dev/null --max-time 5 -X OPTIONS -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Headers: x-admin-token' "$BASE/users" | grep -qi 'Access-Control-Allow-Headers:.*x-admin-token' && echo yes || echo no)"

# (e, code) every collection-wide find() must carry a .limit()
limit_sites="$(grep -c '\.limit(' "$DIR/index.js" || true)"
if [ "$limit_sites" -ge 10 ]; then
    echo "PASS  [$limit_sites] (e) at least 10 find() calls carry .limit()"
    PASS=$((PASS + 1))
else
    echo "FAIL  [$limit_sites] (e) at least 10 find() calls carry .limit()"
    FAIL=$((FAIL + 1))
fi

check "GET / still answers with the guard on" \
    "503" "$(status_of GET /)"
check "server process is still alive after all probes" \
    "alive" "$(kill -0 "$SERVER_PID" 2>/dev/null && echo alive || echo dead)"

stop_server

echo "== Run 3: rate limiting (RATE_LIMIT_MAX=5) =="
start_server "sekret-test-token" RATE_LIMIT_MAX=5

rate_hits=0
first_code="$(status_of GET /users)"
for i in $(seq 1 12); do
    code="$(status_of GET /users)"
    if [ "$code" = "429" ]; then
        rate_hits=$((rate_hits + 1))
    fi
done
if [ "$rate_hits" -ge 1 ]; then
    echo "PASS  [$rate_hits/12] (g) rate limiter returns 429 after the budget"
    PASS=$((PASS + 1))
else
    echo "FAIL  [$rate_hits/12, first $first_code] (g) rate limiter returns 429 after the budget"
    FAIL=$((FAIL + 1))
fi

health_429=0
for i in $(seq 1 20); do
    code="$(status_of GET /)"
    if [ "$code" = "429" ]; then
        health_429=$((health_429 + 1))
    fi
done
check "(g) health endpoint is exempt from rate limiting" \
    "0" "$health_429"

check "server process is still alive after rate-limit probes" \
    "alive" "$(kill -0 "$SERVER_PID" 2>/dev/null && echo alive || echo dead)"

stop_server

echo "== Run 4: async handler rejection (VERIFY_ASYNC_ROUTE=1) =="
start_server "sekret-test-token" VERIFY_ASYNC_ROUTE=1

async_code="$(status_of GET /__verify/async-reject)"
check "(h) async rejection answers 500, not a crash" \
    "500" "$async_code"
async_body="$(body_of GET /__verify/async-reject)"
check "(h) async rejection body carries a requestId" \
    "yes" "$(printf '%s' "$async_body" | grep -q '"requestId"' && echo yes || echo no)"
check "(h) process survives the async rejection" \
    "503" "$(status_of GET /)"
check "(h) server process is still alive" \
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
