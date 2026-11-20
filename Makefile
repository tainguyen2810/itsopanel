# ITSO Panel — Makefile gốc
# Target chưa hiện thực sẽ in thông báo kèm Prompt sẽ hiện thực.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

define todo
	@echo "[$(1)] chưa hiện thực — sẽ có ở Prompt $(2)"
endef

PNPX ?= npx -y

.PHONY: help structure docs-check db-schema db-erd db-verify contracts contracts-check contracts-docs setup dev test lint build codegen codegen-check check

help: ## Liệt kê các lệnh
	@echo "ITSO Panel — các lệnh make:"
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

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

setup: ## Cài dependency (web, api, agent)
	$(call todo,setup,1.5)

dev: ## Chạy web + api + mock agent
	$(call todo,dev,1.5)

test: ## Chạy toàn bộ test
	$(call todo,test,1.5)

lint: ## Chạy lint cho mọi phần
	$(call todo,lint,1.5)

build: ## Build web, api, agent
	$(call todo,build,1.5)

codegen: ## Sinh code từ contracts
	$(call todo,codegen,1.7)

codegen-check: ## Kiểm tra codegen không tạo diff
	$(call todo,codegen-check,1.7)

check: structure docs-check ## Chạy toàn bộ kiểm tra (đầy đủ ở Prompt 1.7)
	$(call todo,check (đầy đủ),1.7)
