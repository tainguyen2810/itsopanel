# contracts/openapi

OpenAPI 3.1, **sinh tự động** từ `contracts/tools/gen_openapi.py` (`make contracts`). Không sửa tay.

- `itso-admin-v1.yaml`: Admin API (`/api/v1/admin/*`) cho Private Admin Panel và CLI `itso`.
- `itso-portal-v1.yaml`: Portal API (`/api/v1/portal/*`) cho User Hosting Portal.
- `common.yaml`: schema, tham số, response lỗi và security scheme dùng chung.

Xem quy ước ở [../README.md](../README.md).
