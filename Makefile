# ITSO Panel — Makefile gốc
# Target chưa hiện thực sẽ in thông báo kèm Prompt sẽ hiện thực.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

define todo
	@echo "[$(1)] chưa hiện thực — sẽ có ở Prompt $(2)"
endef

PNPX ?= npx -y

.PHONY: help structure docs-check db-schema db-erd db-verify contracts contracts-check contracts-docs setup dev services-up services-down test test-web test-api test-agent test-fuzz test-e2e tokens tokens-check lint lint-web lint-api lint-agent no-exec build codegen codegen-check check

help: ## Liệt kê các lệnh
	@echo "ITSO Panel — các lệnh make:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

structure: ## Kiểm tra cấu trúc repository
	@bash scripts/check-structure.sh

docs-check: ## Lint Markdown, kiểm tra link nội bộ và cú pháp Mermaid
	@$(PNPX) markdownlint-cli2@0.17.2
	@node scripts/check-links.mjs .
	@bash scripts/check-mermaid.sh

DBML_CLI ?= $(PNPX) -p @dbml/cli@3.9.0
DBML_RENDERER ?= $(PNPX) @softwaretechnik/dbml-renderer@1.0.31

db-schema: ## Sinh itso.dbml → itso.sql (DBML là nguồn sự thật)
	@python3 database/tools/gen_dbml.py
	@$(DBML_CLI) dbml2sql database/schema/itso.dbml --postgres -o database/schema/itso.sql
	@python3 database/tools/postprocess_sql.py database/schema/itso.sql

ERD_TMP ?= .cache/erd-dbml

db-erd: ## Vẽ ERD SVG (toàn bộ + từng nhóm) vào database/docs/erd/
	@mkdir -p database/docs/erd
	@$(DBML_RENDERER) -i database/schema/itso.dbml -o database/docs/erd/erd-full.svg
	@for g in $$(python3 database/tools/gen_dbml.py --erd-groups $(ERD_TMP)); do \
	  $(DBML_RENDERER) -i $(ERD_TMP)/$$g.dbml -o database/docs/erd/erd-$$g.svg || exit 1; \
	done

db-verify: ## Áp schema vào PostgreSQL 16 tạm và chạy test SQL
	@bash scripts/db-verify.sh

contracts: ## Sinh OpenAPI, agent-ops, test vectors từ contracts/tools
	@python3 contracts/tools/gen_openapi.py
	@python3 contracts/tools/gen_agent_ops.py
	@python3 contracts/tools/gen_vectors.py

contracts-check: ## Kiểm contracts: không diff, Redocly lint, ngữ nghĩa, ajv
	@bash scripts/check-contracts.sh

contracts-docs: ## Dựng HTML docs API vào docs/api/ (không commit)
	@cd contracts && for r in admin portal; do REDOCLY_TELEMETRY=off $(PNPX) @redocly/cli@2.71.0 build-docs openapi/itso-$$r-v1.yaml -o ../docs/api/itso-$$r-v1.html; done

PNPM ?= corepack pnpm
FUZZTIME ?= 30s
COMPOSE ?= docker compose -f docker-compose.dev.yml

setup: ## Cài dependency (web, api, agent), không cần Docker
	@bash scripts/setup.sh

dev: ## Chạy web + api + mock agent (Ctrl+C để dừng)
	@bash scripts/dev.sh

services-up: ## (Tùy chọn) PostgreSQL 16 + Redis 7 bằng Docker, chỉ cho dev
	$(COMPOSE) up -d --wait

services-down: ## Tắt PostgreSQL/Redis dev (giữ volume)
	$(COMPOSE) stop

test: test-web test-api test-agent no-exec ## Chạy toàn bộ test (web, api, agent, chặn exec)

test-web:
	@cd apps/web && $(PNPM) test

test-api:
	@cd apps/api && php artisan config:clear --ansi >/dev/null && php vendor/bin/pest

test-agent:
	@cd agent && go test -race ./...

test-e2e: ## Playwright: ảnh Design System, hành vi shell, axe-core (tự bật Vite)
	@cd apps/web && $(PNPM) e2e

tokens: ## Sinh tokens.css từ design/tokens/tokens.json
	@node design/tools/gen-tokens.mjs

tokens-check: ## Kiểm tokens.css khớp nguồn và tương phản WCAG AA
	@node design/tools/gen-tokens.mjs --check
	@node design/tools/check-contrast.mjs

test-fuzz: ## Fuzz parser envelope của agent (FUZZTIME=30s)
	@cd agent && go test -run='^$$' -fuzz=FuzzParse -fuzztime=$(FUZZTIME) ./internal/envelope

lint: lint-web lint-api lint-agent no-exec ## Chạy lint cho mọi phần

lint-web: tokens-check
	@cd apps/web && $(PNPM) lint

lint-api:
	@cd apps/api && php vendor/bin/pint --test && php vendor/bin/phpstan analyse --no-progress --memory-limit=1G

lint-agent:
	@cd agent && test -z "$$(gofmt -l .)" || { echo "gofmt cần chạy:"; gofmt -l .; exit 1; }
	@cd agent && go vet ./...

no-exec: ## Chặn lệnh hệ thống trong apps/api/app và agent/
	@bash scripts/check-no-exec.sh

build: ## Build web và mock agent
	@cd apps/web && $(PNPM) build
	@cd agent && go build -o bin/itso-mock-agent ./cmd/itso-mock-agent

codegen: ## Sinh code từ contracts
	$(call todo,codegen,1.7)

codegen-check: ## Kiểm tra codegen không tạo diff
	$(call todo,codegen-check,1.7)

check: structure docs-check ## Chạy toàn bộ kiểm tra (đầy đủ ở Prompt 1.7)
	$(call todo,check (đầy đủ),1.7)
