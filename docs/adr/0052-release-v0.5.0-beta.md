# ADR 0052: Phát hành v0.5.0-beta

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 11)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-107, D-15

## Quyết định

1. Cuối Prompt 11.8: `make release` (gói ký Ed25519), release notes `docs/releases/v0.5.0-beta.md` tổng hợp Phase 9–11 (multi-server, Docker/WordPress/Software, monitoring/alerts/notifications).
2. Merge `phase-11` vào `main` (`--no-ff`), tag local `v0.5.0-beta` trên `main`. Không push, không publish (D-51).
3. Release notes ghi rõ các tiêu chí còn **chờ VM** từ Phase 4–11.
