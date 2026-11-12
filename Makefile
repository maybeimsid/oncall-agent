# Skeleton. Targets get filled in as M1 progresses.
# TODO(sid): pin OTEL_DEMO_VERSION to the latest release tag on day 1
#   (https://github.com/open-telemetry/opentelemetry-demo/releases)

OTEL_DEMO_VERSION ?= 3.1.0
DEMO_DIR := infra/otel-demo/upstream
COMPOSE := docker compose -f $(DEMO_DIR)/docker-compose.minimal.yml

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
