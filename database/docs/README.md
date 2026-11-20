# database/docs

| Tài liệu | Nội dung |
|---|---|
| [ownership.md](ownership.md) | Chuỗi sở hữu, phạm vi theo vai trò, ràng buộc tầng DB |
| [lifecycle.md](lifecycle.md) | Vòng đời hosting account, quy trình purge D-46, chuyển server D-48 |
| [migration-plan.md](migration-plan.md) | Bảng theo Phase, expand/contract, partition |
| [erd/](erd/) | ERD SVG sinh từ DBML (`make db-erd`): `erd-full.svg` và một file cho mỗi nhóm |

ERD theo nhóm: [identity](erd/erd-identity.svg) · [infra](erd/erd-infra.svg) · [hosting](erd/erd-hosting.svg) · [docker](erd/erd-docker.svg) · [backup](erd/erd-backup.svg) · [jobs](erd/erd-jobs.svg) · [security](erd/erd-security.svg) · [ops](erd/erd-ops.svg). Bảng màu xám trong ERD nhóm là bảng thuộc nhóm khác được tham chiếu.
