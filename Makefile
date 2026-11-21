# ITSO Panel — Makefile gốc
# `make help` liệt kê lệnh; `make check` chạy toàn bộ kiểm tra như CI.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

PNPX ?= npx -y

.PHONY: help structure docs-check db-schema db-erd db-migrations db-verify contracts contracts-check contracts-docs setup dev services-up services-down test test-web test-api test-api-pg test-agent test-fuzz test-e2e test-e2e-real screenshots tokens tokens-check lint lint-web lint-api lint-agent no-exec build build-web build-agent build-demo dev-demo codegen codegen-check check units-check test-installer test-vm release

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

db-migrations: ## Sinh Laravel migration của Phase PHASE (mặc định 3) từ đặc tả schema
	@python3 database/tools/gen_migrations.py $(or $(PHASE),3)

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

dev: ## Chạy web + api + queue worker + itso-agent --sandbox (ITSO_DEV_AGENT=mock dùng mock; Ctrl+C để dừng)
	@bash scripts/dev.sh

services-up: ## (Tùy chọn) PostgreSQL 16 + Redis 7 bằng Docker, chỉ cho dev
	$(COMPOSE) up -d --wait

services-down: ## Tắt PostgreSQL/Redis dev (giữ volume)
	$(COMPOSE) stop

test: test-web test-api test-agent no-exec ## Chạy toàn bộ test (web, api, agent, chặn exec)

test-web:
	@cd apps/web && $(PNPM) test

test-api: ## Pest trên PostgreSQL 16 + Redis (D-59; đọc DB_HOST, DB_PORT, DB_DATABASE=itso_test, DB_USERNAME, DB_PASSWORD)
	@cd apps/api && php artisan config:clear --ansi >/dev/null && bash ../../scripts/pest-pg.sh

test-agent:
	@cd agent && go test -race ./...

test-e2e: ## Playwright: ảnh Design System, hành vi shell, axe-core (tự bật Vite)
	@cd apps/web && $(PNPM) e2e

test-e2e-real: ## Playwright trên stack thật + agent sandbox (cần `make dev` đang chạy + DemoSeeder, xem docs/runbooks/phase-3-demo.md)
	@cd apps/web && $(PNPM) exec playwright test -c playwright.real.config.ts --trace off

screenshots: ## Chụp lại ảnh Design System (docs/screenshots/design-system/), trang chính Phase 2 (docs/screenshots/phase-2/) và mockup Phase 6 (docs/screenshots/phase-6/)
	@cd apps/web && SCREENSHOT_DIR=$(CURDIR)/docs/screenshots/design-system SCREENSHOT_DIR_P2=$(CURDIR)/docs/screenshots/phase-2 SCREENSHOT_DIR_P6=$(CURDIR)/docs/screenshots/phase-6 $(PNPM) e2e

tokens: ## Sinh tokens.css từ design/tokens/tokens.json
	@node design/tools/gen-tokens.mjs

tokens-check: ## Kiểm tokens.css khớp nguồn và tương phản WCAG AA
	@node design/tools/gen-tokens.mjs --check
	@node design/tools/check-contrast.mjs

test-api-pg: test-api ## Tên cũ của test-api (từ Phase 3 Pest luôn chạy trên PostgreSQL)

test-fuzz: ## Fuzz parser envelope + validator của agent (FUZZTIME=30s cho envelope, 10s mỗi validator)
	@cd agent && go test -run='^$$' -fuzz=FuzzParse -fuzztime=$(FUZZTIME) ./internal/envelope
	@cd agent && go test -run='^$$' -fuzz=FuzzUsername -fuzztime=10s ./internal/validate
	@cd agent && go test -run='^$$' -fuzz=FuzzHostname -fuzztime=10s ./internal/validate
	@cd agent && go test -run='^$$' -fuzz=FuzzRenderVhost -fuzztime=10s ./internal/ops
	@cd agent && go test -run='^$$' -fuzz=FuzzRenderPool -fuzztime=10s ./internal/ops
	@cd agent && go test -run='^$$' -fuzz=FuzzCronToOnCalendar -fuzztime=10s ./internal/ops
	@cd agent && go test -run='^$$' -fuzz=FuzzParseSSHKey -fuzztime=10s ./internal/ops
	@cd agent && go test -run='^$$' -fuzz=FuzzCheckPath -fuzztime=10s ./internal/fsx

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

build: build-web build-agent ## Build web và mock agent

build-web:
	@cd apps/web && $(PNPM) build

build-demo: ## Build bản demo (API giả lập MSW) vào apps/web/dist-demo; kiểm build thường không có MSW
	@bash scripts/check-demo-build.sh

dev-demo: ## Chạy giao diện demo với API giả lập (không cần Laravel/agent)
	@cd apps/web && $(PNPM) dev:demo

build-agent:
	@cd agent && go build -o bin/itso-mock-agent ./cmd/itso-mock-agent

codegen: ## Sinh code từ contracts: TS (OpenAPI), Go structs + bản nhúng schema (agent-ops)
	@cd apps/web && $(PNPM) -s codegen
	@python3 contracts/tools/gen_go_types.py
	@cd agent && go generate ./internal/contracts && echo "✓ đồng bộ agent/internal/contracts/data"

codegen-check: ## Báo lỗi nếu file sinh lệch với contracts (không ghi file)
	@PNPM="$(PNPM)" bash scripts/codegen-check.sh

units-check: ## Kiểm unit systemd của panel + drop-in slice mẫu (systemd-analyze verify, đọc cả cảnh báo)
	@bash scripts/verify-units.sh

test-vm: ## Kiểm thử trên VM Ubuntu 24.04 (Multipass; RELEASE=build/release/<ver>, VM_ARGS="--keep …"), xem docs/runbooks/phase-4-vm-test.md
	@bash tests/vm/multipass.sh $(if $(RELEASE),--release $(RELEASE)) $(VM_ARGS)

test-installer: ## Test install.sh: chữ ký/sha sai, OS sai, không phải root → từ chối (bash thuần)
	@bash tests/installer/install_sh_test.sh

release: ## Đóng gói bản phát hành vào build/release/<ver> (VERSION=…; khóa ITSO_RELEASE_KEY hoặc khóa dev tạm)
	@bash scripts/release.sh

check: ## Toàn bộ pipeline local như CI, in bảng kết quả (exit ≠ 0 nếu có bước đỏ)
	@bash scripts/check-all.sh
