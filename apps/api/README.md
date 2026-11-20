# apps/api

Backend Laravel 13 (PHP 8.3+) REST API theo `contracts/openapi` (`/api/v1/admin/*`, `/api/v1/portal/*`). **Không bao giờ chạy lệnh hệ thống**: mọi thao tác Linux đi qua Go Agent bằng typed operation (`app/Infrastructure/Agent/AgentClient.php`).

## Đã có (Prompt 1.5)

| Route | operationId | Ghi chú |
|---|---|---|
| `GET /api/v1/system/health` | `getHealth` | Public, dùng chung admin/portal |
| `GET /api/v1/admin/system/version` | `getSystemVersion` | Chỉ `APP_ENV=local/testing` tới khi có auth (Phase 3) |
| `GET /api/v1/admin/system/status` | `getSystemStatus` | PostgreSQL, Redis, ping agent; như trên |

- Lỗi dưới `/api/*` luôn là RFC 9457 `application/problem+json` (`app/Support/ProblemRenderer.php`), có `code`, `request_id`, `instance`.
- Header `X-Request-Id` cho mọi response.
- `app/Domain/Hosting/ProvisioningService.php`: interface rỗng, docblock D-49 (hiện thực ở Phase 3).
- Chưa có migration: schema nguồn là `database/schema/itso.sql`; kế hoạch migration ở `database/docs/migration-plan.md`.

## Lệnh

| Việc | Lệnh |
|---|---|
| Test (Pest, kiểm response theo OpenAPI) | `php vendor/bin/pest` hoặc `make test-api` |
| Lint (Pint + Larastan level 8 + rule cấm lệnh hệ thống) | `make lint-api` |
| Chặn exec bằng grep | `make no-exec` |

Rule PHPStan `tools/phpstan/NoSystemCommandRule.php` cấm `exec`, `shell_exec`, `system`, `passthru`, `proc_open`, `popen`, `pcntl_exec`, backtick, Symfony Process và Laravel Process facade; test tại `tests/PHPStan`.
