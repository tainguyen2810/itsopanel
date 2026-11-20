# ITSO Panel — Makefile gốc
# Target chưa hiện thực sẽ in thông báo kèm Prompt sẽ hiện thực.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

define todo
	@echo "[$(1)] chưa hiện thực — sẽ có ở Prompt $(2)"
endef

PNPX ?= npx -y

.PHONY: help structure docs-check setup dev test lint build codegen codegen-check check

help: ## Liệt kê các lệnh
	@echo "ITSO Panel — các lệnh make:"
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

structure: ## Kiểm tra cấu trúc repository
	@bash scripts/check-structure.sh

docs-check: ## Lint Markdown, kiểm tra link nội bộ và cú pháp Mermaid
	@$(PNPX) markdownlint-cli2@0.17.2
	@node scripts/check-links.mjs .
	@bash scripts/check-mermaid.sh

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
