# Skeleton. Targets get filled in as M1 progresses.

OTEL_DEMO_VERSION ?= 3.1.0
DEMO_DIR := infra/otel-demo/upstream
# Upstream .env defaults DEMO_VERSION=latest, which pulls images newer than the
# pinned compose config. Shell env beats --env-file, so this keeps them in sync.
export DEMO_VERSION := $(OTEL_DEMO_VERSION)
# Demo 3.x splits compose into layers. "Minimal" = core + observability stack,
# no Kafka. Mirrors upstream's own `make start-minimal`.
COMPOSE := cd $(DEMO_DIR) && docker compose \
	--env-file .env --env-file .env.override \
	-f compose.yaml -f compose.observability.yaml -f compose.extras.yaml

.PHONY: help demo-fetch up down status test lint eval

help:
	@echo "demo-fetch  clone the pinned OTel demo into $(DEMO_DIR)"
	@echo "up / down   start / stop the demo in minimal mode"
	@echo "status      show running containers"
	@echo "test        unit tests (TS + Python)"
	@echo "lint        linters (TS + Python)"
	@echo "eval        run the fault eval locally"

demo-fetch:
	@test "$(OTEL_DEMO_VERSION)" != "CHANGE_ME" || (echo "Set OTEL_DEMO_VERSION first"; exit 1)
	git clone --depth 1 --branch $(OTEL_DEMO_VERSION) \
		https://github.com/open-telemetry/opentelemetry-demo.git $(DEMO_DIR)

up:
	$(COMPOSE) up --force-recreate --remove-orphans --detach

down:
	$(COMPOSE) down

status:
	$(COMPOSE) ps

test:
	@echo "TODO: cd mcp-telemetry && pnpm test; cd agent && uv run pytest"

lint:
	@echo "TODO: cd mcp-telemetry && pnpm lint; cd agent && uv run ruff check ."

eval:
	@echo "TODO: uv run python -m evals.run (days 9-10)"
