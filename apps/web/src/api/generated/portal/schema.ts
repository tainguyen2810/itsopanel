// SINH TỰ ĐỘNG từ contracts/openapi/itso-portal-v1.yaml bằng openapi-typescript — KHÔNG sửa tay.
// Sửa contracts rồi chạy: make codegen

export interface paths {
    "/api/v1/auth/captcha": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Thử thách CAPTCHA proof-of-work (dùng một lần, 5 phút)
         * @description Tự host, không gọi dịch vụ ngoài (D-81). Đăng nhập/quên mật khẩu trả 422 `captcha_required` khi IP hoặc email đã sai quá ngưỡng (`portal_captcha_after_failures`); khi đó gửi kèm `captcha`.
         */
        get: operations["getCaptcha"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/csrf": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Lấy cookie XSRF-TOKEN */
        get: operations["getCsrfCookie"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/impersonation:accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Nhận phiên giả danh từ Admin (vé dùng một lần)
         * @description Vé do `POST /api/v1/admin/users/{id}:impersonate` tạo, hết hạn sau 60 giây, dùng một lần. Phiên giả danh không đổi được mật khẩu/MFA và tự hết hạn theo `expires_at`.
         */
        post: operations["acceptImpersonation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/impersonation:end": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Kết thúc giả danh */
        post: operations["endImpersonation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Đăng nhập (realm theo origin)
         * @description Origin admin chỉ chấp nhận user realm `admin`, origin portal chỉ chấp nhận realm `portal` (một origin: theo header `X-ITSO-Realm`, D-58). Sai realm trả cùng lỗi như sai mật khẩu.
         */
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Đăng xuất */
        post: operations["logout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Người dùng hiện tại */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/mfa/totp:confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Xác nhận TOTP */
        post: operations["confirmTotp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/mfa/totp:enroll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bắt đầu đăng ký TOTP */
        post: operations["enrollTotp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/mfa/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Xác minh MFA sau đăng nhập */
        post: operations["verifyMfa"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/password:change": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Đổi mật khẩu */
        post: operations["changePassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/password:forgot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Gửi email đặt lại mật khẩu
         * @description Luôn trả 204 dù email có tồn tại hay không (không lộ tài khoản). Portal: 422 `captcha_required` khi IP/email đã sai quá ngưỡng như đăng nhập (D-81).
         */
        post: operations["forgotPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/password:reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Đặt lại mật khẩu bằng token */
        post: operations["resetPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Phiên đăng nhập của tôi */
        get: operations["listSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Thu hồi phiên */
        delete: operations["revokeSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/step-up": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Xác thực lại MFA cho thao tác nguy hiểm */
        post: operations["stepUp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/backup-snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Bản backup */
        get: operations["portalListBackupSnapshots"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/backup-snapshots/{id}/browse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Duyệt file trong snapshot */
        get: operations["portalBrowseBackupSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/backup-snapshots/{id}/raw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Tải một file từ snapshot (URL ký số từ download-link)
         * @description Stream file theo khúc 1 MiB qua agent (`backup.file.read`, `restic dump`); tối đa 512 MiB. Cần phiên đăng nhập và chữ ký còn hạn (HMAC, 5 phút).
         */
        get: operations["portalDownloadBackupFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/backup-snapshots/{id}:download-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Link tải bản backup
         * @description Link ký HMAC hết hạn 5 phút tới `/backup-snapshots/{id}/raw`; chỉ tải từng file (`path` bắt buộc, null → 422: lấy cả snapshot bằng khôi phục). File được agent đọc từ snapshot (`restic dump`) khi tải.
         */
        post: operations["portalBackupDownloadLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/backups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Backup ngay (trong quota)
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateBackup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/certificates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Chứng chỉ SSL */
        get: operations["portalListCertificates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/certificates/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Xóa chứng chỉ
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalDeleteCertificate"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/certificates/{id}:renew": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Gia hạn ngay
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalRenewCertificate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/cron-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Cron job */
        get: operations["portalListCronJobs"];
        put?: never;
        /**
         * Tạo cron job
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateCronJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/cron-jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Xóa cron job
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalDeleteCronJob"];
        options?: never;
        head?: never;
        /**
         * Sửa cron job
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        patch: operations["portalUpdateCronJob"];
        trace?: never;
    };
    "/api/v1/portal/cron-jobs/{id}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Lịch sử chạy */
        get: operations["portalListCronRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/cron-jobs/{id}:run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Chạy ngay
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalRunCronJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/database-users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** DB user */
        get: operations["portalListDatabaseUsers"];
        put?: never;
        /**
         * Tạo DB user
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateDatabaseUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/database-users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Xóa DB user
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalDeleteDatabaseUser"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/database-users/{id}/grants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Đặt quyền DB user
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        put: operations["portalSetDatabaseUserGrants"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/database-users/{id}:rotate-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Đổi mật khẩu DB user */
        post: operations["portalRotateDatabaseUserPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/databases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Danh sách database */
        get: operations["portalListDatabases"];
        put?: never;
        /**
         * Tạo database
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateDatabase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/databases/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Chi tiết database */
        get: operations["portalGetDatabase"];
        put?: never;
        post?: never;
        /**
         * Xóa database
         * @description Yêu cầu step-up MFA (xác thực lại trong 10 phút), nếu không trả 403 `mfa_step_up_required`.
         *
         *     Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalDeleteDatabase"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/databases/{id}:export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Xuất dump vào home account
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalExportDatabase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/databases/{id}:import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Nhập dump từ file trong home
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalImportDatabase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/git-deployments/{id}:rollback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Quay về release này (đổi symlink)
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalRollbackGitDeployment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/git-repositories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Repository Git gắn với website */
        get: operations["portalListGitRepositories"];
        put?: never;
        /**
         * Kết nối repository (sinh deploy key riêng)
         * @description Panel sinh cặp khóa ed25519 cho site; khóa riêng chỉ nằm ở agent. Thêm `deploy_key_public` vào repo (chỉ đọc) trước khi deploy.
         */
        post: operations["portalCreateGitRepository"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/git-repositories/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Chi tiết repository */
        get: operations["portalGetGitRepository"];
        put?: never;
        post?: never;
        /** Ngắt kết nối repository (giữ release hiện tại) */
        delete: operations["portalDeleteGitRepository"];
        options?: never;
        head?: never;
        /** Sửa cấu hình deploy */
        patch: operations["portalUpdateGitRepository"];
        trace?: never;
    };
    "/api/v1/portal/git-repositories/{id}/deployments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Lịch sử deploy */
        get: operations["portalListGitDeployments"];
        put?: never;
        /**
         * Deploy (commit mới nhất của branch hoặc commit chỉ định)
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateGitDeployment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/git-repositories/{id}:rotate-webhook-secret": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Đổi secret webhook (HMAC-SHA256) */
        post: operations["portalRotateGitWebhookSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Account của tôi */
        get: operations["portalListHostingAccounts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Chi tiết account (chỉ đọc) */
        get: operations["portalGetHostingAccount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/features": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Tính năng theo gói (PHP, SSH, cron, backup) */
        get: operations["portalGetHostingAccountFeatures"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liệt kê thư mục */
        get: operations["portalListFiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/files/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Đọc nội dung file (≤ 2 MB)
         * @description File lớn hơn 2 MiB hoặc không phải file thường → 422 (dùng tải xuống).
         */
        get: operations["portalReadFile"];
        /**
         * Ghi nội dung file
         * @description `if_etag` khác ETag hiện tại của file (đã bị sửa nơi khác) → 412.
         */
        put: operations["portalWriteFile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/files/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Tạo URL tải xuống ký số, hạn 5 phút */
        get: operations["portalDownloadLink"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/files/raw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Tải file (URL ký số từ DownloadLink)
         * @description Stream nội dung file theo từng khúc 1 MiB qua agent (`fs.read` có `offset`). Cần phiên đăng nhập và chữ ký còn hạn.
         */
        get: operations["portalDownloadFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/files/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Tạo phiên upload theo chunk */
        post: operations["portalCreateUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/files/uploads/{upload}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Trạng thái phiên upload (để tiếp tục) */
        get: operations["portalGetUpload"];
        put?: never;
        post?: never;
        /** Hủy phiên upload */
        delete: operations["portalCancelUpload"];
        options?: never;
        head?: never;
        /**
         * Gửi một chunk
         * @description Chunk phải bắt đầu đúng tại `received` (sai → 409 kèm `received` hiện tại); chunk cuối tạo job `file.upload` (agent `fs.upload.commit`, ghi dưới uid account) và trả `status=committing`.
         */
        patch: operations["portalUploadChunk"];
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/files:operate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * mkdir/move/copy/delete/chmod/nén/giải nén
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalOperateFiles"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/scans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Quét mã độc account
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalScanAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/hosting-accounts/{id}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Usage so với quota */
        get: operations["portalGetHostingAccountUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Danh sách job */
        get: operations["portalListJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Chi tiết job (gồm các bước) */
        get: operations["portalGetJob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/jobs/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Luồng tiến độ (SSE qua gateway)
         * @description `text/event-stream`; mỗi sự kiện là một Job JSON. Fallback polling 2 giây.
         */
        get: operations["portalStreamJobEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/jobs/{id}/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Log job */
        get: operations["portalGetJobLogs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/jobs/{id}:cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Yêu cầu hủy job */
        post: operations["portalCancelJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/jobs/{id}:retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Chạy lại job thất bại/đã hủy (tạo job mới cùng tham số)
         * @description Chỉ job `failed`, `cancelled`, `timed_out`; job khác → 409 `conflict`. Job mới tham chiếu cùng tài nguyên.
         *
         *     Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalRetryJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/notification-preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Tùy chọn thông báo */
        get: operations["portalGetNotificationPreferences"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Đổi tùy chọn thông báo */
        patch: operations["portalUpdateNotificationPreferences"];
        trace?: never;
    };
    "/api/v1/portal/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Thông báo */
        get: operations["portalListNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/notifications/{id}:read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Đánh dấu đã đọc */
        post: operations["portalMarkNotificationRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/notifications:read-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Đọc tất cả */
        post: operations["portalMarkAllNotificationsRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Tổng quan: usage so với quota, cảnh báo */
        get: operations["portalOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Hồ sơ */
        get: operations["portalGetProfile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Đổi hồ sơ */
        patch: operations["portalUpdateProfile"];
        trace?: never;
    };
    "/api/v1/portal/protection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Bảo mật account của tôi: WAF, mã độc */
        get: operations["portalGetSecurity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/protection/findings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** File nghi nhiễm của tôi */
        get: operations["portalListMalwareFindings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/protection/findings/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Xóa file nghi nhiễm
         * @description Yêu cầu step-up MFA (xác thực lại trong 10 phút), nếu không trả 403 `mfa_step_up_required`.
         *
         *     Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalDeleteFinding"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/protection/findings/{id}:quarantine": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cách ly file nghi nhiễm
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalQuarantineFinding"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/restores": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Lịch sử khôi phục */
        get: operations["portalListRestores"];
        put?: never;
        /**
         * Khôi phục
         * @description `mode=overwrite` yêu cầu step-up MFA và `confirm` = username account.
         *
         *     Yêu cầu step-up MFA (xác thực lại trong 10 phút), nếu không trả 403 `mfa_step_up_required`.
         *
         *     Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateRestore"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/restores/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Chi tiết khôi phục */
        get: operations["portalGetRestore"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/sftp-accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Tài khoản SFTP/FTPS */
        get: operations["portalListSftpAccounts"];
        put?: never;
        /**
         * Tạo tài khoản SFTP/FTPS
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateSftpAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/sftp-accounts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Xóa tài khoản SFTP
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalDeleteSftpAccount"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/sftp-accounts/{id}:rotate-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Đặt mật khẩu mới (trả một lần)
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalRotateSftpPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/ssh-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** SSH key */
        get: operations["portalListSshKeys"];
        put?: never;
        /**
         * Thêm SSH key (gói phải cho phép SSH)
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateSshKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/ssh-keys/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Xóa SSH key
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalDeleteSshKey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/terminal/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mở terminal (ticket 30 giây, dùng một lần)
         * @description Chỉ khi gói cho phép SSH; shell chạy trong jail của account. `mode=root` luôn bị từ chối.
         *
         *     Yêu cầu step-up MFA (xác thực lại trong 10 phút), nếu không trả 403 `mfa_step_up_required`.
         */
        post: operations["portalCreateTerminalSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/websites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Danh sách website */
        get: operations["portalListWebsites"];
        put?: never;
        /**
         * Tạo website
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalCreateWebsite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/websites/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Chi tiết website */
        get: operations["portalGetWebsite"];
        put?: never;
        post?: never;
        /**
         * Xóa website
         * @description Yêu cầu step-up MFA (xác thực lại trong 10 phút), nếu không trả 403 `mfa_step_up_required`.
         *
         *     Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalDeleteWebsite"];
        options?: never;
        head?: never;
        /**
         * Cập nhật website
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        patch: operations["portalUpdateWebsite"];
        trace?: never;
    };
    "/api/v1/portal/websites/{id}/certificates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cấp/tải lên chứng chỉ
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalRequestCertificate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/websites/{id}/domains": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Domain của website */
        get: operations["portalListWebsiteDomains"];
        put?: never;
        /**
         * Thêm domain phụ
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalAddWebsiteDomain"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/websites/{id}/domains/{domain}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Gỡ domain phụ
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        delete: operations["portalRemoveWebsiteDomain"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/websites/{id}/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Log truy cập/lỗi (dòng cuối)
         * @description Đọc trực tiếp qua op `log.tail` của agent (không tạo job); tối đa 500 dòng, `lines` lớn hơn bị giới hạn ở 500. Agent không kết nối → 503.
         */
        get: operations["portalGetWebsiteLogs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/websites/{id}/nginx": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Cấu hình Nginx của website */
        get: operations["portalGetWebsiteNginx"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Đổi cấu hình Nginx (giá trị trong allowlist)
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        patch: operations["portalUpdateWebsiteNginx"];
        trace?: never;
    };
    "/api/v1/portal/websites/{id}/php": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Cấu hình PHP của website */
        get: operations["portalGetWebsitePhp"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Đổi cấu hình PHP (trong giới hạn gói)
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        patch: operations["portalUpdateWebsitePhp"];
        trace?: never;
    };
    "/api/v1/portal/wordpress/sites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Site WordPress */
        get: operations["portalListWordPressSites"];
        put?: never;
        /**
         * Cài WordPress vào website
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalInstallWordPress"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/wordpress/sites/{id}:clone-staging": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Tạo bản staging
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalWordPressCloneStaging"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/wordpress/sites/{id}:harden": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Áp dụng hardening
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalWordPressHarden"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/portal/wordpress/sites/{id}:update": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cập nhật core/plugin/theme
         * @description Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.
         */
        post: operations["portalWordPressUpdate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Kiểm tra sống */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        CaptchaChallenge: {
            challenge: string;
            difficulty: number;
            /** Format: date-time */
            expires_at: string;
        };
        /** @enum {string} */
        ErrorCode: "bad_request" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "idempotency_key_reused" | "precondition_failed" | "validation_failed" | "rate_limited" | "mfa_required" | "mfa_step_up_required" | "ip_not_allowed" | "csrf_mismatch" | "quota_exceeded" | "package_limit_reached" | "resource_locked" | "invalid_state_transition" | "server_not_accepting" | "agent_unavailable" | "job_failed" | "legal_hold_active" | "retention_not_elapsed" | "backup_not_verified" | "confirmation_mismatch" | "purge_not_available" | "migration_not_available" | "setup_code_used" | "setup_code_expired" | "setup_not_verified" | "setup_completed" | "captcha_required" | "would_lock_out" | "internal_error";
        /** @description RFC 9457 Problem Details. */
        Problem: {
            /** Format: uri-reference */
            type: string;
            title: string;
            status: number;
            detail?: string;
            code: components["schemas"]["ErrorCode"];
            instance?: string;
            request_id?: string;
            errors?: {
                [key: string]: string[];
            };
        };
        User: {
            /** Format: uuid */
            uuid: string;
            /** @enum {string} */
            realm: "admin" | "portal";
            name: string;
            /** Format: email */
            email: string;
            /** @enum {string} */
            role: "SUPER_ADMIN" | "ADMIN" | "USER";
            /** @enum {string} */
            status: "active" | "locked" | "disabled";
            mfa_enabled: boolean;
            /** @enum {string} */
            locale: "vi" | "en";
            timezone: string;
            /** Format: date-time */
            last_login_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        UserRef: {
            /** Format: uuid */
            uuid: string;
            name: string;
            /** Format: email */
            email: string;
        };
        Me: {
            user: components["schemas"]["User"];
            permissions: string[];
            scopes: {
                scope_type: string;
                /** Format: uuid */
                uuid: string;
                name: string;
            }[];
            /** Format: date-time */
            mfa_verified_at: string | null;
            impersonating: components["schemas"]["UserRef"] | null;
        };
        CaptchaSolution: {
            challenge: string;
            nonce: string;
        };
        LoginRequest: {
            /** Format: email */
            email: string;
            password: string;
            remember?: boolean;
            captcha?: components["schemas"]["CaptchaSolution"];
        };
        LoginResult: {
            mfa_required: boolean;
            mfa_methods: ("totp" | "recovery")[];
        };
        MfaVerifyRequest: {
            code: string;
            /** @enum {string} */
            method: "totp" | "recovery";
        };
        TotpEnrollment: {
            secret: string;
            otpauth_uri: string;
            recovery_codes: string[];
        };
        PasswordChange: {
            current_password: string;
            new_password: string;
        };
        CursorMeta: {
            next_cursor: string | null;
            limit?: number;
        };
        CursorPage: {
            meta: components["schemas"]["CursorMeta"];
        };
        Session: {
            /** Format: uuid */
            uuid: string;
            ip: string;
            user_agent: string;
            current: boolean;
            /** Format: date-time */
            last_active_at: string;
            /** Format: date-time */
            created_at: string;
        };
        /** @description Username Linux của hosting account. */
        Username: string;
        AccountRef: {
            /** Format: uuid */
            uuid: string;
            username: components["schemas"]["Username"];
        };
        /** @description Tên miền chữ thường, đã chuyển punycode. Kiểm thêm ở tầng nghiệp vụ: cấm localhost, IP, tên panel. */
        Domain: string;
        WebsiteRef: {
            /** Format: uuid */
            uuid: string;
            primary_domain: components["schemas"]["Domain"];
        };
        /** @description Tên database/DB user. Tầng nghiệp vụ bắt buộc tiền tố `<username>_`. */
        DbName: string;
        BackupSnapshot: {
            /** Format: uuid */
            uuid: string;
            hosting_account: components["schemas"]["AccountRef"] | null;
            destination: {
                /** Format: uuid */
                uuid: string;
                name: string;
            };
            /** Format: uuid */
            repository_uuid: string | null;
            /** @enum {string} */
            scope_type: "hosting_account" | "website" | "database" | "server_config" | "panel";
            website: components["schemas"]["WebsiteRef"] | null;
            databases: components["schemas"]["DbName"][];
            restic_snapshot_id: string;
            size_mb: number;
            /** Format: date-time */
            taken_at: string;
            /** Format: date-time */
            verified_at: string | null;
            contents: ("files" | "databases" | "config")[];
            tags: string[];
            panel_version: string | null;
            /**
             * Format: date-time
             * @description Còn bất biến (Object Lock/append-only) tới thời điểm này: không xóa được.
             */
            locked_until: string | null;
        };
        /** @description Đường dẫn TƯƠNG ĐỐI với home của account. `.` là thư mục gốc. Cấm `..`, ký tự điều khiển, đường dẫn tuyệt đối. */
        RelPath: string & ("." | unknown);
        FileEntry: {
            name: string;
            path: components["schemas"]["RelPath"];
            /** @enum {string} */
            type: "file" | "dir" | "symlink";
            size: number;
            mode: string;
            owner: string;
            /** Format: date-time */
            modified_at: string;
        };
        /** @description `path` = một file thường trong snapshot (≤ 512 MiB); null → 422 (lấy cả snapshot bằng khôi phục). */
        BackupDownloadRequest: {
            path?: components["schemas"]["RelPath"] | null;
        };
        SignedUrl: {
            /** Format: uri */
            url: string;
            /** Format: date-time */
            expires_at: string;
        };
        BackupRequest: {
            /** Format: uuid */
            hosting_account_uuid: string;
            contents: ("files" | "databases" | "config")[];
            note?: string | null;
        };
        /**
         * @description `waiting_agent`: server của job đang mất kết nối, job chờ tới hạn rồi `failed` mã `agent_unreachable` (D-91).
         * @enum {string}
         */
        JobState: "queued" | "waiting_agent" | "running" | "succeeded" | "failed" | "cancel_requested" | "cancelled" | "timed_out";
        ResourceRef: {
            type: string;
            /** Format: uuid */
            uuid: string;
        };
        JobStep: {
            seq: number;
            op: string;
            /** @enum {string} */
            state: "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
            /** Format: date-time */
            started_at: string | null;
            /** Format: date-time */
            finished_at: string | null;
        };
        ServerRef: {
            /** Format: uuid */
            uuid: string;
            name: string;
        };
        Job: {
            /** Format: uuid */
            uuid: string;
            type: string;
            state: components["schemas"]["JobState"];
            progress: number;
            resource: components["schemas"]["ResourceRef"] | null;
            steps: components["schemas"]["JobStep"][];
            attempts: number;
            max_attempts: number;
            timeout_sec: number;
            error: {
                code: string;
                message: string;
                step: number | null;
            } | null;
            server: components["schemas"]["ServerRef"] | null;
            requested_by: components["schemas"]["UserRef"] | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            started_at: string | null;
            /** Format: date-time */
            finished_at: string | null;
            links: {
                self: string;
                events: string;
            };
        };
        JobAccepted: {
            job: components["schemas"]["Job"];
            resource?: components["schemas"]["ResourceRef"] | null;
            /** @description Mật khẩu do panel sinh (DB user, FTP): chỉ trả MỘT lần ở đây. */
            secret?: string | null;
        };
        Certificate: {
            /** Format: uuid */
            uuid: string;
            website: components["schemas"]["WebsiteRef"];
            /** @enum {string} */
            source: "acme" | "upload";
            domains: components["schemas"]["Domain"][];
            issuer: string;
            /** Format: date-time */
            not_before: string;
            /** Format: date-time */
            not_after: string;
            auto_renew: boolean;
            /** @enum {string} */
            status: "pending" | "valid" | "expiring" | "expired" | "failed";
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        /** @description Biểu thức cron 5 trường dạng số. Khoảng tối thiểu theo gói kiểm ở tầng nghiệp vụ. */
        CronExpr: string;
        /** @description Lệnh chạy dưới UID của account. Một dòng, không ký tự xuống dòng (chống chèn crontab). */
        CronCommand: string;
        PhpVersion: string;
        CronJob: {
            /** Format: uuid */
            uuid: string;
            hosting_account: components["schemas"]["AccountRef"];
            website: components["schemas"]["WebsiteRef"] | null;
            schedule: components["schemas"]["CronExpr"];
            command: components["schemas"]["CronCommand"];
            working_dir: components["schemas"]["RelPath"];
            php_version: components["schemas"]["PhpVersion"] | null;
            enabled: boolean;
            timeout_sec: number;
            /** Format: date-time */
            last_run_at: string | null;
            /** @enum {string|null} */
            last_status: "succeeded" | "failed" | "timed_out" | null;
            /**
             * @description Trạng thái quan sát được (observed).
             * @enum {string}
             */
            status: "pending" | "provisioning" | "ready" | "degraded" | "failed" | "suspended" | "deleting";
            /** @description Desired: tăng mỗi lần đổi cấu hình. */
            spec_version: number;
            /** @description Phiên bản agent đã áp dụng. */
            observed_version: number;
            drift: {
                [key: string]: string;
            } | null;
            /** Format: date-time */
            observed_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        CronJobCreate: {
            /** Format: uuid */
            hosting_account_uuid: string;
            /** Format: uuid */
            website_uuid?: string | null;
            schedule: components["schemas"]["CronExpr"];
            command: components["schemas"]["CronCommand"];
            working_dir?: components["schemas"]["RelPath"];
            php_version?: components["schemas"]["PhpVersion"] | null;
            enabled?: boolean;
            timeout_sec?: number;
        };
        CronJobUpdate: {
            schedule?: components["schemas"]["CronExpr"];
            command?: components["schemas"]["CronCommand"];
            working_dir?: components["schemas"]["RelPath"];
            enabled?: boolean;
            timeout_sec?: number;
        };
        CronRun: {
            /** Format: uuid */
            uuid: string;
            /** Format: date-time */
            started_at: string;
            /** Format: date-time */
            finished_at: string | null;
            exit_code: number | null;
            /** @enum {string} */
            status: "running" | "succeeded" | "failed" | "timed_out";
            output_tail: string;
        };
        DatabaseGrant: {
            database: components["schemas"]["DbName"];
            privileges: ("ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "CREATE" | "DROP" | "ALTER" | "INDEX")[];
        };
        DatabaseUser: {
            /** Format: uuid */
            uuid: string;
            hosting_account: components["schemas"]["AccountRef"];
            /** @enum {string} */
            engine: "mariadb" | "mysql" | "postgresql";
            username: components["schemas"]["DbName"];
            /** @enum {string} */
            host: "localhost" | "%";
            max_connections: number;
            grants: components["schemas"]["DatabaseGrant"][];
            /**
             * @description Trạng thái quan sát được (observed).
             * @enum {string}
             */
            status: "pending" | "provisioning" | "ready" | "degraded" | "failed" | "suspended" | "deleting";
            /** @description Desired: tăng mỗi lần đổi cấu hình. */
            spec_version: number;
            /** @description Phiên bản agent đã áp dụng. */
            observed_version: number;
            drift: {
                [key: string]: string;
            } | null;
            /** Format: date-time */
            observed_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        /** @description Mật khẩu DB/FTP/SFTP. Tới agent chỉ qua tham chiếu bí mật do JobRunner thay (D-69/D-71); không có dấu nháy, gạch chéo ngược, khoảng trắng. */
        SecretPassword: string;
        DatabaseUserCreate: {
            /** Format: uuid */
            hosting_account_uuid: string;
            /** @enum {string} */
            engine: "mariadb" | "mysql" | "postgresql";
            username: components["schemas"]["DbName"];
            password?: components["schemas"]["SecretPassword"] | null;
            /** @enum {string} */
            host?: "localhost" | "%";
            max_connections?: number;
        };
        SecretOnce: {
            /** @description Chỉ trả MỘT lần, không lưu ở dạng đọc lại được. */
            secret: string;
        };
        Database: {
            /** Format: uuid */
            uuid: string;
            hosting_account: components["schemas"]["AccountRef"];
            server: components["schemas"]["ServerRef"];
            /** @enum {string} */
            engine: "mariadb" | "mysql" | "postgresql";
            name: components["schemas"]["DbName"];
            size_mb: number;
            charset: string;
            users: components["schemas"]["DbName"][];
            /**
             * @description Trạng thái quan sát được (observed).
             * @enum {string}
             */
            status: "pending" | "provisioning" | "ready" | "degraded" | "failed" | "suspended" | "deleting";
            /** @description Desired: tăng mỗi lần đổi cấu hình. */
            spec_version: number;
            /** @description Phiên bản agent đã áp dụng. */
            observed_version: number;
            drift: {
                [key: string]: string;
            } | null;
            /** Format: date-time */
            observed_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        DatabaseCreate: {
            /** Format: uuid */
            hosting_account_uuid: string;
            /** @enum {string} */
            engine: "mariadb" | "mysql" | "postgresql";
            name: components["schemas"]["DbName"];
            create_user?: boolean;
        };
        GitDeploymentRef: {
            /** Format: uuid */
            uuid: string;
            commit_sha: string;
            /** Format: date-time */
            finished_at: string | null;
        };
        GitRepository: {
            /** Format: uuid */
            uuid: string;
            website: components["schemas"]["WebsiteRef"];
            hosting_account: components["schemas"]["AccountRef"];
            repo_url: string;
            branch: string;
            deploy_key_public: string;
            deploy_key_fingerprint: string;
            webhook_url: string;
            auto_deploy: boolean;
            build_command: components["schemas"]["CronCommand"] | null;
            shared_paths: components["schemas"]["RelPath"][];
            keep_releases: number;
            current_deployment: components["schemas"]["GitDeploymentRef"] | null;
            /**
             * @description Trạng thái quan sát được (observed).
             * @enum {string}
             */
            status: "pending" | "provisioning" | "ready" | "degraded" | "failed" | "suspended" | "deleting";
            /** @description Desired: tăng mỗi lần đổi cấu hình. */
            spec_version: number;
            /** @description Phiên bản agent đã áp dụng. */
            observed_version: number;
            drift: {
                [key: string]: string;
            } | null;
            /** Format: date-time */
            observed_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        GitRepositoryCreate: {
            /** Format: uuid */
            website_uuid: string;
            repo_url: string;
            branch: string;
            auto_deploy?: boolean;
            build_command?: components["schemas"]["CronCommand"] | null;
            shared_paths?: components["schemas"]["RelPath"][];
            keep_releases?: number;
        };
        GitRepositoryUpdate: {
            branch?: string;
            auto_deploy?: boolean;
            build_command?: components["schemas"]["CronCommand"] | null;
            shared_paths?: components["schemas"]["RelPath"][];
            keep_releases?: number;
        };
        GitDeployment: {
            /** Format: uuid */
            uuid: string;
            /** Format: uuid */
            repository_uuid: string;
            commit_sha: string;
            commit_message: string | null;
            commit_author: string | null;
            /** @enum {string} */
            trigger: "manual" | "webhook" | "rollback";
            /** @enum {string} */
            state: "queued" | "running" | "succeeded" | "failed" | "rolled_back";
            release_path: components["schemas"]["RelPath"] | null;
            /** Format: uuid */
            rollback_of: string | null;
            /** Format: uuid */
            job_uuid: string | null;
            requested_by: components["schemas"]["UserRef"] | null;
            /** Format: date-time */
            started_at: string | null;
            /** Format: date-time */
            finished_at: string | null;
            /** Format: date-time */
            created_at: string;
        };
        GitDeployRequest: {
            commit_sha?: string | null;
        };
        PackageRef: {
            /** Format: uuid */
            uuid: string;
            code: string;
            name: string;
            version: number;
        };
        /** @enum {string} */
        LifecycleState: "pending" | "provisioning" | "active" | "suspended" | "migrating" | "terminated" | "purged" | "failed";
        UsageItem: {
            used: number;
            limit: number;
        };
        Usage: {
            disk_mb: components["schemas"]["UsageItem"];
            inodes: components["schemas"]["UsageItem"];
            cpu_percent: components["schemas"]["UsageItem"];
            ram_mb: components["schemas"]["UsageItem"];
            websites: components["schemas"]["UsageItem"];
            databases: components["schemas"]["UsageItem"];
            ftp_accounts: components["schemas"]["UsageItem"];
            cron_jobs: components["schemas"]["UsageItem"];
            backup_mb: components["schemas"]["UsageItem"];
            bandwidth_mb_30d: number;
            /** Format: date-time */
            measured_at: string;
        };
        HostingAccount: {
            /** Format: uuid */
            uuid: string;
            username: components["schemas"]["Username"];
            server: components["schemas"]["ServerRef"];
            package: components["schemas"]["PackageRef"];
            owner: components["schemas"]["UserRef"];
            uid: number;
            home_path: string;
            lifecycle_state: components["schemas"]["LifecycleState"];
            suspended_reason: string | null;
            /** Format: date-time */
            terminated_at: string | null;
            /** Format: date-time */
            purge_after: string | null;
            legal_hold: boolean;
            usage: components["schemas"]["Usage"];
            /**
             * @description Trạng thái quan sát được (observed).
             * @enum {string}
             */
            status: "pending" | "provisioning" | "ready" | "degraded" | "failed" | "suspended" | "deleting";
            /** @description Desired: tăng mỗi lần đổi cấu hình. */
            spec_version: number;
            /** @description Phiên bản agent đã áp dụng. */
            observed_version: number;
            drift: {
                [key: string]: string;
            } | null;
            /** Format: date-time */
            observed_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        /** @description Tính năng theo phiên bản gói hiện hành của account (đã áp limits_override); tập con an toàn cho Portal (D-57). */
        AccountFeatures: {
            package: components["schemas"]["PackageRef"];
            php_versions: components["schemas"]["PhpVersion"][];
            php_workers_max: number;
            ssh_allowed: boolean;
            cron_min_interval_min: number;
            backup_quota_mb: number;
            backup_retention: {
                [key: string]: number;
            };
        };
        FileContent: {
            path: components["schemas"]["RelPath"];
            content: string;
            /** @enum {string} */
            encoding: "utf-8" | "base64";
            etag: string;
        };
        FileWrite: {
            path: components["schemas"]["RelPath"];
            content: string;
            /** @enum {string} */
            encoding?: "utf-8" | "base64";
            if_etag?: string | null;
        };
        UploadCreate: {
            path: components["schemas"]["RelPath"];
            size: number;
            overwrite?: boolean;
        };
        UploadSession: {
            /** Format: uuid */
            uuid: string;
            path: components["schemas"]["RelPath"];
            size: number;
            chunk_size: number;
            received: number;
            /** Format: date-time */
            expires_at: string;
            /** @enum {string} */
            status: "receiving" | "committing" | "completed" | "failed" | "cancelled";
            /** Format: uuid */
            job_uuid: string | null;
        };
        FileOperation: {
            /** @enum {string} */
            op: "mkdir" | "rename" | "move" | "copy" | "delete" | "chmod" | "compress" | "extract";
            paths: components["schemas"]["RelPath"][];
            target?: components["schemas"]["RelPath"] | null;
            mode?: string | null;
            /** @enum {string|null} */
            format?: "zip" | "tar.gz" | null;
        };
        JobLog: {
            seq: number;
            /** Format: date-time */
            at: string;
            /** @enum {string} */
            level: "debug" | "info" | "warn" | "error";
            message: string;
        };
        NotificationPreferences: {
            channels: {
                [key: string]: boolean;
            };
            events: {
                [key: string]: ("email" | "telegram" | "in_app")[];
            };
            /** Format: date-time */
            updated_at: string;
        };
        Notification: {
            /** Format: uuid */
            uuid: string;
            type: string;
            /** @enum {string} */
            severity: "info" | "low" | "medium" | "high" | "critical";
            title: string;
            body: string;
            link: string | null;
            /** Format: date-time */
            read_at: string | null;
            /** Format: date-time */
            created_at: string;
        };
        PortalOverview: {
            accounts: {
                hosting_account: components["schemas"]["AccountRef"];
                lifecycle_state: components["schemas"]["LifecycleState"];
                usage: components["schemas"]["Usage"];
            }[];
            warnings: {
                code: string;
                message: string;
                /** @enum {string} */
                severity: "info" | "low" | "medium" | "high" | "critical";
            }[];
            recent_jobs: {
                /** Format: uuid */
                uuid: string;
                type: string;
                state: components["schemas"]["JobState"];
                progress: number;
            }[];
            notifications_unread: number;
        };
        PortalSecurity: {
            accounts: {
                hosting_account: components["schemas"]["AccountRef"];
                websites: {
                    website: components["schemas"]["WebsiteRef"];
                    waf_enabled: boolean;
                    /** @enum {string} */
                    waf_mode: "detect" | "block";
                    blocked_24h: number;
                }[];
                findings_open: number;
                /** Format: date-time */
                last_scan_at: string | null;
                scan_running: boolean;
            }[];
        };
        MalwareFinding: {
            /** Format: uuid */
            uuid: string;
            hosting_account: components["schemas"]["AccountRef"];
            website: components["schemas"]["WebsiteRef"] | null;
            path: components["schemas"]["RelPath"];
            signature: string;
            /** @enum {string} */
            engine: "clamav" | "yara";
            /** @enum {string} */
            action: "none" | "quarantined" | "restored" | "deleted";
            /** Format: date-time */
            found_at: string;
        };
        Restore: {
            /** Format: uuid */
            uuid: string;
            /** Format: uuid */
            snapshot_uuid: string | null;
            hosting_account: components["schemas"]["AccountRef"];
            target_server: components["schemas"]["ServerRef"];
            /** @enum {string} */
            mode: "new" | "overwrite";
            items: string[];
            state: components["schemas"]["JobState"];
            /** Format: uuid */
            job_uuid: string | null;
            requested_by: components["schemas"]["UserRef"];
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            finished_at: string | null;
            /** @description Kết quả: thư mục bản khôi phục (chế độ new), DB mới hoặc DB đã ghi đè, snapshot trước khi ghi đè. */
            result: {
                restored_paths: components["schemas"]["RelPath"][];
                databases: components["schemas"]["DbName"][];
                /** Format: uuid */
                pre_restore_snapshot_uuid: string | null;
            } | null;
            error: string | null;
        };
        RestoreRequest: {
            /** Format: uuid */
            snapshot_uuid: string;
            /** @enum {string} */
            mode: "new" | "overwrite";
            items: string[];
            /**
             * Format: uuid
             * @description Chỉ Admin, chỉ mode=new (Phase 9, D-93): khôi phục sang server khác đọc cùng repo; account được tạo ở đích nếu chưa có. Đích phải trực tuyến, nếu không 409 `agent_unreachable`.
             */
            target_server_uuid?: string | null;
            confirm?: string | null;
        };
        /** @description Virtual user Pure-FTPd (D-73). Tầng nghiệp vụ bắt buộc tiền tố `<username>_`. */
        FtpUsername: string;
        SftpAccount: {
            /** Format: uuid */
            uuid: string;
            hosting_account: components["schemas"]["AccountRef"];
            username: components["schemas"]["FtpUsername"];
            /**
             * @description sftp: user Linux chính của account (chroot home); ftps: tài khoản FTP phụ (Pure-FTPd, TLS bắt buộc), giới hạn thư mục con
             * @enum {string}
             */
            protocol: "sftp" | "ftps";
            root_path: components["schemas"]["RelPath"];
            /** @description Phase 6 luôn false (Pure-FTPd không hỗ trợ theo user) */
            read_only: boolean;
            /** Format: date-time */
            last_login_at: string | null;
            /**
             * @description Trạng thái quan sát được (observed).
             * @enum {string}
             */
            status: "pending" | "provisioning" | "ready" | "degraded" | "failed" | "suspended" | "deleting";
            /** @description Desired: tăng mỗi lần đổi cấu hình. */
            spec_version: number;
            /** @description Phiên bản agent đã áp dụng. */
            observed_version: number;
            drift: {
                [key: string]: string;
            } | null;
            /** Format: date-time */
            observed_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        SftpAccountCreate: {
            /** Format: uuid */
            hosting_account_uuid: string;
            username: components["schemas"]["FtpUsername"];
            /** @enum {string} */
            protocol: "sftp" | "ftps";
            root_path: components["schemas"]["RelPath"];
            read_only?: boolean;
            password?: components["schemas"]["SecretPassword"] | null;
        };
        SshKey: {
            /** Format: uuid */
            uuid: string;
            hosting_account: components["schemas"]["AccountRef"];
            name: string;
            fingerprint: string;
            /** @enum {string} */
            type: "ssh-ed25519" | "ecdsa-sha2-nistp256" | "ssh-rsa";
            /** Format: date-time */
            last_used_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        SshKeyCreate: {
            /** Format: uuid */
            hosting_account_uuid: string;
            name: string;
            public_key: string;
        };
        TerminalRequest: {
            /** Format: uuid */
            hosting_account_uuid?: string | null;
            /** Format: uuid */
            server_uuid?: string | null;
            /** @enum {string} */
            mode: "account" | "root";
        };
        TerminalTicket: {
            ticket: string;
            /** Format: uri */
            ws_url: string;
            /** Format: date-time */
            expires_at: string;
            /** @enum {string} */
            mode: "account" | "root";
            unix_user: string;
            /** Format: uuid */
            session_uuid: string;
        };
        Website: {
            /** Format: uuid */
            uuid: string;
            hosting_account: components["schemas"]["AccountRef"];
            server: components["schemas"]["ServerRef"];
            primary_domain: components["schemas"]["Domain"];
            /** @enum {string} */
            type: "php" | "static" | "proxy" | "docker";
            document_root: components["schemas"]["RelPath"];
            php_version: components["schemas"]["PhpVersion"] | null;
            /** @enum {string} */
            ssl_mode: "none" | "acme" | "custom";
            waf_enabled: boolean;
            domains_count: number;
            /** Format: date-time */
            certificate_expires_at: string | null;
            /**
             * @description Trạng thái quan sát được (observed).
             * @enum {string}
             */
            status: "pending" | "provisioning" | "ready" | "degraded" | "failed" | "suspended" | "deleting";
            /** @description Desired: tăng mỗi lần đổi cấu hình. */
            spec_version: number;
            /** @description Phiên bản agent đã áp dụng. */
            observed_version: number;
            drift: {
                [key: string]: string;
            } | null;
            /** Format: date-time */
            observed_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        WebsiteCreate: {
            /** Format: uuid */
            hosting_account_uuid: string;
            primary_domain: components["schemas"]["Domain"];
            /** @enum {string} */
            type: "php" | "static" | "proxy";
            document_root?: components["schemas"]["RelPath"];
            php_version?: components["schemas"]["PhpVersion"] | null;
            /** @enum {string} */
            ssl_mode?: "none" | "acme";
            proxy_target?: string | null;
        };
        WebsiteUpdate: {
            document_root?: components["schemas"]["RelPath"];
            php_version?: components["schemas"]["PhpVersion"] | null;
            /** @enum {string} */
            ssl_mode?: "none" | "acme" | "custom";
            waf_enabled?: boolean;
        };
        CertificateRequest: {
            /** @enum {string} */
            source: "acme" | "upload";
            domains: components["schemas"]["Domain"][];
            certificate_pem?: string | null;
            private_key_pem?: string | null;
        };
        WebsiteDomain: {
            /** Format: uuid */
            uuid: string;
            website: components["schemas"]["WebsiteRef"];
            name: components["schemas"]["Domain"];
            /** @enum {string} */
            type: "primary" | "alias" | "redirect" | "subdomain";
            /** Format: date-time */
            verified_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        WebsiteDomainCreate: {
            name: components["schemas"]["Domain"];
            /** @enum {string} */
            type: "alias" | "redirect" | "subdomain";
        };
        /** @description Giá trị kích thước Nginx, ví dụ 64m. */
        NginxSize: string;
        /** @description Giá trị đưa vào cấu hình Nginx: cấm ký tự phá cú pháp. */
        HeaderValue: string;
        /** @description Đường dẫn URL cho redirect/location: không khoảng trắng, dấu nháy, $, ;, {}. */
        UrlPath: string;
        /** @description URL đích redirect (http/https, domain chữ thường, path an toàn). */
        RedirectTarget: string;
        WebsiteNginx: {
            client_max_body_size?: components["schemas"]["NginxSize"];
            http2?: boolean;
            hsts?: boolean;
            extra_headers?: {
                [key: string]: components["schemas"]["HeaderValue"];
            };
            redirects?: {
                from: components["schemas"]["UrlPath"];
                to: components["schemas"]["RedirectTarget"];
                /** @enum {string} */
                code: "301" | "302";
            }[];
        };
        WebsitePhp: {
            version?: components["schemas"]["PhpVersion"];
            memory_limit?: components["schemas"]["NginxSize"];
            max_execution_time?: number;
            upload_max_filesize?: components["schemas"]["NginxSize"];
            pm_max_children?: number;
            disable_functions?: string[];
        };
        WordPressSite: {
            /** Format: uuid */
            uuid: string;
            website: components["schemas"]["WebsiteRef"];
            hosting_account: components["schemas"]["AccountRef"];
            wp_version: string;
            latest_version: string;
            plugins_total: number;
            plugins_outdated: number;
            themes_outdated: number;
            /** @enum {string} */
            auto_update: "off" | "minor" | "all";
            hardening: {
                [key: string]: boolean;
            };
            /** Format: uuid */
            staging_of: string | null;
            /** Format: date-time */
            updated_at: string;
        };
        WordPressInstall: {
            /** Format: uuid */
            website_uuid: string;
            title: string;
            admin_username: string;
            /** Format: email */
            admin_email: string;
            /** @enum {string} */
            locale: "vi" | "en_US";
        };
        Health: {
            /** @enum {string} */
            status: "ok";
        };
    };
    responses: {
        /** @description Quá nhiều yêu cầu */
        TooManyRequests: {
            headers: {
                /** @description Số giây chờ. */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://docs.itso.local/errors/rate_limited",
                 *       "title": "Quá nhiều yêu cầu",
                 *       "status": 429,
                 *       "code": "rate_limited",
                 *       "detail": "Thử lại sau 30 giây.",
                 *       "request_id": "req_01JD8K2M4N"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Dữ liệu không hợp lệ */
        ValidationFailed: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://docs.itso.local/errors/validation_failed",
                 *       "title": "Dữ liệu không hợp lệ",
                 *       "status": 422,
                 *       "code": "validation_failed",
                 *       "detail": "Một hoặc nhiều trường không hợp lệ.",
                 *       "request_id": "req_01JD8K2M4N",
                 *       "errors": {
                 *         "username": [
                 *           "Username đã tồn tại trên server này."
                 *         ]
                 *       }
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Chưa đăng nhập */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://docs.itso.local/errors/unauthenticated",
                 *       "title": "Chưa đăng nhập",
                 *       "status": 401,
                 *       "code": "unauthenticated",
                 *       "detail": "Phiên đã hết hạn.",
                 *       "request_id": "req_01JD8K2M4N"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Không có quyền */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://docs.itso.local/errors/forbidden",
                 *       "title": "Không có quyền",
                 *       "status": 403,
                 *       "code": "forbidden",
                 *       "detail": "Thao tác yêu cầu quyền khác hoặc step-up MFA.",
                 *       "request_id": "req_01JD8K2M4N"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Xung đột */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://docs.itso.local/errors/conflict",
                 *       "title": "Xung đột",
                 *       "status": 409,
                 *       "code": "conflict",
                 *       "detail": "Tài nguyên đang có job khác hoặc Idempotency-Key đã dùng với body khác.",
                 *       "request_id": "req_01JD8K2M4N"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Không tìm thấy */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://docs.itso.local/errors/not_found",
                 *       "title": "Không tìm thấy",
                 *       "status": 404,
                 *       "code": "not_found",
                 *       "detail": "Tài nguyên không tồn tại hoặc ngoài phạm vi.",
                 *       "request_id": "req_01JD8K2M4N"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Agent không kết nối */
        AgentUnavailable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://docs.itso.local/errors/agent_unavailable",
                 *       "title": "Agent không kết nối",
                 *       "status": 503,
                 *       "code": "agent_unavailable",
                 *       "detail": "Không gọi được agent của server; thử lại sau.",
                 *       "request_id": "req_01JD8K2M4N"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Phiên bản đã thay đổi */
        PreconditionFailed: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://docs.itso.local/errors/precondition_failed",
                 *       "title": "Phiên bản đã thay đổi",
                 *       "status": 412,
                 *       "code": "precondition_failed",
                 *       "detail": "If-Match không khớp ETag hiện tại.",
                 *       "request_id": "req_01JD8K2M4N"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
        Realm: "admin" | "portal";
        /** @description Cursor trang tiếp theo. */
        Cursor: string;
        /** @description Số bản ghi mỗi trang. */
        Limit: number;
        /** @description Sắp xếp, ví dụ `-created_at`. */
        Sort: string;
        /** @description Tìm kiếm tự do. */
        Q: string;
        /** @description UUID tài nguyên. */
        Id: string;
        /** @description Lọc theo account. */
        FilterHostingAccount: string;
        /** @description Lọc theo loại backup. */
        FilterScopeType: "hosting_account" | "website" | "database" | "server_config" | "panel";
        /** @description Đường dẫn tương đối với home account. */
        PathQuery: components["schemas"]["RelPath"];
        /** @description Hạn chữ ký (Unix giây). */
        Expires: number;
        /** @description Chữ ký HMAC của URL. */
        Signature: string;
        /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
        IdempotencyKey: string;
        /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
        IfMatch: string;
        /** @description UUID phiên upload. */
        UploadId: string;
        /** @description Vị trí chunk. */
        ContentRange: string;
        /** @description Lọc theo trạng thái job. */
        FilterState: components["schemas"]["JobState"];
        /** @description UUID domain. */
        DomainId: string;
        /** @description Loại log. */
        LogKind: "access" | "error";
        /** @description Số dòng cuối. */
        Lines: number;
    };
    requestBodies: never;
    headers: {
        /** @description Phiên bản tài nguyên (spec_version). */
        ETag: string;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getCaptcha: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "challenge": "v1.1763601300.4f9a2c.b1e0d7c3a95f4e21",
                     *         "difficulty": 12,
                     *         "expires_at": "2026-11-20T08:20:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["CaptchaChallenge"];
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
        };
    };
    getCsrfCookie: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            429: components["responses"]["TooManyRequests"];
        };
    };
    acceptImpersonation: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "ticket": "q7Yb2kV9xW4mN8pR3tL6sD1fG5hJ0aZcE2uI7oP9"
                 *     }
                 */
                "application/json": {
                    ticket: string;
                };
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "user": {
                     *           "uuid": "01938a01-0003-7000-8000-000001000003",
                     *           "realm": "portal",
                     *           "name": "Công ty An Phát",
                     *           "email": "it@anphat.vn",
                     *           "role": "USER",
                     *           "status": "active",
                     *           "mfa_enabled": true,
                     *           "locale": "vi",
                     *           "timezone": "Asia/Ho_Chi_Minh",
                     *           "last_login_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         "permissions": [
                     *           "own.*"
                     *         ],
                     *         "scopes": [],
                     *         "mfa_verified_at": "2026-11-20T08:15:00+07:00",
                     *         "impersonating": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         }
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Me"];
                    };
                };
            };
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    endImpersonation: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    login: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "email": "it@anphat.vn",
                 *       "password": "********",
                 *       "remember": false
                 *     }
                 */
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "mfa_required": true,
                     *         "mfa_methods": [
                     *           "totp",
                     *           "recovery"
                     *         ]
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["LoginResult"];
                    };
                };
            };
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    logout: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "user": {
                     *           "uuid": "01938a01-0003-7000-8000-000001000003",
                     *           "realm": "portal",
                     *           "name": "Công ty An Phát",
                     *           "email": "it@anphat.vn",
                     *           "role": "USER",
                     *           "status": "active",
                     *           "mfa_enabled": true,
                     *           "locale": "vi",
                     *           "timezone": "Asia/Ho_Chi_Minh",
                     *           "last_login_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         "permissions": [
                     *           "own.*"
                     *         ],
                     *         "scopes": [],
                     *         "mfa_verified_at": "2026-11-20T08:15:00+07:00",
                     *         "impersonating": null
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Me"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    confirmTotp: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "code": "730115",
                 *       "method": "totp"
                 *     }
                 */
                "application/json": components["schemas"]["MfaVerifyRequest"];
            };
        };
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    enrollTotp: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "secret": "JBSWY3DPEHPK3PXP",
                     *         "otpauth_uri": "otpauth://totp/ITSO:it%40anphat.vn?secret=JBSWY3DPEHPK3PXP&issuer=ITSO",
                     *         "recovery_codes": [
                     *           "k7f2m9q4x1",
                     *           "p3n8v6c2z5"
                     *         ]
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["TotpEnrollment"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    verifyMfa: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "code": "492817",
                 *       "method": "totp"
                 *     }
                 */
                "application/json": components["schemas"]["MfaVerifyRequest"];
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "user": {
                     *           "uuid": "01938a01-0003-7000-8000-000001000003",
                     *           "realm": "portal",
                     *           "name": "Công ty An Phát",
                     *           "email": "it@anphat.vn",
                     *           "role": "USER",
                     *           "status": "active",
                     *           "mfa_enabled": true,
                     *           "locale": "vi",
                     *           "timezone": "Asia/Ho_Chi_Minh",
                     *           "last_login_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         "permissions": [
                     *           "own.*"
                     *         ],
                     *         "scopes": [],
                     *         "mfa_verified_at": "2026-11-20T08:15:00+07:00",
                     *         "impersonating": null
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Me"];
                    };
                };
            };
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    changePassword: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "current_password": "********",
                 *       "new_password": "************"
                 *     }
                 */
                "application/json": components["schemas"]["PasswordChange"];
            };
        };
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    forgotPassword: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "email": "it@anphat.vn"
                 *     }
                 */
                "application/json": {
                    /** Format: email */
                    email: string;
                    captcha?: components["schemas"]["CaptchaSolution"];
                };
            };
        };
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    resetPassword: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "token": "8f1c2a7b9e3d4f6a0b5c8d2e7f1a3b6c9d0e4f7a",
                 *       "email": "it@anphat.vn",
                 *       "password": "************"
                 *     }
                 */
                "application/json": {
                    token: string;
                    /** Format: email */
                    email: string;
                    password: string;
                };
            };
        };
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listSessions: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a23-0001-7000-8000-000023000001",
                     *           "ip": "10.10.5.20",
                     *           "user_agent": "Firefox 132 / Ubuntu",
                     *           "current": true,
                     *           "last_active_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-20T08:15:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a23-0002-7000-8000-000023000002",
                     *           "ip": "10.10.5.31",
                     *           "user_agent": "Chrome 131 / Windows",
                     *           "current": false,
                     *           "last_active_at": "2026-11-19T14:05:00+07:00",
                     *           "created_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["Session"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    revokeSession: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    stepUp: {
        parameters: {
            query?: never;
            header?: {
                /** @description Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình host riêng (production), host quyết định và header bị bỏ qua (D-58). */
                "X-ITSO-Realm"?: components["parameters"]["Realm"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "code": "118204",
                 *       "method": "totp"
                 *     }
                 */
                "application/json": components["schemas"]["MfaVerifyRequest"];
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "user": {
                     *           "uuid": "01938a01-0003-7000-8000-000001000003",
                     *           "realm": "portal",
                     *           "name": "Công ty An Phát",
                     *           "email": "it@anphat.vn",
                     *           "role": "USER",
                     *           "status": "active",
                     *           "mfa_enabled": true,
                     *           "locale": "vi",
                     *           "timezone": "Asia/Ho_Chi_Minh",
                     *           "last_login_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         "permissions": [
                     *           "own.*"
                     *         ],
                     *         "scopes": [],
                     *         "mfa_verified_at": "2026-11-20T08:15:00+07:00",
                     *         "impersonating": null
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Me"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListBackupSnapshots: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
                /** @description Lọc theo loại backup. */
                "filter[scope_type]"?: components["parameters"]["FilterScopeType"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a0e-0001-7000-8000-00000e000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "destination": {
                     *             "uuid": "01938a17-0002-7000-8000-000017000002",
                     *             "name": "S3 Object Lock (offsite)"
                     *           },
                     *           "scope_type": "hosting_account",
                     *           "restic_snapshot_id": "4f2a9c1e",
                     *           "size_mb": 12800.4,
                     *           "taken_at": "2026-11-20T01:12:00+07:00",
                     *           "verified_at": "2026-11-20T03:00:00+07:00",
                     *           "contents": [
                     *             "files",
                     *             "databases",
                     *             "config"
                     *           ],
                     *           "tags": [
                     *             "daily"
                     *           ],
                     *           "website": null,
                     *           "panel_version": "0.1.0-alpha",
                     *           "repository_uuid": "01938a35-0001-7000-8000-000035000001",
                     *           "databases": [
                     *             "anphat_web",
                     *             "anphat_shop"
                     *           ],
                     *           "locked_until": "2026-12-20T01:12:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["BackupSnapshot"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalBrowseBackupSnapshot: {
        parameters: {
            query: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Đường dẫn tương đối với home account. */
                path: components["parameters"]["PathQuery"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "name": "public",
                     *           "path": "sites/anphat.vn/public",
                     *           "type": "dir",
                     *           "size": 4096,
                     *           "mode": "0750",
                     *           "owner": "anphat",
                     *           "modified_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "name": "index.php",
                     *           "path": "sites/anphat.vn/public/index.php",
                     *           "type": "file",
                     *           "size": 1734,
                     *           "mode": "0640",
                     *           "owner": "anphat",
                     *           "modified_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["FileEntry"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDownloadBackupFile: {
        parameters: {
            query: {
                /** @description Đường dẫn tương đối với home account. */
                path: components["parameters"]["PathQuery"];
                /** @description Hạn chữ ký (Unix giây). */
                expires: components["parameters"]["Expires"];
                /** @description Chữ ký HMAC của URL. */
                signature: components["parameters"]["Signature"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Nội dung file */
            200: {
                headers: {
                    /** @description attachment; filename=… */
                    "Content-Disposition"?: string;
                    [name: string]: unknown;
                };
                content: {
                    /** @example <?php … */
                    "application/octet-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            503: components["responses"]["AgentUnavailable"];
        };
    };
    portalBackupDownloadLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "path": "sites/anphat.vn/public/wp-config.php"
                 *     }
                 */
                "application/json": components["schemas"]["BackupDownloadRequest"];
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "url": "https://portal.itso.local/api/v1/portal/backup-snapshots/01938a0e-0001-7000-8000-00000e000001/raw?path=sites%2Fanphat.vn%2Fpublic%2Fwp-config.php&expires=1763605200&signature=abc",
                     *         "expires_at": "2026-11-20T09:15:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["SignedUrl"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateBackup: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "hosting_account_uuid": "01938a05-0001-7000-8000-000005000001",
                 *       "contents": [
                 *         "files",
                 *         "databases"
                 *       ],
                 *       "note": "Trước khi nâng cấp"
                 *     }
                 */
                "application/json": components["schemas"]["BackupRequest"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0148-7000-8000-00000f000148",
                     *         "type": "backup.run",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "hosting_account",
                     *           "uuid": "01938a05-0001-7000-8000-000005000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "backup.run",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "backup.check",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0148-7000-8000-00000f000148",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0148-7000-8000-00000f000148/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "hosting_account",
                     *         "uuid": "01938a05-0001-7000-8000-000005000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListCertificates: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a08-0001-7000-8000-000008000001",
                     *           "website": {
                     *             "uuid": "01938a06-0001-7000-8000-000006000001",
                     *             "primary_domain": "anphat.vn"
                     *           },
                     *           "source": "acme",
                     *           "domains": [
                     *             "anphat.vn",
                     *             "www.anphat.vn"
                     *           ],
                     *           "issuer": "Let's Encrypt R11",
                     *           "not_before": "2026-11-18T07:00:00+07:00",
                     *           "not_after": "2027-02-16T07:00:00+07:00",
                     *           "auto_renew": true,
                     *           "status": "valid",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["Certificate"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteCertificate: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0136-7000-8000-00000f000136",
                     *         "type": "certificate.delete",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "certificate",
                     *           "uuid": "01938a08-0001-7000-8000-000008000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "cert.remove",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0136-7000-8000-00000f000136",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0136-7000-8000-00000f000136/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "certificate",
                     *         "uuid": "01938a08-0001-7000-8000-000008000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRenewCertificate: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0135-7000-8000-00000f000135",
                     *         "type": "certificate.renew",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "certificate",
                     *           "uuid": "01938a08-0001-7000-8000-000008000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "cert.issue",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0135-7000-8000-00000f000135",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0135-7000-8000-00000f000135/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "certificate",
                     *         "uuid": "01938a08-0001-7000-8000-000008000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListCronJobs: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a0d-0001-7000-8000-00000d000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "website": {
                     *             "uuid": "01938a06-0001-7000-8000-000006000001",
                     *             "primary_domain": "anphat.vn"
                     *           },
                     *           "schedule": "*\/15 * * * *",
                     *           "command": "php artisan schedule:run",
                     *           "working_dir": "sites/anphat.vn",
                     *           "php_version": "8.3",
                     *           "enabled": true,
                     *           "timeout_sec": 3600,
                     *           "last_run_at": "2026-11-20T08:15:00+07:00",
                     *           "last_status": "succeeded",
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a0d-0002-7000-8000-00000d000002",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "website": {
                     *             "uuid": "01938a06-0002-7000-8000-000006000002",
                     *             "primary_domain": "shop.anphat.vn"
                     *           },
                     *           "schedule": "0 2 * * *",
                     *           "command": "php bin/cleanup.php",
                     *           "working_dir": "sites/shop.anphat.vn",
                     *           "php_version": "8.2",
                     *           "enabled": true,
                     *           "timeout_sec": 3600,
                     *           "last_run_at": "2026-11-20T02:00:00+07:00",
                     *           "last_status": "failed",
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a0d-0003-7000-8000-00000d000003",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0005-7000-8000-000005000005",
                     *             "username": "binhminh"
                     *           },
                     *           "website": null,
                     *           "schedule": "0 3 * * *",
                     *           "command": "php artisan backup:clean",
                     *           "working_dir": ".",
                     *           "php_version": "8.3",
                     *           "enabled": true,
                     *           "timeout_sec": 3600,
                     *           "last_run_at": "2026-11-20T03:00:00+07:00",
                     *           "last_status": "succeeded",
                     *           "status": "ready",
                     *           "spec_version": 1,
                     *           "observed_version": 1,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-12T09:10:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["CronJob"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateCronJob: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "hosting_account_uuid": "01938a05-0001-7000-8000-000005000001",
                 *       "website_uuid": "01938a06-0001-7000-8000-000006000001",
                 *       "schedule": "*\/15 * * * *",
                 *       "command": "php artisan schedule:run",
                 *       "working_dir": "sites/anphat.vn",
                 *       "php_version": "8.3",
                 *       "enabled": true
                 *     }
                 */
                "application/json": components["schemas"]["CronJobCreate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0144-7000-8000-00000f000144",
                     *         "type": "cron.create",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "cron_job",
                     *           "uuid": "01938a0d-0001-7000-8000-00000d000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "cron.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0144-7000-8000-00000f000144",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0144-7000-8000-00000f000144/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "cron_job",
                     *         "uuid": "01938a0d-0001-7000-8000-00000d000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteCronJob: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0146-7000-8000-00000f000146",
                     *         "type": "cron.delete",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "cron_job",
                     *           "uuid": "01938a0d-0001-7000-8000-00000d000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "cron.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0146-7000-8000-00000f000146",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0146-7000-8000-00000f000146/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "cron_job",
                     *         "uuid": "01938a0d-0001-7000-8000-00000d000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalUpdateCronJob: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
                "If-Match"?: components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "enabled": false
                 *     }
                 */
                "application/json": components["schemas"]["CronJobUpdate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0145-7000-8000-00000f000145",
                     *         "type": "cron.update",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "cron_job",
                     *           "uuid": "01938a0d-0001-7000-8000-00000d000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "cron.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0145-7000-8000-00000f000145",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0145-7000-8000-00000f000145/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "cron_job",
                     *         "uuid": "01938a0d-0001-7000-8000-00000d000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListCronRuns: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a28-0001-7000-8000-000028000001",
                     *           "started_at": "2026-11-20T08:15:00+07:00",
                     *           "finished_at": "2026-11-20T08:15:03+07:00",
                     *           "exit_code": 0,
                     *           "status": "succeeded",
                     *           "output_tail": "Running scheduled command: emails:send"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["CronRun"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRunCronJob: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0147-7000-8000-00000f000147",
                     *         "type": "cron.run",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "cron_job",
                     *           "uuid": "01938a0d-0001-7000-8000-00000d000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "cron.run_once",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0147-7000-8000-00000f000147",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0147-7000-8000-00000f000147/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "cron_job",
                     *         "uuid": "01938a0d-0001-7000-8000-00000d000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListDatabaseUsers: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a0a-0001-7000-8000-00000a000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "engine": "mariadb",
                     *           "username": "anphat_web",
                     *           "host": "localhost",
                     *           "max_connections": 10,
                     *           "grants": [
                     *             {
                     *               "database": "anphat_web",
                     *               "privileges": [
                     *                 "ALL"
                     *               ]
                     *             }
                     *           ],
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a0a-0002-7000-8000-00000a000002",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "engine": "mariadb",
                     *           "username": "anphat_shop",
                     *           "host": "localhost",
                     *           "max_connections": 10,
                     *           "grants": [
                     *             {
                     *               "database": "anphat_shop",
                     *               "privileges": [
                     *                 "SELECT",
                     *                 "INSERT",
                     *                 "UPDATE",
                     *                 "DELETE"
                     *               ]
                     *             }
                     *           ],
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a0a-0003-7000-8000-00000a000003",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0005-7000-8000-000005000005",
                     *             "username": "binhminh"
                     *           },
                     *           "engine": "mariadb",
                     *           "username": "binhminh_web",
                     *           "host": "localhost",
                     *           "max_connections": 10,
                     *           "grants": [
                     *             {
                     *               "database": "binhminh_web",
                     *               "privileges": [
                     *                 "ALL"
                     *               ]
                     *             }
                     *           ],
                     *           "status": "ready",
                     *           "spec_version": 1,
                     *           "observed_version": 1,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-12T09:10:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["DatabaseUser"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateDatabaseUser: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "hosting_account_uuid": "01938a05-0001-7000-8000-000005000001",
                 *       "engine": "mariadb",
                 *       "username": "anphat_report"
                 *     }
                 */
                "application/json": components["schemas"]["DatabaseUserCreate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-013b-7000-8000-00000f00013b",
                     *         "type": "database_user.create",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "database_user",
                     *           "uuid": "01938a0a-0001-7000-8000-00000a000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "db.mysql.user_ensure",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-013b-7000-8000-00000f00013b",
                     *           "events": "/api/v1/portal/jobs/01938a0f-013b-7000-8000-00000f00013b/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "database_user",
                     *         "uuid": "01938a0a-0001-7000-8000-00000a000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteDatabaseUser: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-013c-7000-8000-00000f00013c",
                     *         "type": "database_user.delete",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "database_user",
                     *           "uuid": "01938a0a-0001-7000-8000-00000a000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "db.mysql.user_drop",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-013c-7000-8000-00000f00013c",
                     *           "events": "/api/v1/portal/jobs/01938a0f-013c-7000-8000-00000f00013c/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "database_user",
                     *         "uuid": "01938a0a-0001-7000-8000-00000a000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalSetDatabaseUserGrants: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "grants": [
                 *         {
                 *           "database": "anphat_web",
                 *           "privileges": [
                 *             "SELECT"
                 *           ]
                 *         }
                 *       ]
                 *     }
                 */
                "application/json": {
                    grants: components["schemas"]["DatabaseGrant"][];
                };
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-013d-7000-8000-00000f00013d",
                     *         "type": "database_user.grant",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "database_user",
                     *           "uuid": "01938a0a-0001-7000-8000-00000a000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "db.mysql.grant",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-013d-7000-8000-00000f00013d",
                     *           "events": "/api/v1/portal/jobs/01938a0f-013d-7000-8000-00000f00013d/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "database_user",
                     *         "uuid": "01938a0a-0001-7000-8000-00000a000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRotateDatabaseUserPassword: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "secret": "q8V!r2#Lm9@xT4zK7pW1"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["SecretOnce"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListDatabases: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a09-0001-7000-8000-000009000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "engine": "mariadb",
                     *           "name": "anphat_web",
                     *           "size_mb": 412.5,
                     *           "charset": "utf8mb4",
                     *           "users": [
                     *             "anphat_web"
                     *           ],
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a09-0002-7000-8000-000009000002",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "engine": "mariadb",
                     *           "name": "anphat_shop",
                     *           "size_mb": 1280,
                     *           "charset": "utf8mb4",
                     *           "users": [
                     *             "anphat_shop"
                     *           ],
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["Database"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateDatabase: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "hosting_account_uuid": "01938a05-0001-7000-8000-000005000001",
                 *       "engine": "mariadb",
                 *       "name": "anphat_crm",
                 *       "create_user": true
                 *     }
                 */
                "application/json": components["schemas"]["DatabaseCreate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0137-7000-8000-00000f000137",
                     *         "type": "database.create",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "database",
                     *           "uuid": "01938a09-0001-7000-8000-000009000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "db.mysql.create",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "db.mysql.user_ensure",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 3,
                     *             "op": "db.mysql.grant",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0137-7000-8000-00000f000137",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0137-7000-8000-00000f000137/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "database",
                     *         "uuid": "01938a09-0001-7000-8000-000009000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetDatabase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a09-0001-7000-8000-000009000001",
                     *         "hosting_account": {
                     *           "uuid": "01938a05-0001-7000-8000-000005000001",
                     *           "username": "anphat"
                     *         },
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "engine": "mariadb",
                     *         "name": "anphat_web",
                     *         "size_mb": 412.5,
                     *         "charset": "utf8mb4",
                     *         "users": [
                     *           "anphat_web"
                     *         ],
                     *         "status": "ready",
                     *         "spec_version": 3,
                     *         "observed_version": 3,
                     *         "drift": null,
                     *         "observed_at": "2026-11-20T08:15:00+07:00",
                     *         "created_at": "2026-11-18T09:30:00+07:00",
                     *         "updated_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Database"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteDatabase: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0138-7000-8000-00000f000138",
                     *         "type": "database.delete",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "database",
                     *           "uuid": "01938a09-0001-7000-8000-000009000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "db.mysql.dump",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "db.mysql.drop",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0138-7000-8000-00000f000138",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0138-7000-8000-00000f000138/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "database",
                     *         "uuid": "01938a09-0001-7000-8000-000009000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalExportDatabase: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0139-7000-8000-00000f000139",
                     *         "type": "database.export",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "database",
                     *           "uuid": "01938a09-0001-7000-8000-000009000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "db.mysql.dump",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0139-7000-8000-00000f000139",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0139-7000-8000-00000f000139/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "database",
                     *         "uuid": "01938a09-0001-7000-8000-000009000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalImportDatabase: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "path": "backups/anphat_web.sql.gz"
                 *     }
                 */
                "application/json": {
                    path: components["schemas"]["RelPath"];
                };
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-013a-7000-8000-00000f00013a",
                     *         "type": "database.import",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "database",
                     *           "uuid": "01938a09-0001-7000-8000-000009000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "db.mysql.import",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-013a-7000-8000-00000f00013a",
                     *           "events": "/api/v1/portal/jobs/01938a0f-013a-7000-8000-00000f00013a/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "database",
                     *         "uuid": "01938a09-0001-7000-8000-000009000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRollbackGitDeployment: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-014f-7000-8000-00000f00014f",
                     *         "type": "git.rollback",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "git_repository",
                     *           "uuid": "01938a2e-0001-7000-8000-00002e000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "git.rollback",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-014f-7000-8000-00000f00014f",
                     *           "events": "/api/v1/portal/jobs/01938a0f-014f-7000-8000-00000f00014f/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "git_repository",
                     *         "uuid": "01938a2e-0001-7000-8000-00002e000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListGitRepositories: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a2e-0001-7000-8000-00002e000001",
                     *           "website": {
                     *             "uuid": "01938a06-0001-7000-8000-000006000001",
                     *             "primary_domain": "anphat.vn"
                     *           },
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "repo_url": "git@github.com:anphat-it/website.git",
                     *           "branch": "main",
                     *           "deploy_key_public": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK7dpL itso-deploy-anphat.vn",
                     *           "deploy_key_fingerprint": "SHA256:Qm3v8bK0yX2nV1pL5sT7wR9zA4cE6gH8jM0oP2qS4uW",
                     *           "webhook_url": "https://panel.itso.local/api/v1/hooks/git/gh_7c1f0a9d2e",
                     *           "auto_deploy": true,
                     *           "build_command": "composer install --no-dev --optimize-autoloader",
                     *           "shared_paths": [
                     *             ".env",
                     *             "storage"
                     *           ],
                     *           "keep_releases": 5,
                     *           "current_deployment": {
                     *             "uuid": "01938a2f-0002-7000-8000-00002f000002",
                     *             "commit_sha": "5d0b7f3",
                     *             "finished_at": "2026-11-19T15:40:48+07:00"
                     *           },
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["GitRepository"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateGitRepository: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "website_uuid": "01938a06-0002-7000-8000-000006000002",
                 *       "repo_url": "git@github.com:anphat-it/shop.git",
                 *       "branch": "main",
                 *       "auto_deploy": false,
                 *       "build_command": null,
                 *       "shared_paths": [
                 *         ".env"
                 *       ],
                 *       "keep_releases": 5
                 *     }
                 */
                "application/json": components["schemas"]["GitRepositoryCreate"];
            };
        };
        responses: {
            /** @description Đã tạo */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a2e-0001-7000-8000-00002e000001",
                     *         "website": {
                     *           "uuid": "01938a06-0001-7000-8000-000006000001",
                     *           "primary_domain": "anphat.vn"
                     *         },
                     *         "hosting_account": {
                     *           "uuid": "01938a05-0001-7000-8000-000005000001",
                     *           "username": "anphat"
                     *         },
                     *         "repo_url": "git@github.com:anphat-it/website.git",
                     *         "branch": "main",
                     *         "deploy_key_public": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK7dpL itso-deploy-anphat.vn",
                     *         "deploy_key_fingerprint": "SHA256:Qm3v8bK0yX2nV1pL5sT7wR9zA4cE6gH8jM0oP2qS4uW",
                     *         "webhook_url": "https://panel.itso.local/api/v1/hooks/git/gh_7c1f0a9d2e",
                     *         "auto_deploy": true,
                     *         "build_command": "composer install --no-dev --optimize-autoloader",
                     *         "shared_paths": [
                     *           ".env",
                     *           "storage"
                     *         ],
                     *         "keep_releases": 5,
                     *         "current_deployment": {
                     *           "uuid": "01938a2f-0002-7000-8000-00002f000002",
                     *           "commit_sha": "5d0b7f3",
                     *           "finished_at": "2026-11-19T15:40:48+07:00"
                     *         },
                     *         "status": "ready",
                     *         "spec_version": 3,
                     *         "observed_version": 3,
                     *         "drift": null,
                     *         "observed_at": "2026-11-20T08:15:00+07:00",
                     *         "created_at": "2026-11-18T09:30:00+07:00",
                     *         "updated_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["GitRepository"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetGitRepository: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a2e-0001-7000-8000-00002e000001",
                     *         "website": {
                     *           "uuid": "01938a06-0001-7000-8000-000006000001",
                     *           "primary_domain": "anphat.vn"
                     *         },
                     *         "hosting_account": {
                     *           "uuid": "01938a05-0001-7000-8000-000005000001",
                     *           "username": "anphat"
                     *         },
                     *         "repo_url": "git@github.com:anphat-it/website.git",
                     *         "branch": "main",
                     *         "deploy_key_public": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK7dpL itso-deploy-anphat.vn",
                     *         "deploy_key_fingerprint": "SHA256:Qm3v8bK0yX2nV1pL5sT7wR9zA4cE6gH8jM0oP2qS4uW",
                     *         "webhook_url": "https://panel.itso.local/api/v1/hooks/git/gh_7c1f0a9d2e",
                     *         "auto_deploy": true,
                     *         "build_command": "composer install --no-dev --optimize-autoloader",
                     *         "shared_paths": [
                     *           ".env",
                     *           "storage"
                     *         ],
                     *         "keep_releases": 5,
                     *         "current_deployment": {
                     *           "uuid": "01938a2f-0002-7000-8000-00002f000002",
                     *           "commit_sha": "5d0b7f3",
                     *           "finished_at": "2026-11-19T15:40:48+07:00"
                     *         },
                     *         "status": "ready",
                     *         "spec_version": 3,
                     *         "observed_version": 3,
                     *         "drift": null,
                     *         "observed_at": "2026-11-20T08:15:00+07:00",
                     *         "created_at": "2026-11-18T09:30:00+07:00",
                     *         "updated_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["GitRepository"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteGitRepository: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalUpdateGitRepository: {
        parameters: {
            query?: never;
            header?: {
                /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
                "If-Match"?: components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "auto_deploy": false
                 *     }
                 */
                "application/json": components["schemas"]["GitRepositoryUpdate"];
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a2e-0001-7000-8000-00002e000001",
                     *         "website": {
                     *           "uuid": "01938a06-0001-7000-8000-000006000001",
                     *           "primary_domain": "anphat.vn"
                     *         },
                     *         "hosting_account": {
                     *           "uuid": "01938a05-0001-7000-8000-000005000001",
                     *           "username": "anphat"
                     *         },
                     *         "repo_url": "git@github.com:anphat-it/website.git",
                     *         "branch": "main",
                     *         "deploy_key_public": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK7dpL itso-deploy-anphat.vn",
                     *         "deploy_key_fingerprint": "SHA256:Qm3v8bK0yX2nV1pL5sT7wR9zA4cE6gH8jM0oP2qS4uW",
                     *         "webhook_url": "https://panel.itso.local/api/v1/hooks/git/gh_7c1f0a9d2e",
                     *         "auto_deploy": false,
                     *         "build_command": "composer install --no-dev --optimize-autoloader",
                     *         "shared_paths": [
                     *           ".env",
                     *           "storage"
                     *         ],
                     *         "keep_releases": 5,
                     *         "current_deployment": {
                     *           "uuid": "01938a2f-0002-7000-8000-00002f000002",
                     *           "commit_sha": "5d0b7f3",
                     *           "finished_at": "2026-11-19T15:40:48+07:00"
                     *         },
                     *         "status": "ready",
                     *         "spec_version": 3,
                     *         "observed_version": 3,
                     *         "drift": null,
                     *         "observed_at": "2026-11-20T08:15:00+07:00",
                     *         "created_at": "2026-11-18T09:30:00+07:00",
                     *         "updated_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["GitRepository"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListGitDeployments: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a2f-0001-7000-8000-00002f000001",
                     *           "repository_uuid": "01938a2e-0001-7000-8000-00002e000001",
                     *           "commit_sha": "a41c9e2",
                     *           "commit_message": "Trang liên hệ mới",
                     *           "commit_author": "Nguyễn Văn Bảo",
                     *           "trigger": "manual",
                     *           "state": "succeeded",
                     *           "release_path": "sites/anphat.vn/releases/202611171012",
                     *           "rollback_of": null,
                     *           "job_uuid": null,
                     *           "requested_by": {
                     *             "uuid": "01938a01-0001-7000-8000-000001000001",
                     *             "name": "Quản trị hệ thống",
                     *             "email": "superadmin@itso.local"
                     *           },
                     *           "started_at": "2026-11-17T10:12:00+07:00",
                     *           "finished_at": "2026-11-17T10:12:48+07:00",
                     *           "created_at": "2026-11-17T10:12:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a2f-0002-7000-8000-00002f000002",
                     *           "repository_uuid": "01938a2e-0001-7000-8000-00002e000001",
                     *           "commit_sha": "5d0b7f3",
                     *           "commit_message": "Sửa lỗi form đặt hàng",
                     *           "commit_author": "Nguyễn Văn Bảo",
                     *           "trigger": "webhook",
                     *           "state": "succeeded",
                     *           "release_path": "sites/anphat.vn/releases/202611191540",
                     *           "rollback_of": null,
                     *           "job_uuid": null,
                     *           "requested_by": null,
                     *           "started_at": "2026-11-19T15:40:00+07:00",
                     *           "finished_at": "2026-11-19T15:40:48+07:00",
                     *           "created_at": "2026-11-19T15:40:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["GitDeployment"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateGitDeployment: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "commit_sha": null
                 *     }
                 */
                "application/json": components["schemas"]["GitDeployRequest"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-014e-7000-8000-00000f00014e",
                     *         "type": "git.deploy",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "git_repository",
                     *           "uuid": "01938a2e-0001-7000-8000-00002e000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "git.deploy",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-014e-7000-8000-00000f00014e",
                     *           "events": "/api/v1/portal/jobs/01938a0f-014e-7000-8000-00000f00014e/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "git_repository",
                     *         "uuid": "01938a2e-0001-7000-8000-00002e000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRotateGitWebhookSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "secret": "whsec_4Tq9mZ2vL8xR1nB6"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["SecretOnce"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListHostingAccounts: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a05-0001-7000-8000-000005000001",
                     *           "username": "anphat",
                     *           "server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "package": {
                     *             "uuid": "01938a03-0002-7000-8000-000003000002",
                     *             "code": "business",
                     *             "name": "Business",
                     *             "version": 1
                     *           },
                     *           "owner": {
                     *             "uuid": "01938a01-0003-7000-8000-000001000003",
                     *             "name": "Công ty An Phát",
                     *             "email": "it@anphat.vn"
                     *           },
                     *           "uid": 20001,
                     *           "home_path": "/home/anphat",
                     *           "lifecycle_state": "active",
                     *           "suspended_reason": null,
                     *           "terminated_at": null,
                     *           "purge_after": null,
                     *           "legal_hold": false,
                     *           "usage": {
                     *             "disk_mb": {
                     *               "used": 8420,
                     *               "limit": 20480
                     *             },
                     *             "inodes": {
                     *               "used": 120400,
                     *               "limit": 400000
                     *             },
                     *             "cpu_percent": {
                     *               "used": 35,
                     *               "limit": 200
                     *             },
                     *             "ram_mb": {
                     *               "used": 1830,
                     *               "limit": 4096
                     *             },
                     *             "websites": {
                     *               "used": 2,
                     *               "limit": 10
                     *             },
                     *             "databases": {
                     *               "used": 2,
                     *               "limit": 10
                     *             },
                     *             "ftp_accounts": {
                     *               "used": 2,
                     *               "limit": 5
                     *             },
                     *             "cron_jobs": {
                     *               "used": 2,
                     *               "limit": 10
                     *             },
                     *             "backup_mb": {
                     *               "used": 12800,
                     *               "limit": 40960
                     *             },
                     *             "bandwidth_mb_30d": 48213,
                     *             "measured_at": "2026-11-20T08:15:00+07:00"
                     *           },
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["HostingAccount"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetHostingAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a05-0001-7000-8000-000005000001",
                     *         "username": "anphat",
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "package": {
                     *           "uuid": "01938a03-0002-7000-8000-000003000002",
                     *           "code": "business",
                     *           "name": "Business",
                     *           "version": 1
                     *         },
                     *         "owner": {
                     *           "uuid": "01938a01-0003-7000-8000-000001000003",
                     *           "name": "Công ty An Phát",
                     *           "email": "it@anphat.vn"
                     *         },
                     *         "uid": 20001,
                     *         "home_path": "/home/anphat",
                     *         "lifecycle_state": "active",
                     *         "suspended_reason": null,
                     *         "terminated_at": null,
                     *         "purge_after": null,
                     *         "legal_hold": false,
                     *         "usage": {
                     *           "disk_mb": {
                     *             "used": 8420,
                     *             "limit": 20480
                     *           },
                     *           "inodes": {
                     *             "used": 120400,
                     *             "limit": 400000
                     *           },
                     *           "cpu_percent": {
                     *             "used": 35,
                     *             "limit": 200
                     *           },
                     *           "ram_mb": {
                     *             "used": 1830,
                     *             "limit": 4096
                     *           },
                     *           "websites": {
                     *             "used": 2,
                     *             "limit": 10
                     *           },
                     *           "databases": {
                     *             "used": 2,
                     *             "limit": 10
                     *           },
                     *           "ftp_accounts": {
                     *             "used": 2,
                     *             "limit": 5
                     *           },
                     *           "cron_jobs": {
                     *             "used": 2,
                     *             "limit": 10
                     *           },
                     *           "backup_mb": {
                     *             "used": 12800,
                     *             "limit": 40960
                     *           },
                     *           "bandwidth_mb_30d": 48213,
                     *           "measured_at": "2026-11-20T08:15:00+07:00"
                     *         },
                     *         "status": "ready",
                     *         "spec_version": 3,
                     *         "observed_version": 3,
                     *         "drift": null,
                     *         "observed_at": "2026-11-20T08:15:00+07:00",
                     *         "created_at": "2026-11-18T09:30:00+07:00",
                     *         "updated_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["HostingAccount"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetHostingAccountFeatures: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "package": {
                     *           "uuid": "01938a03-0002-7000-8000-000003000002",
                     *           "code": "business",
                     *           "name": "Business",
                     *           "version": 1
                     *         },
                     *         "php_versions": [
                     *           "8.1",
                     *           "8.2",
                     *           "8.3"
                     *         ],
                     *         "php_workers_max": 10,
                     *         "ssh_allowed": true,
                     *         "cron_min_interval_min": 5,
                     *         "backup_quota_mb": 40960,
                     *         "backup_retention": {
                     *           "daily": 7,
                     *           "weekly": 4,
                     *           "monthly": 3
                     *         }
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["AccountFeatures"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListFiles: {
        parameters: {
            query: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Đường dẫn tương đối với home account. */
                path: components["parameters"]["PathQuery"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "name": "public",
                     *           "path": "sites/anphat.vn/public",
                     *           "type": "dir",
                     *           "size": 4096,
                     *           "mode": "0750",
                     *           "owner": "anphat",
                     *           "modified_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "name": "index.php",
                     *           "path": "sites/anphat.vn/public/index.php",
                     *           "type": "file",
                     *           "size": 1734,
                     *           "mode": "0640",
                     *           "owner": "anphat",
                     *           "modified_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "name": ".env",
                     *           "path": "sites/anphat.vn/.env",
                     *           "type": "file",
                     *           "size": 912,
                     *           "mode": "0600",
                     *           "owner": "anphat",
                     *           "modified_at": "2026-11-18T09:30:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["FileEntry"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
            503: components["responses"]["AgentUnavailable"];
        };
    };
    portalReadFile: {
        parameters: {
            query: {
                /** @description Đường dẫn tương đối với home account. */
                path: components["parameters"]["PathQuery"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "path": "sites/anphat.vn/public/index.php",
                     *         "content": "<?php\nrequire __DIR__.'/../bootstrap/app.php';\n",
                     *         "encoding": "utf-8",
                     *         "etag": "\"a1b2c3\""
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["FileContent"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
            503: components["responses"]["AgentUnavailable"];
        };
    };
    portalWriteFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "path": "sites/anphat.vn/public/robots.txt",
                 *       "content": "User-agent: *\nDisallow:\n",
                 *       "encoding": "utf-8",
                 *       "if_etag": null
                 *     }
                 */
                "application/json": components["schemas"]["FileWrite"];
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "name": "index.php",
                     *         "path": "sites/anphat.vn/public/index.php",
                     *         "type": "file",
                     *         "size": 1734,
                     *         "mode": "0640",
                     *         "owner": "anphat",
                     *         "modified_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["FileEntry"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
            503: components["responses"]["AgentUnavailable"];
        };
    };
    portalDownloadLink: {
        parameters: {
            query: {
                /** @description Đường dẫn tương đối với home account. */
                path: components["parameters"]["PathQuery"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "url": "https://portal.itso.local/dl/eyJwIjoic2l0ZXMvYW5waGF0LnZuIn0.sig",
                     *         "expires_at": "2026-11-20T08:20:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["SignedUrl"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDownloadFile: {
        parameters: {
            query: {
                /** @description Đường dẫn tương đối với home account. */
                path: components["parameters"]["PathQuery"];
                /** @description Hạn chữ ký (Unix giây). */
                expires: components["parameters"]["Expires"];
                /** @description Chữ ký HMAC của URL. */
                signature: components["parameters"]["Signature"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Nội dung file */
            200: {
                headers: {
                    /** @description attachment; filename=… */
                    "Content-Disposition"?: string;
                    [name: string]: unknown;
                };
                content: {
                    /** @example %PDF-1.7 … */
                    "application/octet-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            503: components["responses"]["AgentUnavailable"];
        };
    };
    portalCreateUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "path": "sites/anphat.vn/public/brochure.pdf",
                 *       "size": 5242880,
                 *       "overwrite": false
                 *     }
                 */
                "application/json": components["schemas"]["UploadCreate"];
            };
        };
        responses: {
            /** @description Đã tạo */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a25-0001-7000-8000-000025000001",
                     *         "path": "sites/anphat.vn/public/brochure.pdf",
                     *         "size": 5242880,
                     *         "chunk_size": 8388608,
                     *         "received": 0,
                     *         "expires_at": "2026-11-20T09:15:00+07:00",
                     *         "status": "receiving",
                     *         "job_uuid": null
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["UploadSession"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
                /** @description UUID phiên upload. */
                upload: components["parameters"]["UploadId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a25-0001-7000-8000-000025000001",
                     *         "path": "sites/anphat.vn/public/brochure.pdf",
                     *         "size": 5242880,
                     *         "chunk_size": 8388608,
                     *         "received": 3145728,
                     *         "expires_at": "2026-11-20T09:15:00+07:00",
                     *         "status": "receiving",
                     *         "job_uuid": null
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["UploadSession"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCancelUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
                /** @description UUID phiên upload. */
                upload: components["parameters"]["UploadId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalUploadChunk: {
        parameters: {
            query?: never;
            header: {
                /** @description Vị trí chunk. */
                "Content-Range": components["parameters"]["ContentRange"];
                /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
                "If-Match"?: components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
                /** @description UUID phiên upload. */
                upload: components["parameters"]["UploadId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/octet-stream": string;
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a25-0001-7000-8000-000025000001",
                     *         "path": "sites/anphat.vn/public/brochure.pdf",
                     *         "size": 5242880,
                     *         "chunk_size": 8388608,
                     *         "received": 1048576,
                     *         "expires_at": "2026-11-20T09:15:00+07:00",
                     *         "status": "receiving",
                     *         "job_uuid": null
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["UploadSession"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalOperateFiles: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "op": "compress",
                 *       "paths": [
                 *         "sites/anphat.vn/public"
                 *       ],
                 *       "target": "backups/public.zip",
                 *       "mode": null,
                 *       "format": "zip"
                 *     }
                 */
                "application/json": components["schemas"]["FileOperation"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-013e-7000-8000-00000f00013e",
                     *         "type": "file.operate",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "hosting_account",
                     *           "uuid": "01938a05-0001-7000-8000-000005000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "fs.archive",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-013e-7000-8000-00000f00013e",
                     *           "events": "/api/v1/portal/jobs/01938a0f-013e-7000-8000-00000f00013e/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "hosting_account",
                     *         "uuid": "01938a05-0001-7000-8000-000005000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalScanAccount: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0151-7000-8000-00000f000151",
                     *         "type": "malware.scan",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "hosting_account",
                     *           "uuid": "01938a05-0001-7000-8000-000005000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "malware.scan",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/admin/jobs/01938a0f-0151-7000-8000-00000f000151",
                     *           "events": "/api/v1/admin/jobs/01938a0f-0151-7000-8000-00000f000151/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "hosting_account",
                     *         "uuid": "01938a05-0001-7000-8000-000005000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetHostingAccountUsage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "disk_mb": {
                     *           "used": 8420,
                     *           "limit": 20480
                     *         },
                     *         "inodes": {
                     *           "used": 120400,
                     *           "limit": 400000
                     *         },
                     *         "cpu_percent": {
                     *           "used": 35,
                     *           "limit": 200
                     *         },
                     *         "ram_mb": {
                     *           "used": 1830,
                     *           "limit": 4096
                     *         },
                     *         "websites": {
                     *           "used": 2,
                     *           "limit": 10
                     *         },
                     *         "databases": {
                     *           "used": 2,
                     *           "limit": 10
                     *         },
                     *         "ftp_accounts": {
                     *           "used": 2,
                     *           "limit": 5
                     *         },
                     *         "cron_jobs": {
                     *           "used": 2,
                     *           "limit": 10
                     *         },
                     *         "backup_mb": {
                     *           "used": 12800,
                     *           "limit": 40960
                     *         },
                     *         "bandwidth_mb_30d": 48213,
                     *         "measured_at": "2026-11-20T08:15:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Usage"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListJobs: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo trạng thái job. */
                "filter[state]"?: components["parameters"]["FilterState"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a0f-0001-7000-8000-00000f000001",
                     *           "type": "hosting_account.create",
                     *           "state": "succeeded",
                     *           "progress": 100,
                     *           "resource": {
                     *             "type": "hosting_account",
                     *             "uuid": "01938a05-0001-7000-8000-000005000001"
                     *           },
                     *           "steps": [
                     *             {
                     *               "seq": 1,
                     *               "op": "account.ensure",
                     *               "state": "succeeded",
                     *               "started_at": "2026-11-18T09:30:00+07:00",
                     *               "finished_at": "2026-11-18T09:30:00+07:00"
                     *             },
                     *             {
                     *               "seq": 2,
                     *               "op": "quota.apply",
                     *               "state": "succeeded",
                     *               "started_at": "2026-11-18T09:30:00+07:00",
                     *               "finished_at": "2026-11-18T09:30:00+07:00"
                     *             },
                     *             {
                     *               "seq": 3,
                     *               "op": "php.pool.apply",
                     *               "state": "succeeded",
                     *               "started_at": "2026-11-18T09:30:00+07:00",
                     *               "finished_at": "2026-11-18T09:30:00+07:00"
                     *             }
                     *           ],
                     *           "attempts": 1,
                     *           "max_attempts": 3,
                     *           "timeout_sec": 600,
                     *           "error": null,
                     *           "server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "requested_by": {
                     *             "uuid": "01938a01-0001-7000-8000-000001000001",
                     *             "name": "Quản trị hệ thống",
                     *             "email": "superadmin@itso.local"
                     *           },
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "started_at": "2026-11-18T09:30:00+07:00",
                     *           "finished_at": "2026-11-18T09:30:00+07:00",
                     *           "links": {
                     *             "self": "/api/v1/portal/jobs/01938a0f-0001-7000-8000-00000f000001",
                     *             "events": "/api/v1/portal/jobs/01938a0f-0001-7000-8000-00000f000001/events"
                     *           }
                     *         },
                     *         {
                     *           "uuid": "01938a0f-0002-7000-8000-00000f000002",
                     *           "type": "website.create",
                     *           "state": "running",
                     *           "progress": 60,
                     *           "resource": {
                     *             "type": "website",
                     *             "uuid": "01938a06-0002-7000-8000-000006000002"
                     *           },
                     *           "steps": [
                     *             {
                     *               "seq": 1,
                     *               "op": "fs.site_layout.ensure",
                     *               "state": "succeeded",
                     *               "started_at": "2026-11-20T08:15:00+07:00",
                     *               "finished_at": "2026-11-20T08:15:00+07:00"
                     *             },
                     *             {
                     *               "seq": 2,
                     *               "op": "php.pool.apply",
                     *               "state": "succeeded",
                     *               "started_at": "2026-11-20T08:15:00+07:00",
                     *               "finished_at": "2026-11-20T08:15:00+07:00"
                     *             },
                     *             {
                     *               "seq": 3,
                     *               "op": "nginx.vhost.apply",
                     *               "state": "running",
                     *               "started_at": "2026-11-20T08:15:00+07:00",
                     *               "finished_at": null
                     *             },
                     *             {
                     *               "seq": 4,
                     *               "op": "cert.issue",
                     *               "state": "pending",
                     *               "started_at": null,
                     *               "finished_at": null
                     *             }
                     *           ],
                     *           "attempts": 1,
                     *           "max_attempts": 3,
                     *           "timeout_sec": 600,
                     *           "error": null,
                     *           "server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "requested_by": {
                     *             "uuid": "01938a01-0003-7000-8000-000001000003",
                     *             "name": "Công ty An Phát",
                     *             "email": "it@anphat.vn"
                     *           },
                     *           "created_at": "2026-11-20T08:15:00+07:00",
                     *           "started_at": "2026-11-20T08:15:00+07:00",
                     *           "finished_at": null,
                     *           "links": {
                     *             "self": "/api/v1/portal/jobs/01938a0f-0002-7000-8000-00000f000002",
                     *             "events": "/api/v1/portal/jobs/01938a0f-0002-7000-8000-00000f000002/events"
                     *           }
                     *         },
                     *         {
                     *           "uuid": "01938a0f-0005-7000-8000-00000f000005",
                     *           "type": "hosting_account.create",
                     *           "state": "running",
                     *           "progress": 40,
                     *           "resource": {
                     *             "type": "hosting_account",
                     *             "uuid": "01938a05-000c-7000-8000-00000500000c"
                     *           },
                     *           "steps": [
                     *             {
                     *               "seq": 1,
                     *               "op": "account.ensure",
                     *               "state": "succeeded",
                     *               "started_at": "2026-11-20T08:15:00+07:00",
                     *               "finished_at": "2026-11-20T08:15:00+07:00"
                     *             },
                     *             {
                     *               "seq": 2,
                     *               "op": "quota.apply",
                     *               "state": "running",
                     *               "started_at": "2026-11-20T08:15:00+07:00",
                     *               "finished_at": null
                     *             },
                     *             {
                     *               "seq": 3,
                     *               "op": "php.pool.apply",
                     *               "state": "pending",
                     *               "started_at": null,
                     *               "finished_at": null
                     *             }
                     *           ],
                     *           "attempts": 1,
                     *           "max_attempts": 3,
                     *           "timeout_sec": 600,
                     *           "error": null,
                     *           "server": {
                     *             "uuid": "01938a02-0002-7000-8000-000002000002",
                     *             "name": "srv-hn-02"
                     *           },
                     *           "requested_by": {
                     *             "uuid": "01938a01-0001-7000-8000-000001000001",
                     *             "name": "Quản trị hệ thống",
                     *             "email": "superadmin@itso.local"
                     *           },
                     *           "created_at": "2026-11-20T08:15:00+07:00",
                     *           "started_at": "2026-11-20T08:15:00+07:00",
                     *           "finished_at": null,
                     *           "links": {
                     *             "self": "/api/v1/portal/jobs/01938a0f-0005-7000-8000-00000f000005",
                     *             "events": "/api/v1/portal/jobs/01938a0f-0005-7000-8000-00000f000005/events"
                     *           }
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["Job"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a0f-0002-7000-8000-00000f000002",
                     *         "type": "website.create",
                     *         "state": "running",
                     *         "progress": 60,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0002-7000-8000-000006000002"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "fs.site_layout.ensure",
                     *             "state": "succeeded",
                     *             "started_at": "2026-11-20T08:15:00+07:00",
                     *             "finished_at": "2026-11-20T08:15:00+07:00"
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "php.pool.apply",
                     *             "state": "succeeded",
                     *             "started_at": "2026-11-20T08:15:00+07:00",
                     *             "finished_at": "2026-11-20T08:15:00+07:00"
                     *           },
                     *           {
                     *             "seq": 3,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "running",
                     *             "started_at": "2026-11-20T08:15:00+07:00",
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 4,
                     *             "op": "cert.issue",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 1,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0003-7000-8000-000001000003",
                     *           "name": "Công ty An Phát",
                     *           "email": "it@anphat.vn"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": "2026-11-20T08:15:00+07:00",
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0002-7000-8000-00000f000002",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0002-7000-8000-00000f000002/events"
                     *         }
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Job"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalStreamJobEvents: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example event: job
                     *     data: {"uuid":"01938a0f-0002-7000-8000-00000f000002","state":"running","progress":60}
                     */
                    "text/event-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetJobLogs: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "seq": 3,
                     *           "at": "2026-11-20T08:15:00+07:00",
                     *           "level": "info",
                     *           "message": "Áp dụng vhost shop.anphat.vn, nginx -t OK"
                     *         },
                     *         {
                     *           "seq": 3,
                     *           "at": "2026-11-20T08:15:00+07:00",
                     *           "level": "info",
                     *           "message": "Reload nginx"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["JobLog"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCancelJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a0f-0002-7000-8000-00000f000002",
                     *         "type": "website.create",
                     *         "state": "cancel_requested",
                     *         "progress": 60,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0002-7000-8000-000006000002"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "fs.site_layout.ensure",
                     *             "state": "succeeded",
                     *             "started_at": "2026-11-20T08:15:00+07:00",
                     *             "finished_at": "2026-11-20T08:15:00+07:00"
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "php.pool.apply",
                     *             "state": "succeeded",
                     *             "started_at": "2026-11-20T08:15:00+07:00",
                     *             "finished_at": "2026-11-20T08:15:00+07:00"
                     *           },
                     *           {
                     *             "seq": 3,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "running",
                     *             "started_at": "2026-11-20T08:15:00+07:00",
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 4,
                     *             "op": "cert.issue",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 1,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0003-7000-8000-000001000003",
                     *           "name": "Công ty An Phát",
                     *           "email": "it@anphat.vn"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": "2026-11-20T08:15:00+07:00",
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0002-7000-8000-00000f000002",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0002-7000-8000-00000f000002/events"
                     *         }
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Job"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRetryJob: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0150-7000-8000-00000f000150",
                     *         "type": "website.create",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0002-7000-8000-000006000002"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "fs.site_layout.ensure",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "php.pool.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 3,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 4,
                     *             "op": "cert.issue",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0150-7000-8000-00000f000150",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0150-7000-8000-00000f000150/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0002-7000-8000-000006000002"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetNotificationPreferences: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "channels": {
                     *           "email": true,
                     *           "telegram": false,
                     *           "in_app": true
                     *         },
                     *         "events": {
                     *           "backup.failed": [
                     *             "email",
                     *             "in_app"
                     *           ],
                     *           "certificate.expiring": [
                     *             "in_app"
                     *           ],
                     *           "security.high": [
                     *             "email",
                     *             "in_app"
                     *           ]
                     *         },
                     *         "updated_at": "2026-11-18T09:30:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["NotificationPreferences"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalUpdateNotificationPreferences: {
        parameters: {
            query?: never;
            header?: {
                /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
                "If-Match"?: components["parameters"]["IfMatch"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "channels": {
                 *         "email": true,
                 *         "telegram": false,
                 *         "in_app": true
                 *       },
                 *       "events": {
                 *         "backup.failed": [
                 *           "email"
                 *         ]
                 *       },
                 *       "updated_at": "2026-11-20T08:15:00+07:00"
                 *     }
                 */
                "application/json": components["schemas"]["NotificationPreferences"];
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "channels": {
                     *           "email": true,
                     *           "telegram": false,
                     *           "in_app": true
                     *         },
                     *         "events": {
                     *           "backup.failed": [
                     *             "email",
                     *             "in_app"
                     *           ],
                     *           "certificate.expiring": [
                     *             "in_app"
                     *           ],
                     *           "security.high": [
                     *             "email",
                     *             "in_app"
                     *           ]
                     *         },
                     *         "updated_at": "2026-11-18T09:30:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["NotificationPreferences"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListNotifications: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a12-0001-7000-8000-000012000001",
                     *           "type": "certificate.expiring",
                     *           "severity": "medium",
                     *           "title": "Chứng chỉ lehoa.blog sắp hết hạn",
                     *           "body": "Còn 12 ngày, tự gia hạn đang bật.",
                     *           "link": "/websites/01938a06-0004-7000-8000-000006000004",
                     *           "read_at": null,
                     *           "created_at": "2026-11-20T08:15:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a12-0002-7000-8000-000012000002",
                     *           "type": "backup.succeeded",
                     *           "severity": "info",
                     *           "title": "Backup hằng ngày hoàn tất",
                     *           "body": "4 account, 23.1 GB, đã kiểm chứng.",
                     *           "link": "/backups",
                     *           "read_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-20T03:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a12-0003-7000-8000-000012000003",
                     *           "type": "job.failed",
                     *           "severity": "high",
                     *           "title": "Tạo database intranet_web thất bại",
                     *           "body": "PostgreSQL không phản hồi; có thể thử lại.",
                     *           "link": "/jobs/01938a0f-0008-7000-8000-00000f000008",
                     *           "read_at": null,
                     *           "created_at": "2026-11-20T08:15:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["Notification"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalMarkNotificationRead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalMarkAllNotificationsRead: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công, không có nội dung */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalOverview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "accounts": [
                     *           {
                     *             "hosting_account": {
                     *               "uuid": "01938a05-0001-7000-8000-000005000001",
                     *               "username": "anphat"
                     *             },
                     *             "lifecycle_state": "active",
                     *             "usage": {
                     *               "disk_mb": {
                     *                 "used": 8420,
                     *                 "limit": 20480
                     *               },
                     *               "inodes": {
                     *                 "used": 120400,
                     *                 "limit": 400000
                     *               },
                     *               "cpu_percent": {
                     *                 "used": 35,
                     *                 "limit": 200
                     *               },
                     *               "ram_mb": {
                     *                 "used": 1830,
                     *                 "limit": 4096
                     *               },
                     *               "websites": {
                     *                 "used": 2,
                     *                 "limit": 10
                     *               },
                     *               "databases": {
                     *                 "used": 2,
                     *                 "limit": 10
                     *               },
                     *               "ftp_accounts": {
                     *                 "used": 2,
                     *                 "limit": 5
                     *               },
                     *               "cron_jobs": {
                     *                 "used": 2,
                     *                 "limit": 10
                     *               },
                     *               "backup_mb": {
                     *                 "used": 12800,
                     *                 "limit": 40960
                     *               },
                     *               "bandwidth_mb_30d": 48213,
                     *               "measured_at": "2026-11-20T08:15:00+07:00"
                     *             }
                     *           }
                     *         ],
                     *         "warnings": [
                     *           {
                     *             "code": "disk_70",
                     *             "message": "Dung lượng đã dùng 41% (8.2/20 GB)",
                     *             "severity": "info"
                     *           }
                     *         ],
                     *         "recent_jobs": [
                     *           {
                     *             "uuid": "01938a0f-0002-7000-8000-00000f000002",
                     *             "type": "website.create",
                     *             "state": "running",
                     *             "progress": 60
                     *           }
                     *         ],
                     *         "notifications_unread": 4
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["PortalOverview"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetProfile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a01-0003-7000-8000-000001000003",
                     *         "realm": "portal",
                     *         "name": "Công ty An Phát",
                     *         "email": "it@anphat.vn",
                     *         "role": "USER",
                     *         "status": "active",
                     *         "mfa_enabled": true,
                     *         "locale": "vi",
                     *         "timezone": "Asia/Ho_Chi_Minh",
                     *         "last_login_at": "2026-11-20T08:15:00+07:00",
                     *         "created_at": "2026-11-18T09:30:00+07:00",
                     *         "updated_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["User"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalUpdateProfile: {
        parameters: {
            query?: never;
            header?: {
                /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
                "If-Match"?: components["parameters"]["IfMatch"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "locale": "en"
                 *     }
                 */
                "application/json": {
                    name?: string;
                    /** @enum {string} */
                    locale?: "vi" | "en";
                    timezone?: string;
                };
            };
        };
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a01-0003-7000-8000-000001000003",
                     *         "realm": "portal",
                     *         "name": "Công ty An Phát",
                     *         "email": "it@anphat.vn",
                     *         "role": "USER",
                     *         "status": "active",
                     *         "mfa_enabled": true,
                     *         "locale": "en",
                     *         "timezone": "Asia/Ho_Chi_Minh",
                     *         "last_login_at": "2026-11-20T08:15:00+07:00",
                     *         "created_at": "2026-11-18T09:30:00+07:00",
                     *         "updated_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["User"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetSecurity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "accounts": [
                     *           {
                     *             "hosting_account": {
                     *               "uuid": "01938a05-0001-7000-8000-000005000001",
                     *               "username": "anphat"
                     *             },
                     *             "websites": [
                     *               {
                     *                 "website": {
                     *                   "uuid": "01938a06-0001-7000-8000-000006000001",
                     *                   "primary_domain": "anphat.vn"
                     *                 },
                     *                 "waf_enabled": true,
                     *                 "waf_mode": "block",
                     *                 "blocked_24h": 37
                     *               },
                     *               {
                     *                 "website": {
                     *                   "uuid": "01938a06-0002-7000-8000-000006000002",
                     *                   "primary_domain": "shop.anphat.vn"
                     *                 },
                     *                 "waf_enabled": true,
                     *                 "waf_mode": "detect",
                     *                 "blocked_24h": 0
                     *               }
                     *             ],
                     *             "findings_open": 1,
                     *             "last_scan_at": "2026-11-20T08:15:00+07:00",
                     *             "scan_running": false
                     *           }
                     *         ]
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["PortalSecurity"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListMalwareFindings: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a32-0002-7000-8000-000032000002",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "website": {
                     *             "uuid": "01938a06-0002-7000-8000-000006000002",
                     *             "primary_domain": "shop.anphat.vn"
                     *           },
                     *           "path": "sites/shop.anphat.vn/public/tmp/eicar.com",
                     *           "signature": "Eicar-Signature",
                     *           "engine": "clamav",
                     *           "action": "none",
                     *           "found_at": "2026-11-20T08:15:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["MalwareFinding"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteFinding: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0153-7000-8000-00000f000153",
                     *         "type": "malware.delete",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "malware_finding",
                     *           "uuid": "01938a32-0002-7000-8000-000032000002"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "malware.delete",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/admin/jobs/01938a0f-0153-7000-8000-00000f000153",
                     *           "events": "/api/v1/admin/jobs/01938a0f-0153-7000-8000-00000f000153/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "malware_finding",
                     *         "uuid": "01938a32-0002-7000-8000-000032000002"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalQuarantineFinding: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0152-7000-8000-00000f000152",
                     *         "type": "malware.quarantine",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "malware_finding",
                     *           "uuid": "01938a32-0002-7000-8000-000032000002"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "malware.quarantine",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/admin/jobs/01938a0f-0152-7000-8000-00000f000152",
                     *           "events": "/api/v1/admin/jobs/01938a0f-0152-7000-8000-00000f000152/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "malware_finding",
                     *         "uuid": "01938a32-0002-7000-8000-000032000002"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListRestores: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a10-0001-7000-8000-000010000001",
                     *           "snapshot_uuid": "01938a0e-0001-7000-8000-00000e000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "target_server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "mode": "new",
                     *           "items": [
                     *             "files:sites/anphat.vn"
                     *           ],
                     *           "state": "succeeded",
                     *           "job_uuid": "01938a0f-0004-7000-8000-00000f000004",
                     *           "requested_by": {
                     *             "uuid": "01938a01-0003-7000-8000-000001000003",
                     *             "name": "Công ty An Phát",
                     *             "email": "it@anphat.vn"
                     *           },
                     *           "created_at": "2026-11-19T14:05:00+07:00",
                     *           "finished_at": "2026-11-19T14:05:00+07:00",
                     *           "result": {
                     *             "restored_paths": [
                     *               "backups/restore-20261119-1405/sites/anphat.vn"
                     *             ],
                     *             "databases": [],
                     *             "pre_restore_snapshot_uuid": null
                     *           },
                     *           "error": null
                     *         },
                     *         {
                     *           "uuid": "01938a10-0002-7000-8000-000010000002",
                     *           "snapshot_uuid": "01938a0e-0001-7000-8000-00000e000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "target_server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "mode": "overwrite",
                     *           "items": [
                     *             "database:anphat_shop"
                     *           ],
                     *           "state": "failed",
                     *           "job_uuid": null,
                     *           "requested_by": {
                     *             "uuid": "01938a01-0001-7000-8000-000001000001",
                     *             "name": "Quản trị hệ thống",
                     *             "email": "superadmin@itso.local"
                     *           },
                     *           "created_at": "2026-11-18T16:20:00+07:00",
                     *           "finished_at": "2026-11-18T16:21:10+07:00",
                     *           "result": null,
                     *           "error": "Dump trước khi ghi đè anphat_shop thất bại: vượt quota đĩa của account. DB hiện tại không bị thay đổi."
                     *         },
                     *         {
                     *           "uuid": "01938a10-0003-7000-8000-000010000003",
                     *           "snapshot_uuid": "01938a0e-0001-7000-8000-00000e000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "target_server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "mode": "new",
                     *           "items": [
                     *             "database:anphat_shop"
                     *           ],
                     *           "state": "succeeded",
                     *           "job_uuid": null,
                     *           "requested_by": {
                     *             "uuid": "01938a01-0002-7000-8000-000001000002",
                     *             "name": "Trần Minh",
                     *             "email": "minh.tran@itso.local"
                     *           },
                     *           "created_at": "2026-11-19T10:02:00+07:00",
                     *           "finished_at": "2026-11-19T10:04:30+07:00",
                     *           "result": {
                     *             "restored_paths": [],
                     *             "databases": [
                     *               "anphat_shop_r20261119"
                     *             ],
                     *             "pre_restore_snapshot_uuid": null
                     *           },
                     *           "error": null
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["Restore"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateRestore: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "snapshot_uuid": "01938a0e-0001-7000-8000-00000e000001",
                 *       "mode": "new",
                 *       "items": [
                 *         "files:sites/anphat.vn"
                 *       ],
                 *       "target_server_uuid": null,
                 *       "confirm": null
                 *     }
                 */
                "application/json": components["schemas"]["RestoreRequest"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0149-7000-8000-00000f000149",
                     *         "type": "backup.restore",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "hosting_account",
                     *           "uuid": "01938a05-0001-7000-8000-000005000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "backup.restore",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0149-7000-8000-00000f000149",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0149-7000-8000-00000f000149/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "hosting_account",
                     *         "uuid": "01938a05-0001-7000-8000-000005000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetRestore: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a10-0001-7000-8000-000010000001",
                     *         "snapshot_uuid": "01938a0e-0001-7000-8000-00000e000001",
                     *         "hosting_account": {
                     *           "uuid": "01938a05-0001-7000-8000-000005000001",
                     *           "username": "anphat"
                     *         },
                     *         "target_server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "mode": "new",
                     *         "items": [
                     *           "files:sites/anphat.vn"
                     *         ],
                     *         "state": "succeeded",
                     *         "job_uuid": "01938a0f-0004-7000-8000-00000f000004",
                     *         "requested_by": {
                     *           "uuid": "01938a01-0003-7000-8000-000001000003",
                     *           "name": "Công ty An Phát",
                     *           "email": "it@anphat.vn"
                     *         },
                     *         "created_at": "2026-11-19T14:05:00+07:00",
                     *         "finished_at": "2026-11-19T14:05:00+07:00",
                     *         "result": {
                     *           "restored_paths": [
                     *             "backups/restore-20261119-1405/sites/anphat.vn"
                     *           ],
                     *           "databases": [],
                     *           "pre_restore_snapshot_uuid": null
                     *         },
                     *         "error": null
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Restore"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListSftpAccounts: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a0b-0001-7000-8000-00000b000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "username": "anphat",
                     *           "protocol": "sftp",
                     *           "root_path": ".",
                     *           "read_only": false,
                     *           "last_login_at": "2026-11-19T14:05:00+07:00",
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a0b-0002-7000-8000-00000b000002",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "username": "anphat_deploy",
                     *           "protocol": "ftps",
                     *           "root_path": "sites/anphat.vn",
                     *           "read_only": false,
                     *           "last_login_at": null,
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a0b-0003-7000-8000-00000b000003",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0005-7000-8000-000005000005",
                     *             "username": "binhminh"
                     *           },
                     *           "username": "binhminh",
                     *           "protocol": "sftp",
                     *           "root_path": ".",
                     *           "read_only": false,
                     *           "last_login_at": null,
                     *           "status": "ready",
                     *           "spec_version": 1,
                     *           "observed_version": 1,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-12T09:10:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["SftpAccount"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateSftpAccount: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "hosting_account_uuid": "01938a05-0001-7000-8000-000005000001",
                 *       "username": "anphat_deploy",
                 *       "protocol": "sftp",
                 *       "root_path": "sites/anphat.vn",
                 *       "read_only": false,
                 *       "password": null
                 *     }
                 */
                "application/json": components["schemas"]["SftpAccountCreate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-013f-7000-8000-00000f00013f",
                     *         "type": "sftp.create",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "sftp_account",
                     *           "uuid": "01938a0b-0001-7000-8000-00000b000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "sftp.user.ensure",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-013f-7000-8000-00000f00013f",
                     *           "events": "/api/v1/portal/jobs/01938a0f-013f-7000-8000-00000f00013f/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "sftp_account",
                     *         "uuid": "01938a0b-0001-7000-8000-00000b000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteSftpAccount: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0141-7000-8000-00000f000141",
                     *         "type": "sftp.delete",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "sftp_account",
                     *           "uuid": "01938a0b-0001-7000-8000-00000b000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "sftp.user.remove",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0141-7000-8000-00000f000141",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0141-7000-8000-00000f000141/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "sftp_account",
                     *         "uuid": "01938a0b-0001-7000-8000-00000b000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRotateSftpPassword: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0140-7000-8000-00000f000140",
                     *         "type": "sftp.password",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "sftp_account",
                     *           "uuid": "01938a0b-0001-7000-8000-00000b000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "ftp.user.ensure",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0140-7000-8000-00000f000140",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0140-7000-8000-00000f000140/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "sftp_account",
                     *         "uuid": "01938a0b-0001-7000-8000-00000b000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListSshKeys: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a0c-0001-7000-8000-00000c000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "name": "Laptop IT An Phát",
                     *           "fingerprint": "SHA256:Qm9sZGx5IGdvIHdoZXJlIG5vIG9uZSBoYXMgZ29uZQ",
                     *           "type": "ssh-ed25519",
                     *           "last_used_at": "2026-11-19T14:05:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["SshKey"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateSshKey: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "hosting_account_uuid": "01938a05-0001-7000-8000-000005000001",
                 *       "name": "Laptop IT An Phát",
                 *       "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq8 it@anphat"
                 *     }
                 */
                "application/json": components["schemas"]["SshKeyCreate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0142-7000-8000-00000f000142",
                     *         "type": "ssh_key.create",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "ssh_key",
                     *           "uuid": "01938a0c-0001-7000-8000-00000c000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "ssh.keys.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0142-7000-8000-00000f000142",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0142-7000-8000-00000f000142/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "ssh_key",
                     *         "uuid": "01938a0c-0001-7000-8000-00000c000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteSshKey: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0143-7000-8000-00000f000143",
                     *         "type": "ssh_key.delete",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "ssh_key",
                     *           "uuid": "01938a0c-0001-7000-8000-00000c000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "ssh.keys.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0143-7000-8000-00000f000143",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0143-7000-8000-00000f000143/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "ssh_key",
                     *         "uuid": "01938a0c-0001-7000-8000-00000c000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateTerminalSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "hosting_account_uuid": "01938a05-0001-7000-8000-000005000001",
                 *       "server_uuid": null,
                 *       "mode": "account"
                 *     }
                 */
                "application/json": components["schemas"]["TerminalRequest"];
            };
        };
        responses: {
            /** @description Đã tạo */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "ticket": "tkt_9QwErTy2uIoP",
                     *         "ws_url": "wss://admin.itso.local/gateway/terminal",
                     *         "expires_at": "2026-11-20T08:15:30+07:00",
                     *         "mode": "account",
                     *         "unix_user": "anphat",
                     *         "session_uuid": "01938a31-0001-7000-8000-000031000001"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["TerminalTicket"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
            503: components["responses"]["AgentUnavailable"];
        };
    };
    portalListWebsites: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
                /** @description Lọc theo account. */
                "filter[hosting_account]"?: components["parameters"]["FilterHostingAccount"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a06-0001-7000-8000-000006000001",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "primary_domain": "anphat.vn",
                     *           "type": "php",
                     *           "document_root": "public",
                     *           "php_version": "8.3",
                     *           "ssl_mode": "acme",
                     *           "waf_enabled": true,
                     *           "domains_count": 2,
                     *           "certificate_expires_at": "2027-02-16T07:00:00+07:00",
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a06-0002-7000-8000-000006000002",
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0001-7000-8000-000005000001",
                     *             "username": "anphat"
                     *           },
                     *           "server": {
                     *             "uuid": "01938a02-0001-7000-8000-000002000001",
                     *             "name": "srv-hn-01"
                     *           },
                     *           "primary_domain": "shop.anphat.vn",
                     *           "type": "php",
                     *           "document_root": "public",
                     *           "php_version": "8.2",
                     *           "ssl_mode": "acme",
                     *           "waf_enabled": true,
                     *           "domains_count": 1,
                     *           "certificate_expires_at": "2027-02-16T07:00:00+07:00",
                     *           "status": "ready",
                     *           "spec_version": 3,
                     *           "observed_version": 3,
                     *           "drift": null,
                     *           "observed_at": "2026-11-20T08:15:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["Website"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalCreateWebsite: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "hosting_account_uuid": "01938a05-0001-7000-8000-000005000001",
                 *       "primary_domain": "shop.anphat.vn",
                 *       "type": "php",
                 *       "document_root": "public",
                 *       "php_version": "8.2",
                 *       "ssl_mode": "acme",
                 *       "proxy_target": null
                 *     }
                 */
                "application/json": components["schemas"]["WebsiteCreate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-012d-7000-8000-00000f00012d",
                     *         "type": "website.create",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0002-7000-8000-000006000002"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "fs.site_layout.ensure",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "php.pool.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 3,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 4,
                     *             "op": "cert.issue",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 5,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-012d-7000-8000-00000f00012d",
                     *           "events": "/api/v1/portal/jobs/01938a0f-012d-7000-8000-00000f00012d/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0002-7000-8000-000006000002"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetWebsite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "uuid": "01938a06-0001-7000-8000-000006000001",
                     *         "hosting_account": {
                     *           "uuid": "01938a05-0001-7000-8000-000005000001",
                     *           "username": "anphat"
                     *         },
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "primary_domain": "anphat.vn",
                     *         "type": "php",
                     *         "document_root": "public",
                     *         "php_version": "8.3",
                     *         "ssl_mode": "acme",
                     *         "waf_enabled": true,
                     *         "domains_count": 2,
                     *         "certificate_expires_at": "2027-02-16T07:00:00+07:00",
                     *         "status": "ready",
                     *         "spec_version": 3,
                     *         "observed_version": 3,
                     *         "drift": null,
                     *         "observed_at": "2026-11-20T08:15:00+07:00",
                     *         "created_at": "2026-11-18T09:30:00+07:00",
                     *         "updated_at": "2026-11-19T14:05:00+07:00"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Website"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalDeleteWebsite: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-012f-7000-8000-00000f00012f",
                     *         "type": "website.delete",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0001-7000-8000-000006000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "nginx.vhost.remove",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "php.pool.remove",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-012f-7000-8000-00000f00012f",
                     *           "events": "/api/v1/portal/jobs/01938a0f-012f-7000-8000-00000f00012f/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0001-7000-8000-000006000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalUpdateWebsite: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
                "If-Match"?: components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "php_version": "8.3",
                 *       "waf_enabled": true
                 *     }
                 */
                "application/json": components["schemas"]["WebsiteUpdate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-012e-7000-8000-00000f00012e",
                     *         "type": "website.update",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0001-7000-8000-000006000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "php.pool.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-012e-7000-8000-00000f00012e",
                     *           "events": "/api/v1/portal/jobs/01938a0f-012e-7000-8000-00000f00012e/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0001-7000-8000-000006000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRequestCertificate: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "source": "acme",
                 *       "domains": [
                 *         "anphat.vn",
                 *         "www.anphat.vn"
                 *       ],
                 *       "certificate_pem": null,
                 *       "private_key_pem": null
                 *     }
                 */
                "application/json": components["schemas"]["CertificateRequest"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0134-7000-8000-00000f000134",
                     *         "type": "certificate.issue",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0001-7000-8000-000006000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "cert.issue",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0134-7000-8000-00000f000134",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0134-7000-8000-00000f000134/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0001-7000-8000-000006000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListWebsiteDomains: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a07-0001-7000-8000-000007000001",
                     *           "website": {
                     *             "uuid": "01938a06-0001-7000-8000-000006000001",
                     *             "primary_domain": "anphat.vn"
                     *           },
                     *           "name": "anphat.vn",
                     *           "type": "primary",
                     *           "verified_at": "2026-11-18T09:30:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a07-0002-7000-8000-000007000002",
                     *           "website": {
                     *             "uuid": "01938a06-0001-7000-8000-000006000001",
                     *             "primary_domain": "anphat.vn"
                     *           },
                     *           "name": "www.anphat.vn",
                     *           "type": "alias",
                     *           "verified_at": "2026-11-18T09:30:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a07-0003-7000-8000-000007000003",
                     *           "website": {
                     *             "uuid": "01938a06-0002-7000-8000-000006000002",
                     *             "primary_domain": "shop.anphat.vn"
                     *           },
                     *           "name": "shop.anphat.vn",
                     *           "type": "primary",
                     *           "verified_at": "2026-11-18T09:30:00+07:00",
                     *           "created_at": "2026-11-18T09:30:00+07:00",
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["WebsiteDomain"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalAddWebsiteDomain: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "name": "www.anphat.vn",
                 *       "type": "alias"
                 *     }
                 */
                "application/json": components["schemas"]["WebsiteDomainCreate"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0130-7000-8000-00000f000130",
                     *         "type": "website.domain.add",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0001-7000-8000-000006000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0130-7000-8000-00000f000130",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0130-7000-8000-00000f000130/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0001-7000-8000-000006000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalRemoveWebsiteDomain: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
                /** @description UUID domain. */
                domain: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0131-7000-8000-00000f000131",
                     *         "type": "website.domain.remove",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0001-7000-8000-000006000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0131-7000-8000-00000f000131",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0131-7000-8000-00000f000131/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0001-7000-8000-000006000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetWebsiteLogs: {
        parameters: {
            query: {
                /** @description Loại log. */
                kind: components["parameters"]["LogKind"];
                /** @description Số dòng cuối. */
                lines?: components["parameters"]["Lines"];
            };
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         "203.0.113.50 - - [20/Nov/2026:08:14:59 +0700] \"GET / HTTP/2.0\" 200 5123"
                     *       ]
                     *     }
                     */
                    "application/json": {
                        data: string[];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            503: components["responses"]["AgentUnavailable"];
        };
    };
    portalGetWebsiteNginx: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "client_max_body_size": "64m",
                     *         "http2": true,
                     *         "hsts": true,
                     *         "extra_headers": {
                     *           "X-Frame-Options": "SAMEORIGIN"
                     *         },
                     *         "redirects": []
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["WebsiteNginx"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalUpdateWebsiteNginx: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
                "If-Match"?: components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "client_max_body_size": "128m"
                 *     }
                 */
                "application/json": components["schemas"]["WebsiteNginx"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0132-7000-8000-00000f000132",
                     *         "type": "website.nginx.update",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0001-7000-8000-000006000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "nginx.vhost.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0132-7000-8000-00000f000132",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0132-7000-8000-00000f000132/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0001-7000-8000-000006000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalGetWebsitePhp: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "version": "8.3",
                     *         "memory_limit": "256m",
                     *         "max_execution_time": 60,
                     *         "upload_max_filesize": "64m",
                     *         "pm_max_children": 6,
                     *         "disable_functions": [
                     *           "exec",
                     *           "shell_exec",
                     *           "system",
                     *           "passthru",
                     *           "proc_open"
                     *         ]
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["WebsitePhp"];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalUpdateWebsitePhp: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412. */
                "If-Match"?: components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "memory_limit": "512m"
                 *     }
                 */
                "application/json": components["schemas"]["WebsitePhp"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-0133-7000-8000-00000f000133",
                     *         "type": "website.php.update",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0001-7000-8000-000006000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "php.pool.apply",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-0133-7000-8000-00000f000133",
                     *           "events": "/api/v1/portal/jobs/01938a0f-0133-7000-8000-00000f000133/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0001-7000-8000-000006000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalListWordPressSites: {
        parameters: {
            query?: {
                /** @description Cursor trang tiếp theo. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Số bản ghi mỗi trang. */
                limit?: components["parameters"]["Limit"];
                /** @description Sắp xếp, ví dụ `-created_at`. */
                sort?: components["parameters"]["Sort"];
                /** @description Tìm kiếm tự do. */
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": [
                     *         {
                     *           "uuid": "01938a11-0001-7000-8000-000011000001",
                     *           "website": {
                     *             "uuid": "01938a06-0004-7000-8000-000006000004",
                     *             "primary_domain": "lehoa.blog"
                     *           },
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0003-7000-8000-000005000003",
                     *             "username": "lehoa"
                     *           },
                     *           "wp_version": "6.6.2",
                     *           "latest_version": "6.7.1",
                     *           "plugins_total": 14,
                     *           "plugins_outdated": 3,
                     *           "themes_outdated": 1,
                     *           "auto_update": "minor",
                     *           "hardening": {
                     *             "xmlrpc_disabled": true,
                     *             "file_edit_disabled": true
                     *           },
                     *           "staging_of": null,
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a11-0002-7000-8000-000011000002",
                     *           "website": {
                     *             "uuid": "01938a06-0008-7000-8000-000006000008",
                     *             "primary_domain": "saomai.edu.vn"
                     *           },
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0006-7000-8000-000005000006",
                     *             "username": "saomai"
                     *           },
                     *           "wp_version": "6.7.1",
                     *           "latest_version": "6.7.1",
                     *           "plugins_total": 9,
                     *           "plugins_outdated": 1,
                     *           "themes_outdated": 1,
                     *           "auto_update": "minor",
                     *           "hardening": {
                     *             "xmlrpc_disabled": true,
                     *             "file_edit_disabled": true
                     *           },
                     *           "staging_of": null,
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         },
                     *         {
                     *           "uuid": "01938a11-0003-7000-8000-000011000003",
                     *           "website": {
                     *             "uuid": "01938a06-000b-7000-8000-00000600000b",
                     *             "primary_domain": "thientam.vn"
                     *           },
                     *           "hosting_account": {
                     *             "uuid": "01938a05-0008-7000-8000-000005000008",
                     *             "username": "thientam"
                     *           },
                     *           "wp_version": "6.7.1",
                     *           "latest_version": "6.7.1",
                     *           "plugins_total": 11,
                     *           "plugins_outdated": 0,
                     *           "themes_outdated": 1,
                     *           "auto_update": "minor",
                     *           "hardening": {
                     *             "xmlrpc_disabled": true,
                     *             "file_edit_disabled": true
                     *           },
                     *           "staging_of": null,
                     *           "updated_at": "2026-11-19T14:05:00+07:00"
                     *         }
                     *       ],
                     *       "meta": {
                     *         "next_cursor": null,
                     *         "limit": 50
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["CursorPage"] & {
                        data: components["schemas"]["WordPressSite"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalInstallWordPress: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "website_uuid": "01938a06-0002-7000-8000-000006000002",
                 *       "title": "Shop An Phát",
                 *       "admin_username": "anphat_admin",
                 *       "admin_email": "it@anphat.vn",
                 *       "locale": "vi"
                 *     }
                 */
                "application/json": components["schemas"]["WordPressInstall"];
            };
        };
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-014a-7000-8000-00000f00014a",
                     *         "type": "wordpress.install",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "website",
                     *           "uuid": "01938a06-0002-7000-8000-000006000002"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "db.mysql.create",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           },
                     *           {
                     *             "seq": 2,
                     *             "op": "wp.install",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0001-7000-8000-000002000001",
                     *           "name": "srv-hn-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-014a-7000-8000-00000f00014a",
                     *           "events": "/api/v1/portal/jobs/01938a0f-014a-7000-8000-00000f00014a/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "website",
                     *         "uuid": "01938a06-0002-7000-8000-000006000002"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalWordPressCloneStaging: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-014c-7000-8000-00000f00014c",
                     *         "type": "wordpress.clone_staging",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "wordpress_site",
                     *           "uuid": "01938a11-0001-7000-8000-000011000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "wp.clone",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0003-7000-8000-000002000003",
                     *           "name": "srv-hcm-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-014c-7000-8000-00000f00014c",
                     *           "events": "/api/v1/portal/jobs/01938a0f-014c-7000-8000-00000f00014c/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "wordpress_site",
                     *         "uuid": "01938a11-0001-7000-8000-000011000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalWordPressHarden: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-014d-7000-8000-00000f00014d",
                     *         "type": "wordpress.harden",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "wordpress_site",
                     *           "uuid": "01938a11-0001-7000-8000-000011000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "wp.harden",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0003-7000-8000-000002000003",
                     *           "name": "srv-hcm-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-014d-7000-8000-00000f00014d",
                     *           "events": "/api/v1/portal/jobs/01938a0f-014d-7000-8000-00000f00014d/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "wordpress_site",
                     *         "uuid": "01938a11-0001-7000-8000-000011000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    portalWordPressUpdate: {
        parameters: {
            query?: never;
            header: {
                /** @description Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID tài nguyên. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Đã nhận, Job được tạo */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "job": {
                     *         "uuid": "01938a0f-014b-7000-8000-00000f00014b",
                     *         "type": "wordpress.update",
                     *         "state": "queued",
                     *         "progress": 0,
                     *         "resource": {
                     *           "type": "wordpress_site",
                     *           "uuid": "01938a11-0001-7000-8000-000011000001"
                     *         },
                     *         "steps": [
                     *           {
                     *             "seq": 1,
                     *             "op": "wp.update",
                     *             "state": "pending",
                     *             "started_at": null,
                     *             "finished_at": null
                     *           }
                     *         ],
                     *         "attempts": 0,
                     *         "max_attempts": 3,
                     *         "timeout_sec": 600,
                     *         "error": null,
                     *         "server": {
                     *           "uuid": "01938a02-0003-7000-8000-000002000003",
                     *           "name": "srv-hcm-01"
                     *         },
                     *         "requested_by": {
                     *           "uuid": "01938a01-0001-7000-8000-000001000001",
                     *           "name": "Quản trị hệ thống",
                     *           "email": "superadmin@itso.local"
                     *         },
                     *         "created_at": "2026-11-20T08:15:00+07:00",
                     *         "started_at": null,
                     *         "finished_at": null,
                     *         "links": {
                     *           "self": "/api/v1/portal/jobs/01938a0f-014b-7000-8000-00000f00014b",
                     *           "events": "/api/v1/portal/jobs/01938a0f-014b-7000-8000-00000f00014b/events"
                     *         }
                     *       },
                     *       "resource": {
                     *         "type": "wordpress_site",
                     *         "uuid": "01938a11-0001-7000-8000-000011000001"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationFailed"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Thành công */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "data": {
                     *         "status": "ok"
                     *       }
                     *     }
                     */
                    "application/json": {
                        data: components["schemas"]["Health"];
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
        };
    };
}
