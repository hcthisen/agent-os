#!/bin/bash
# Generate Supabase anon and service keys from JWT_SECRET
# Usage: ./generate-keys.sh <JWT_SECRET>
# These keys are JWTs signed with the JWT_SECRET containing the role claim.

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <JWT_SECRET>"
  exit 1
fi

JWT_SECRET="$1"

# Base64url encode (no padding)
b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# Create JWT with given payload
make_jwt() {
  local payload="$1"
  local header='{"alg":"HS256","typ":"JWT"}'
  local h=$(echo -n "$header" | b64url)
  local p=$(echo -n "$payload" | b64url)
  local sig=$(echo -n "$h.$p" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)
  echo "$h.$p.$sig"
}

ANON_KEY=$(make_jwt '{"role":"anon","iss":"supabase","iat":1700000000,"exp":2000000000}')
SERVICE_KEY=$(make_jwt '{"role":"service_role","iss":"supabase","iat":1700000000,"exp":2000000000}')

echo "SUPABASE_ANON_KEY=$ANON_KEY"
echo "SUPABASE_SERVICE_KEY=$SERVICE_KEY"
