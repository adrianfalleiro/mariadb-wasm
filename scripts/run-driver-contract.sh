#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
contract_name="mariadb-wasm-contract-$$"
docker run --rm -d --name "$contract_name" -p 127.0.0.1::3306 -e MARIADB_ROOT_PASSWORD=contract mariadb:11.8.9 --performance-schema=OFF >/dev/null
trap 'docker rm -f "$contract_name" >/dev/null' EXIT
for attempt in $(seq 1 60); do
  if docker exec "$contract_name" mariadb-admin ping -h 127.0.0.1 -uroot -pcontract --silent >/dev/null 2>&1; then break; fi
  sleep 1
done
contract_port=$(docker port "$contract_name" 3306/tcp | sed 's/.*://')
MYSQL_CONTRACT_PORT="$contract_port" node --test package/test/native-contract.test.ts
