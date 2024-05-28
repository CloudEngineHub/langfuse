#!/bin/bash

# Load environment variables
source ../../.env

# Construct the database URL
# DATABASE_URL="clickhouse://${CLICKHOUSE_MIGRATION_URL}?username=${CLICKHOUSE_USER}&password=${CLICKHOUSE_PASSWORD}&database=langfuse&x-multi-statement=true"
DATABASE_URL="clickhouse://${CLICKHOUSE_MIGRATION_URL}?username=${CLICKHOUSE_USER}&password=${CLICKHOUSE_PASSWORD}&database=langfuse&x-multi-statement=true&secure=true&skip_verify=true&x-migrations-table-engine=MergeTree"


# Execute the drop command
migrate -source file://clickhouse/migrations -database "$DATABASE_URL" down
