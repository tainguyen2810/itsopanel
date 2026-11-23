#!/usr/bin/env python3
"""Sinh contracts/openapi/{common,itso-admin-v1,itso-portal-v1}.yaml và contracts/examples/demo-dataset.json.

Nguồn sự thật cho REST là các file YAML đã sinh (được commit). Sửa contract: sửa schemas.py /
gen_openapi.py / demo.py rồi chạy `make contracts`; `make contracts-check` báo lỗi nếu YAML lệch.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import yaml  # noqa: E402

import demo as D  # noqa: E402
from oas import Api, arr, cref, enum, obj, ref, s  # noqa: E402
from schemas import ADMIN, COMMON  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "openapi"


# ---------------------------------------------------------------- example helpers
def job(type_: str, resource_type: str | None, resource_uuid: str | None, n: int = 50, realm: str = "admin",
        server=0, actor=0, steps=None):
    uuid = D.u("job", n)
    steps = steps or [type_.split(".")[0] + ".apply"]
    res = {"type": resource_type, "uuid": resource_uuid} if resource_type else None
    jb = {
        "uuid": uuid, "type": type_, "state": "queued", "progress": 0, "resource": res,
        "steps": [{"seq": k + 1, "op": op, "state": "pending", "started_at": None, "finished_at": None}
                  for k, op in enumerate(steps)],
        "attempts": 0, "max_attempts": 3, "timeout_sec": 600, "error": None,
        "server": D.server_ref(server) if server is not None else None,
        "requested_by": D.user_ref(actor), "created_at": D.T2, "started_at": None, "finished_at": None,
        "links": {"self": f"/api/v1/{realm}/jobs/{uuid}", "events": f"/api/v1/{realm}/jobs/{uuid}/events"},
    }
    return {"job": jb, "resource": res}


def page(items):
    return {"data": items[:3], "meta": {"next_cursor": None, "limit": 50}}


def one(x):
    return {"data": x}


class JobSeq:
    """Cấp số job example tăng dần để mỗi example có UUID riêng."""

    def __init__(self, start):
        self.n = start

    def __call__(self, type_, rtype=None, ruuid=None, steps=None, realm="admin", server=0, actor=0):
        self.n += 1
        return job(type_, rtype, ruuid, self.n, realm=realm, server=server, actor=actor, steps=steps)


# ---------------------------------------------------------------- phần chung admin + portal
def auth_paths(api: Api, realm: str):
    me = D.ME_ADMIN if realm == "admin" else D.ME_PORTAL
    login_ex = {"email": me["user"]["email"], "password": "********", "remember": False}
    csrf_only = [{"csrfToken": []}]
    api.add("get", "/api/v1/auth/csrf", "getCsrfCookie", "Lấy cookie XSRF-TOKEN", "Auth", public=True, no_content=True)
    api.add("post", "/api/v1/auth/login", "login", "Đăng nhập (realm theo origin)", "Auth", public=True,
            security=csrf_only, body=cref("LoginRequest"), body_example=login_ex, ok=cref("LoginResult"),
            ok_example=one({"mfa_required": True, "mfa_methods": ["totp", "recovery"]}),
            desc="Origin admin chỉ chấp nhận user realm `admin`, origin portal chỉ chấp nhận realm `portal` "
                 "(một origin: theo header `X-ITSO-Realm`, D-58). Sai realm trả cùng lỗi như sai mật khẩu.")
    api.add("get", "/api/v1/auth/captcha", "getCaptcha", "Thử thách CAPTCHA proof-of-work (dùng một lần, 5 phút)",
            "Auth", public=True, ok=cref("CaptchaChallenge"), ok_example=one(D.CAPTCHA),
            desc="Tự host, không gọi dịch vụ ngoài (D-81). Đăng nhập/quên mật khẩu trả 422 `captcha_required` khi "
                 "IP hoặc email đã sai quá ngưỡng (`portal_captcha_after_failures`); khi đó gửi kèm `captcha`.")
    api.add("post", "/api/v1/auth/mfa/verify", "verifyMfa", "Xác minh MFA sau đăng nhập", "Auth", public=True,
            security=csrf_only, body=cref("MfaVerifyRequest"), body_example={"code": "492817", "method": "totp"},
            ok=cref("Me"), ok_example=one(me))
    api.add("post", "/api/v1/auth/logout", "logout", "Đăng xuất", "Auth", no_content=True)
    api.add("get", "/api/v1/auth/me", "getMe", "Người dùng hiện tại", "Auth", ok=cref("Me"), ok_example=one(me))
    api.add("post", "/api/v1/auth/step-up", "stepUp", "Xác thực lại MFA cho thao tác nguy hiểm", "Auth",
            body=cref("MfaVerifyRequest"), body_example={"code": "118204", "method": "totp"}, ok=cref("Me"),
            ok_example=one(me))
    api.add("post", "/api/v1/auth/mfa/totp:enroll", "enrollTotp", "Bắt đầu đăng ký TOTP", "Auth",
            ok=cref("TotpEnrollment"),
            ok_example=one({"secret": "JBSWY3DPEHPK3PXP", "otpauth_uri": "otpauth://totp/ITSO:it%40anphat.vn?secret=JBSWY3DPEHPK3PXP&issuer=ITSO",
                            "recovery_codes": ["k7f2m9q4x1", "p3n8v6c2z5"]}))
    api.add("post", "/api/v1/auth/mfa/totp:confirm", "confirmTotp", "Xác nhận TOTP", "Auth",
            body=cref("MfaVerifyRequest"), body_example={"code": "730115", "method": "totp"}, no_content=True)
    api.add("get", "/api/v1/auth/sessions", "listSessions", "Phiên đăng nhập của tôi", "Auth", list_=True,
            ok=cref("Session"), ok_example=page(D.SESSIONS))
    api.add("delete", "/api/v1/auth/sessions/{id}", "revokeSession", "Thu hồi phiên", "Auth",
            params=[Api.p("Id")], no_content=True)
    api.add("post", "/api/v1/auth/password:change", "changePassword", "Đổi mật khẩu", "Auth",
            body=cref("PasswordChange"),
            body_example={"current_password": "********", "new_password": "************"}, no_content=True)
    api.add("post", "/api/v1/auth/password:forgot", "forgotPassword", "Gửi email đặt lại mật khẩu", "Auth", public=True,
            security=csrf_only, body=obj({"email": s("email"), "captcha": cref("CaptchaSolution")}, required=["email"]),
            body_example={"email": me["user"]["email"]}, no_content=True,
            desc="Luôn trả 204 dù email có tồn tại hay không (không lộ tài khoản). Portal: 422 `captcha_required` "
                 "khi IP/email đã sai quá ngưỡng như đăng nhập (D-81).")
    api.add("post", "/api/v1/auth/password:reset", "resetPassword", "Đặt lại mật khẩu bằng token", "Auth", public=True,
            security=csrf_only, body=obj({"token": s(minLength=32, maxLength=200), "email": s("email"),
                                          "password": s(minLength=12, maxLength=200, writeOnly=True)}),
            body_example={"token": "8f1c2a7b9e3d4f6a0b5c8d2e7f1a3b6c9d0e4f7a", "email": me["user"]["email"],
                          "password": "************"}, no_content=True)
    if realm == "portal":
        # Giả danh (D-61): Admin tạo vé dùng một lần (POST /admin/users/{id}:impersonate → portal_url),
        # Portal đổi vé lấy phiên portal của USER đích, có hạn, mọi thao tác ghi audit kèm người giả danh.
        api.add("post", "/api/v1/auth/impersonation:accept", "acceptImpersonation",
                "Nhận phiên giả danh từ Admin (vé dùng một lần)", "Auth", public=True, security=csrf_only,
                body=obj({"ticket": s(minLength=32, maxLength=200)}),
                body_example={"ticket": "q7Yb2kV9xW4mN8pR3tL6sD1fG5hJ0aZcE2uI7oP9"},
                ok=cref("Me"), ok_example=one(me | {"impersonating": D.IMPERSONATION["staff"]}),
                desc="Vé do `POST /api/v1/admin/users/{id}:impersonate` tạo, hết hạn sau 60 giây, dùng một lần. "
                     "Phiên giả danh không đổi được mật khẩu/MFA và tự hết hạn theo `expires_at`.")
        api.add("post", "/api/v1/auth/impersonation:end", "endImpersonation", "Kết thúc giả danh", "Auth",
                no_content=True)
    # Realm của /auth/*: production theo origin (host admin / portal); một origin (dev, demo) theo header.
    for path, ops in api.paths.items():
        if path.startswith("/api/v1/auth/"):
            for op in ops.values():
                op.setdefault("parameters", []).append(Api.p("Realm"))
    api.add("get", "/api/v1/system/health", "getHealth", "Kiểm tra sống", "System", public=True,
            ok=cref("Health"), ok_example=one({"status": "ok"}))


def files_paths(api: Api, base: str, tag: str, prefix: str, jobs: JobSeq, realm: str):
    """File Manager trên home của account (mọi thao tác chạy dưới UID account)."""
    idp = [Api.p("Id")]
    path_q = [Api.p("PathQuery")]
    acc = D.ACCOUNTS[0]
    sync_ops = []  # gọi agent đồng bộ (không job): agent không kết nối → 503
    sync_ops.append(api.add("get", f"{base}/{{id}}/files", f"{prefix}ListFiles", "Liệt kê thư mục", tag, params=idp + path_q,
            list_=True, ok=cref("FileEntry"), ok_example=page(D.FILES)))
    read_op = api.add("get", f"{base}/{{id}}/files/content", f"{prefix}ReadFile", "Đọc nội dung file (≤ 2 MB)", tag,
            params=idp + path_q, ok=cref("FileContent"),
            ok_example=one({"path": "sites/anphat.vn/public/index.php", "content": "<?php\nrequire __DIR__.'/../bootstrap/app.php';\n",
                            "encoding": "utf-8", "etag": "\"a1b2c3\""}),
            desc="File lớn hơn 2 MiB hoặc không phải file thường → 422 (dùng tải xuống).")
    read_op["responses"]["422"] = Api.r("ValidationFailed")
    sync_ops.append(read_op)
    write_op = api.add("put", f"{base}/{{id}}/files/content", f"{prefix}WriteFile", "Ghi nội dung file", tag, params=idp,
            body=cref("FileWrite"),
            body_example={"path": "sites/anphat.vn/public/robots.txt", "content": "User-agent: *\nDisallow:\n",
                          "encoding": "utf-8", "if_etag": None},
            ok=cref("FileEntry"), ok_example=one(D.FILES[1]),
            desc="`if_etag` khác ETag hiện tại của file (đã bị sửa nơi khác) → 412.")
    write_op["responses"]["412"] = Api.r("PreconditionFailed")
    sync_ops.append(write_op)
    api.add("post", f"{base}/{{id}}/files:operate", f"{prefix}OperateFiles", "mkdir/move/copy/delete/chmod/nén/giải nén",
            tag, params=idp, body=cref("FileOperation"),
            body_example={"op": "compress", "paths": ["sites/anphat.vn/public"], "target": "backups/public.zip",
                          "mode": None, "format": "zip"},
            job=True, job_example=jobs("file.operate", "hosting_account", acc["uuid"], ["fs.archive"], realm=realm))
    api.add("post", f"{base}/{{id}}/files/uploads", f"{prefix}CreateUpload", "Tạo phiên upload theo chunk", tag,
            params=idp, body=cref("UploadCreate"),
            body_example={"path": "sites/anphat.vn/public/brochure.pdf", "size": 5242880, "overwrite": False},
            ok=cref("UploadSession"), ok_example=one(D.UPLOAD), status="201")
    api.add("patch", f"{base}/{{id}}/files/uploads/{{upload}}", f"{prefix}UploadChunk", "Gửi một chunk", tag,
            params=idp + [Api.p("UploadId"), Api.p("ContentRange")], body={"type": "string", "format": "binary"},
            content_type="application/octet-stream", ok=cref("UploadSession"),
            ok_example=one(D.UPLOAD | {"received": 1048576}),
            desc="Chunk phải bắt đầu đúng tại `received` (sai → 409 kèm `received` hiện tại); chunk cuối tạo job "
                 "`file.upload` (agent `fs.upload.commit`, ghi dưới uid account) và trả `status=committing`.")
    api.add("get", f"{base}/{{id}}/files/uploads/{{upload}}", f"{prefix}GetUpload", "Trạng thái phiên upload (để tiếp tục)",
            tag, params=idp + [Api.p("UploadId")], ok=cref("UploadSession"), ok_example=one(D.UPLOAD | {"received": 3145728}))
    api.add("delete", f"{base}/{{id}}/files/uploads/{{upload}}", f"{prefix}CancelUpload", "Hủy phiên upload", tag,
            params=idp + [Api.p("UploadId")], no_content=True)
    api.add("get", f"{base}/{{id}}/files/download", f"{prefix}DownloadLink", "Tạo URL tải xuống ký số, hạn 5 phút",
            tag, params=idp + path_q, ok=cref("SignedUrl"),
            ok_example=one({"url": "https://portal.itso.local/dl/eyJwIjoic2l0ZXMvYW5waGF0LnZuIn0.sig",
                            "expires_at": "2026-11-20T08:20:00+07:00"}))
    raw = f"{base}/{{id}}/files/raw"
    api.add("get", raw, f"{prefix}DownloadFile", "Tải file (URL ký số từ DownloadLink)", tag,
            params=idp + path_q + [Api.p("Expires"), Api.p("Signature")], ok=None,
            desc="Stream nội dung file theo từng khúc 1 MiB qua agent (`fs.read` có `offset`). Cần phiên đăng nhập và chữ ký còn hạn.")
    full = raw if raw.startswith("/api/") else api.prefix + raw
    api.paths[full]["get"]["responses"]["200"] = {
        "description": "Nội dung file",
        "headers": {"Content-Disposition": {"schema": {"type": "string"}, "description": "attachment; filename=…"}},
        "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"},
                                                 "example": "%PDF-1.7 …"}}}
    sync_ops.append(api.paths[full]["get"])
    for op in sync_ops:
        op["responses"]["503"] = Api.r("AgentUnavailable")


def resource_paths(api: Api, realm: str, jobs: JobSeq):
    """Website, DB, SFTP, SSH key, cron, SSL, DNS, backup, WordPress, jobs, notifications, terminal.

    Dùng cho cả admin và portal (portal bị global scope theo chủ sở hữu; ngoài phạm vi trả 404).
    """
    P = "admin" if realm == "admin" else "portal"
    pre = "" if realm == "admin" else "portal"

    def oid(x):
        return x if realm == "admin" else "portal" + x[0].upper() + x[1:]

    w = D.WEBSITES[0]
    acc = D.ACCOUNTS[0]
    idp = [Api.p("Id")]
    acc_filter = [Api.p("FilterHostingAccount")]
    # -- websites
    api.add("get", "/websites", oid("listWebsites"), "Danh sách website", "Websites", list_=True,
            params=acc_filter + ([Api.p("FilterServer")] if realm == "admin" else []), ok=cref("Website"),
            ok_example=page(D.WEBSITES if realm == "admin" else D.WEBSITES[:2]))
    api.add("post", "/websites", oid("createWebsite"), "Tạo website", "Websites", body=cref("WebsiteCreate"),
            body_example={"hosting_account_uuid": acc["uuid"], "primary_domain": "shop.anphat.vn", "type": "php",
                          "document_root": "public", "php_version": "8.2", "ssl_mode": "acme", "proxy_target": None},
            job=True, job_example=jobs("website.create", "website", D.WEBSITES[1]["uuid"],
                                       ["fs.site_layout.ensure", "php.pool.apply", "nginx.vhost.apply", "cert.issue", "nginx.vhost.apply"], realm=realm))
    api.add("get", "/websites/{id}", oid("getWebsite"), "Chi tiết website", "Websites", params=idp, ok=cref("Website"),
            ok_example=one(w))
    api.add("patch", "/websites/{id}", oid("updateWebsite"), "Cập nhật website", "Websites", params=idp,
            body=cref("WebsiteUpdate"), body_example={"php_version": "8.3", "waf_enabled": True}, job=True,
            job_example=jobs("website.update", "website", w["uuid"], ["php.pool.apply", "nginx.vhost.apply"], realm=realm))
    api.add("delete", "/websites/{id}", oid("deleteWebsite"), "Xóa website", "Websites", params=idp, job=True,
            step_up=True, job_example=jobs("website.delete", "website", w["uuid"], ["nginx.vhost.remove", "php.pool.remove"],
                                           realm=realm))
    api.add("get", "/websites/{id}/domains", oid("listWebsiteDomains"), "Domain của website", "Websites", params=idp,
            list_=True, ok=cref("WebsiteDomain"), ok_example=page(D.DOMAINS))
    api.add("post", "/websites/{id}/domains", oid("addWebsiteDomain"), "Thêm domain phụ", "Websites", params=idp,
            body=cref("WebsiteDomainCreate"), body_example={"name": "www.anphat.vn", "type": "alias"}, job=True,
            job_example=jobs("website.domain.add", "website", w["uuid"], ["nginx.vhost.apply"], realm=realm))
    api.add("delete", "/websites/{id}/domains/{domain}", oid("removeWebsiteDomain"), "Gỡ domain phụ", "Websites",
            params=idp + [Api.p("DomainId")], job=True,
            job_example=jobs("website.domain.remove", "website", w["uuid"], ["nginx.vhost.apply"], realm=realm))
    api.add("get", "/websites/{id}/nginx", oid("getWebsiteNginx"), "Cấu hình Nginx của website", "Websites", params=idp,
            ok=cref("WebsiteNginx"), ok_example=one({"client_max_body_size": "64m", "http2": True, "hsts": True,
                                                     "extra_headers": {"X-Frame-Options": "SAMEORIGIN"}, "redirects": []}))
    api.add("patch", "/websites/{id}/nginx", oid("updateWebsiteNginx"), "Đổi cấu hình Nginx (giá trị trong allowlist)",
            "Websites", params=idp, body=cref("WebsiteNginx"), body_example={"client_max_body_size": "128m"}, job=True,
            job_example=jobs("website.nginx.update", "website", w["uuid"], ["nginx.vhost.apply"], realm=realm))
    api.add("get", "/websites/{id}/php", oid("getWebsitePhp"), "Cấu hình PHP của website", "Websites", params=idp,
            ok=cref("WebsitePhp"), ok_example=one({"version": "8.3", "memory_limit": "256m", "max_execution_time": 60,
                                                   "upload_max_filesize": "64m", "pm_max_children": 6,
                                                   "disable_functions": ["exec", "shell_exec", "system", "passthru", "proc_open"]}))
    api.add("patch", "/websites/{id}/php", oid("updateWebsitePhp"), "Đổi cấu hình PHP (trong giới hạn gói)", "Websites",
            params=idp, body=cref("WebsitePhp"), body_example={"memory_limit": "512m"}, job=True,
            job_example=jobs("website.php.update", "website", w["uuid"], ["php.pool.apply"], realm=realm))
    op = api.add("get", "/websites/{id}/logs", oid("getWebsiteLogs"), "Log truy cập/lỗi (dòng cuối)", "Websites",
            params=idp + [Api.p("LogKind"), Api.p("Lines")], ok=arr(s()),
            ok_example=one(['203.0.113.50 - - [20/Nov/2026:08:14:59 +0700] "GET / HTTP/2.0" 200 5123']),
            desc="Đọc trực tiếp qua op `log.tail` của agent (không tạo job); tối đa 500 dòng, `lines` lớn hơn bị giới hạn ở 500. "
                 "Agent không kết nối → 503.")
    op["responses"]["503"] = Api.r("AgentUnavailable")
    # -- SSL
    api.add("get", "/certificates", oid("listCertificates"), "Chứng chỉ SSL", "SSL", list_=True, params=acc_filter,
            ok=cref("Certificate"), ok_example=page(D.CERTS if realm == "admin" else D.CERTS[:1]))
    api.add("post", "/websites/{id}/certificates", oid("requestCertificate"), "Cấp/tải lên chứng chỉ", "SSL", params=idp,
            body=cref("CertificateRequest"),
            body_example={"source": "acme", "domains": ["anphat.vn", "www.anphat.vn"], "certificate_pem": None,
                          "private_key_pem": None},
            job=True, job_example=jobs("certificate.issue", "website", w["uuid"], ["cert.issue", "nginx.vhost.apply"],
                                       realm=realm))
    api.add("post", "/certificates/{id}:renew", oid("renewCertificate"), "Gia hạn ngay", "SSL", params=idp, job=True,
            job_example=jobs("certificate.renew", "certificate", D.CERTS[0]["uuid"], ["cert.issue"], realm=realm))
    api.add("delete", "/certificates/{id}", oid("deleteCertificate"), "Xóa chứng chỉ", "SSL", params=idp, job=True,
            job_example=jobs("certificate.delete", "certificate", D.CERTS[0]["uuid"], ["cert.remove", "nginx.vhost.apply"],
                             realm=realm))
    # -- databases
    api.add("get", "/databases", oid("listDatabases"), "Danh sách database", "Databases", list_=True, params=acc_filter,
            ok=cref("Database"), ok_example=page(D.DATABASES if realm == "admin" else D.DATABASES[:2]))
    api.add("post", "/databases", oid("createDatabase"), "Tạo database", "Databases", body=cref("DatabaseCreate"),
            body_example={"hosting_account_uuid": acc["uuid"], "engine": "mariadb", "name": "anphat_crm", "create_user": True},
            job=True, job_example=jobs("database.create", "database", D.DATABASES[0]["uuid"],
                                       ["db.mysql.create", "db.mysql.user_ensure", "db.mysql.grant"], realm=realm))
    api.add("get", "/databases/{id}", oid("getDatabase"), "Chi tiết database", "Databases", params=idp, ok=cref("Database"),
            ok_example=one(D.DATABASES[0]))
    api.add("delete", "/databases/{id}", oid("deleteDatabase"), "Xóa database", "Databases", params=idp, job=True,
            step_up=True, job_example=jobs("database.delete", "database", D.DATABASES[0]["uuid"],
                                           ["db.mysql.dump", "db.mysql.drop"], realm=realm))
    api.add("post", "/databases/{id}:export", oid("exportDatabase"), "Xuất dump vào home account", "Databases", params=idp,
            job=True, job_example=jobs("database.export", "database", D.DATABASES[0]["uuid"], ["db.mysql.dump"], realm=realm))
    api.add("post", "/databases/{id}:import", oid("importDatabase"), "Nhập dump từ file trong home", "Databases",
            params=idp, body=obj({"path": cref("RelPath")}), body_example={"path": "backups/anphat_web.sql.gz"}, job=True,
            job_example=jobs("database.import", "database", D.DATABASES[0]["uuid"], ["db.mysql.import"], realm=realm))
    api.add("get", "/database-users", oid("listDatabaseUsers"), "DB user", "Databases", list_=True, params=acc_filter,
            ok=cref("DatabaseUser"), ok_example=page(D.DB_USERS))
    api.add("post", "/database-users", oid("createDatabaseUser"), "Tạo DB user", "Databases",
            body=cref("DatabaseUserCreate"),
            body_example={"hosting_account_uuid": acc["uuid"], "engine": "mariadb", "username": "anphat_report"},
            job=True, job_example=jobs("database_user.create", "database_user", D.DB_USERS[0]["uuid"],
                                       ["db.mysql.user_ensure"], realm=realm))
    api.add("delete", "/database-users/{id}", oid("deleteDatabaseUser"), "Xóa DB user", "Databases", params=idp,
            job=True, job_example=jobs("database_user.delete", "database_user", D.DB_USERS[0]["uuid"],
                                       ["db.mysql.user_drop"], realm=realm))
    api.add("post", "/database-users/{id}:rotate-password", oid("rotateDatabaseUserPassword"), "Đổi mật khẩu DB user",
            "Databases", params=idp, ok=cref("SecretOnce"), ok_example=one({"secret": "q8V!r2#Lm9@xT4zK7pW1"}))
    api.add("put", "/database-users/{id}/grants", oid("setDatabaseUserGrants"), "Đặt quyền DB user", "Databases",
            params=idp, body=obj({"grants": arr(cref("DatabaseGrant"))}),
            body_example={"grants": [{"database": "anphat_web", "privileges": ["SELECT"]}]}, job=True,
            job_example=jobs("database_user.grant", "database_user", D.DB_USERS[0]["uuid"], ["db.mysql.grant"], realm=realm))
    # -- files
    files_paths(api, "/hosting-accounts", "Files", "" if realm == "admin" else "portal", jobs, realm)
    # -- sftp, ssh
    api.add("get", "/sftp-accounts", oid("listSftpAccounts"), "Tài khoản SFTP/FTPS", "SFTP", list_=True,
            params=acc_filter, ok=cref("SftpAccount"), ok_example=page(D.SFTP))
    api.add("post", "/sftp-accounts", oid("createSftpAccount"), "Tạo tài khoản SFTP/FTPS", "SFTP",
            body=cref("SftpAccountCreate"),
            body_example={"hosting_account_uuid": acc["uuid"], "username": "anphat_deploy", "protocol": "sftp",
                          "root_path": "sites/anphat.vn", "read_only": False, "password": None},
            job=True, job_example=jobs("sftp.create", "sftp_account", D.SFTP[0]["uuid"], ["sftp.user.ensure"], realm=realm))
    api.add("post", "/sftp-accounts/{id}:rotate-password", oid("rotateSftpPassword"), "Đặt mật khẩu mới (trả một lần)",
            "SFTP", params=idp, job=True,
            job_example=jobs("sftp.password", "sftp_account", D.SFTP[0]["uuid"], ["ftp.user.ensure"], realm=realm))
    api.add("delete", "/sftp-accounts/{id}", oid("deleteSftpAccount"), "Xóa tài khoản SFTP", "SFTP", params=idp,
            job=True, job_example=jobs("sftp.delete", "sftp_account", D.SFTP[0]["uuid"], ["sftp.user.remove"], realm=realm))
    api.add("get", "/ssh-keys", oid("listSshKeys"), "SSH key", "SFTP", list_=True, params=acc_filter, ok=cref("SshKey"),
            ok_example=page(D.SSH_KEYS))
    api.add("post", "/ssh-keys", oid("createSshKey"), "Thêm SSH key (gói phải cho phép SSH)", "SFTP",
            body=cref("SshKeyCreate"),
            body_example={"hosting_account_uuid": acc["uuid"], "name": "Laptop IT An Phát",
                          "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq8 it@anphat"},
            job=True, job_example=jobs("ssh_key.create", "ssh_key", D.SSH_KEYS[0]["uuid"], ["ssh.keys.apply"], realm=realm))
    api.add("delete", "/ssh-keys/{id}", oid("deleteSshKey"), "Xóa SSH key", "SFTP", params=idp, job=True,
            job_example=jobs("ssh_key.delete", "ssh_key", D.SSH_KEYS[0]["uuid"], ["ssh.keys.apply"], realm=realm))
    # -- cron
    api.add("get", "/cron-jobs", oid("listCronJobs"), "Cron job", "Cron", list_=True, params=acc_filter,
            ok=cref("CronJob"), ok_example=page(D.CRON))
    api.add("post", "/cron-jobs", oid("createCronJob"), "Tạo cron job", "Cron", body=cref("CronJobCreate"),
            body_example={"hosting_account_uuid": acc["uuid"], "website_uuid": w["uuid"], "schedule": "*/15 * * * *",
                          "command": "php artisan schedule:run", "working_dir": "sites/anphat.vn", "php_version": "8.3",
                          "enabled": True},
            job=True, job_example=jobs("cron.create", "cron_job", D.CRON[0]["uuid"], ["cron.apply"], realm=realm))
    api.add("patch", "/cron-jobs/{id}", oid("updateCronJob"), "Sửa cron job", "Cron", params=idp,
            body=cref("CronJobUpdate"), body_example={"enabled": False}, job=True,
            job_example=jobs("cron.update", "cron_job", D.CRON[0]["uuid"], ["cron.apply"], realm=realm))
    api.add("delete", "/cron-jobs/{id}", oid("deleteCronJob"), "Xóa cron job", "Cron", params=idp, job=True,
            job_example=jobs("cron.delete", "cron_job", D.CRON[0]["uuid"], ["cron.apply"], realm=realm))
    api.add("post", "/cron-jobs/{id}:run", oid("runCronJob"), "Chạy ngay", "Cron", params=idp, job=True,
            job_example=jobs("cron.run", "cron_job", D.CRON[0]["uuid"], ["cron.run_once"], realm=realm))
    api.add("get", "/cron-jobs/{id}/runs", oid("listCronRuns"), "Lịch sử chạy", "Cron", params=idp, list_=True,
            ok=cref("CronRun"), ok_example=page(D.CRON_RUNS))
    # -- DNS (chỉ admin: portal không quản lý DNS theo sitemap)
    if realm == "admin":
        api.add("get", "/dns/providers", oid("listDnsProviders"), "Nhà cung cấp DNS (Cloudflare)", "DNS", list_=True,
                ok=ref("DnsProvider"), ok_example=page(D.DNS_PROVIDERS))
        api.add("post", "/dns/providers", oid("createDnsProvider"), "Thêm nhà cung cấp DNS", "DNS",
                body=ref("DnsProviderCreate"), body_example={"type": "cloudflare", "name": "Cloudflare IT",
                                                             "api_token": "cf_token_example_0123456789abcdef"},
                ok=ref("DnsProvider"), ok_example=one(D.DNS_PROVIDERS[0]), status="201",
                desc="Kiểm token bằng API Cloudflare trước khi lưu (token sai → 422). Token lưu mã hóa, không bao giờ trả về (D-70).")
        api.add("delete", "/dns/providers/{id}", oid("deleteDnsProvider"), "Xóa nhà cung cấp DNS", "DNS", params=idp,
                no_content=True, step_up=True, desc="Còn zone gắn với provider → 409 `resource_locked`.")
        api.add("get", "/dns/zones", oid("listDnsZones"), "DNS zone", "DNS", list_=True, ok=cref("DnsZone"),
                ok_example=page(D.DNS_ZONES))
        api.add("post", "/dns/zones", oid("createDnsZone"), "Gắn zone có sẵn trên Cloudflare vào panel", "DNS",
                body=ref("DnsZoneCreate"), body_example={"provider_uuid": D.DNS_PROVIDERS[0]["uuid"], "name": "anphat.vn",
                                                         "hosting_account_uuid": D.ACCOUNTS[0]["uuid"]},
                ok=cref("DnsZone"), ok_example=one(D.DNS_ZONES[0]), status="201",
                desc="Zone phải tồn tại trong tài khoản Cloudflare của provider (không có → 422). Record được đồng bộ ngay.")
        api.add("patch", "/dns/zones/{id}", oid("updateDnsZone"), "Đổi account gắn với zone", "DNS", params=idp,
                body=ref("DnsZoneUpdate"), body_example={"hosting_account_uuid": None}, ok=cref("DnsZone"),
                ok_example=one(D.DNS_ZONES[0]))
        api.add("delete", "/dns/zones/{id}", oid("deleteDnsZone"), "Bỏ zone khỏi panel (không xóa trên Cloudflare)", "DNS",
                params=idp, no_content=True)
        api.add("post", "/dns/zones/{id}:sync", oid("syncDnsZone"), "Đồng bộ record từ Cloudflare", "DNS", params=idp,
                ok=cref("DnsZone"), ok_example=one(D.DNS_ZONES[0]))
        api.add("get", "/dns/zones/{id}/records", oid("listDnsRecords"), "Record của zone", "DNS", params=idp, list_=True,
                ok=cref("DnsRecord"), ok_example=page(D.DNS_RECORDS))
        api.add("post", "/dns/zones/{id}/records", oid("createDnsRecord"), "Thêm record", "DNS", params=idp,
                body=cref("DnsRecordInput"), body_example={"type": "TXT", "name": "@", "content": "v=spf1 mx -all", "ttl": 3600},
                job=True, job_example=jobs("dns.record.create", "dns_zone", D.DNS_ZONES[0]["uuid"], ["dns.records.apply"],
                                           realm=realm, server=None))
        api.add("patch", "/dns/zones/{id}/records/{record}", oid("updateDnsRecord"), "Sửa record", "DNS",
                params=idp + [Api.p("RecordId")], body=partial(COMMON, "DnsRecordInput", cref), body_example={"ttl": 600}, job=True,
                job_example=jobs("dns.record.update", "dns_zone", D.DNS_ZONES[0]["uuid"], ["dns.records.apply"], realm=realm,
                                 server=None))
        api.add("delete", "/dns/zones/{id}/records/{record}", oid("deleteDnsRecord"), "Xóa record", "DNS",
                params=idp + [Api.p("RecordId")], job=True,
                job_example=jobs("dns.record.delete", "dns_zone", D.DNS_ZONES[0]["uuid"], ["dns.records.apply"], realm=realm,
                                 server=None))
    # -- backups
    api.add("get", "/backup-snapshots", oid("listBackupSnapshots"), "Bản backup", "Backups", list_=True,
            params=acc_filter + [Api.p("FilterScopeType")] + ([Api.p("FilterDestination")] if realm == "admin" else []),
            ok=cref("BackupSnapshot"), ok_example=page(D.SNAPSHOTS[:1] if realm == "portal" else D.SNAPSHOTS))
    api.add("post", "/backups", oid("createBackup"), "Backup ngay (trong quota)", "Backups", body=cref("BackupRequest"),
            body_example={"hosting_account_uuid": acc["uuid"], "contents": ["files", "databases"], "note": "Trước khi nâng cấp"},
            job=True, job_example=jobs("backup.run", "hosting_account", acc["uuid"], ["backup.run", "backup.check"], realm=realm))
    api.add("get", "/backup-snapshots/{id}/browse", oid("browseBackupSnapshot"), "Duyệt file trong snapshot", "Backups",
            params=idp + [Api.p("PathQuery")], list_=True, ok=cref("FileEntry"), ok_example=page(D.FILES[:2]))
    api.add("post", "/backup-snapshots/{id}:download-link", oid("backupDownloadLink"), "Link tải bản backup", "Backups",
            params=idp, body=cref("BackupDownloadRequest"), body_example={"path": "sites/anphat.vn/public/wp-config.php"},
            ok=cref("SignedUrl"),
            desc="Link ký HMAC hết hạn 5 phút tới `/backup-snapshots/{id}/raw`; chỉ tải từng file (`path` bắt buộc, null → 422: "
                 "lấy cả snapshot bằng khôi phục). File được agent đọc từ snapshot (`restic dump`) khi tải.",
            ok_example=one({"url": "https://portal.itso.local/api/v1/portal/backup-snapshots/01938a0e-0001-7000-8000-00000e000001/raw"
                                   "?path=sites%2Fanphat.vn%2Fpublic%2Fwp-config.php&expires=1763605200&signature=abc",
                            "expires_at": "2026-11-20T09:15:00+07:00"}))
    braw = "/backup-snapshots/{id}/raw"
    api.add("get", braw, oid("downloadBackupFile"), "Tải một file từ snapshot (URL ký số từ download-link)", "Backups",
            params=idp + [Api.p("PathQuery"), Api.p("Expires"), Api.p("Signature")], ok=None,
            desc="Stream file theo khúc 1 MiB qua agent (`backup.file.read`, `restic dump`); tối đa 512 MiB. Cần phiên đăng nhập "
                 "và chữ ký còn hạn (HMAC, 5 phút).")
    bfull = api.prefix + braw
    api.paths[bfull]["get"]["responses"]["200"] = {
        "description": "Nội dung file",
        "headers": {"Content-Disposition": {"schema": {"type": "string"}, "description": "attachment; filename=…"}},
        "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}, "example": "<?php …"}}}
    api.paths[bfull]["get"]["responses"]["503"] = Api.r("AgentUnavailable")
    api.add("get", "/restores", oid("listRestores"), "Lịch sử khôi phục", "Backups", list_=True, ok=cref("Restore"),
            ok_example=page(D.RESTORES))
    api.add("post", "/restores", oid("createRestore"), "Khôi phục", "Backups", body=cref("RestoreRequest"),
            body_example={"snapshot_uuid": D.SNAPSHOTS[0]["uuid"], "mode": "new", "items": ["files:sites/anphat.vn"],
                          "target_server_uuid": None, "confirm": None},
            job=True, step_up=True,
            desc="`mode=overwrite` yêu cầu step-up MFA và `confirm` = username account."
                 + (" Admin có thể chọn `target_server_uuid` khác server gốc." if realm == "admin" else ""),
            job_example=jobs("backup.restore", "hosting_account", acc["uuid"], ["backup.restore"], realm=realm))
    api.add("get", "/restores/{id}", oid("getRestore"), "Chi tiết khôi phục", "Backups", params=idp, ok=cref("Restore"),
            ok_example=one(D.RESTORES[0]))
    # -- WordPress
    wp = D.WORDPRESS[0]
    api.add("get", "/wordpress/sites", oid("listWordPressSites"), "Site WordPress", "WordPress", list_=True,
            ok=cref("WordPressSite"), ok_example=page(D.WORDPRESS))
    api.add("post", "/wordpress/sites", oid("installWordPress"), "Cài WordPress vào website", "WordPress",
            body=cref("WordPressInstall"),
            body_example={"website_uuid": D.WEBSITES[1]["uuid"], "title": "Shop An Phát", "admin_username": "anphat_admin",
                          "admin_email": "it@anphat.vn", "locale": "vi"},
            job=True, job_example=jobs("wordpress.install", "website", D.WEBSITES[1]["uuid"],
                                       ["db.mysql.create", "wp.install"], realm=realm))
    api.add("post", "/wordpress/sites:scan", oid("scanWordPressSites"), "Quét phát hiện site WordPress", "WordPress",
            job=True, desc="Quét docroot các website trong phạm vi (wp.detect, D-99); site mới xuất hiện trong danh sách.",
            job_example=jobs("wordpress.scan", None, None, ["wp.detect"], realm=realm, server=2))
    api.add("get", "/wordpress/sites/{id}", oid("getWordPressSite"), "Chi tiết site WordPress", "WordPress", params=idp,
            ok=cref("WordPressSiteDetail"), ok_example=one(D.WORDPRESS_DETAIL))
    api.add("patch", "/wordpress/sites/{id}", oid("updateWordPressSettings"), "Chính sách tự cập nhật", "WordPress",
            params=idp, body=cref("WordPressSettings"), body_example={"auto_update": "minor", "update_window": "02:00-05:00"},
            ok=cref("WordPressSite"), ok_example=one(wp))
    api.add("get", "/wordpress/sites/{id}/updates", oid("listWordPressUpdates"), "Lịch sử cập nhật", "WordPress",
            params=idp, list_=True, ok=cref("WordPressUpdate"), ok_example=page(D.WORDPRESS_UPDATES))
    for action, label, steps, body, ex, step_up in [
            ("update", "Cập nhật core/plugin/theme (snapshot trước, lỗi thì rollback)", ["backup.run", "wp.maintenance", "wp.update", "http.check"],
             "WordPressUpdateRequest", {"core": True, "plugins": ["wp-mail-smtp"], "themes": []}, False),
            ("clone-staging", "Tạo bản staging", ["fs.site_layout.ensure", "nginx.vhost.apply", "wp.clone"], "WordPressCloneRequest",
             {"subdomain": "staging", "basic_auth": True, "noindex": True}, False),
            ("harden", "Áp dụng hardening", ["wp.harden", "nginx.vhost.apply"], "WordPressHardenRequest",
             {"items": ["xmlrpc_blocked", "php_in_uploads_blocked"], "enabled": True}, False),
            ("admin-password", "Đổi mật khẩu admin WordPress", ["wp.admin_password"], "WordPressPassword",
             {"password": "N3w-Strong.Pass2026"}, True),
            ("maintenance", "Bật/tắt chế độ bảo trì", ["wp.maintenance"], "WordPressMaintenance", {"enabled": True}, False)]:
        api.add("post", f"/wordpress/sites/{{id}}:{action}", oid("wordPress" + "".join(x.title() for x in action.split("-"))),
                label, "WordPress", params=idp, job=True, body=cref(body), body_example=ex, step_up=step_up,
                job_example=jobs(f"wordpress.{action.replace('-', '_')}", "wordpress_site", wp["uuid"], steps, realm=realm,
                                 server=2))
    # -- Git deploy (module 22). Webhook công khai POST /hooks/git/{token} để Phase 10.
    g = D.GIT_REPOSITORIES[0]
    api.add("get", "/git-repositories", oid("listGitRepositories"), "Repository Git gắn với website", "Git",
            list_=True, params=acc_filter, ok=cref("GitRepository"),
            ok_example=page(D.GIT_REPOSITORIES[:1] if realm == "portal" else D.GIT_REPOSITORIES))
    api.add("post", "/git-repositories", oid("createGitRepository"), "Kết nối repository (sinh deploy key riêng)", "Git",
            body=cref("GitRepositoryCreate"),
            body_example={"website_uuid": D.WEBSITES[1]["uuid"], "repo_url": "git@github.com:anphat-it/shop.git",
                          "branch": "main", "auto_deploy": False, "build_command": None, "shared_paths": [".env"],
                          "keep_releases": 5},
            ok=cref("GitRepository"), ok_example=one(g), status="201",
            desc="Panel sinh cặp khóa ed25519 cho site; khóa riêng chỉ nằm ở agent. Thêm `deploy_key_public` vào repo "
                 "(chỉ đọc) trước khi deploy.")
    api.add("get", "/git-repositories/{id}", oid("getGitRepository"), "Chi tiết repository", "Git", params=idp,
            ok=cref("GitRepository"), ok_example=one(g))
    api.add("patch", "/git-repositories/{id}", oid("updateGitRepository"), "Sửa cấu hình deploy", "Git", params=idp,
            body=cref("GitRepositoryUpdate"), body_example={"auto_deploy": False}, ok=cref("GitRepository"),
            ok_example=one(g | {"auto_deploy": False}))
    api.add("delete", "/git-repositories/{id}", oid("deleteGitRepository"),
            "Ngắt kết nối repository (giữ release hiện tại)", "Git", params=idp, no_content=True)
    api.add("post", "/git-repositories/{id}:rotate-webhook-secret", oid("rotateGitWebhookSecret"),
            "Đổi secret webhook (HMAC-SHA256)", "Git", params=idp, ok=cref("SecretOnce"),
            ok_example=one({"secret": "whsec_4Tq9mZ2vL8xR1nB6"}))
    api.add("get", "/git-repositories/{id}/deployments", oid("listGitDeployments"), "Lịch sử deploy", "Git",
            params=idp, list_=True, ok=cref("GitDeployment"),
            ok_example=page([x for x in D.GIT_DEPLOYMENTS if x["repository_uuid"] == g["uuid"]]))
    api.add("post", "/git-repositories/{id}/deployments", oid("createGitDeployment"),
            "Deploy (commit mới nhất của branch hoặc commit chỉ định)", "Git", params=idp,
            body=cref("GitDeployRequest"), body_example={"commit_sha": None}, job=True,
            job_example=jobs("git.deploy", "git_repository", g["uuid"], ["git.deploy"], realm=realm))
    api.add("post", "/git-deployments/{id}:rollback", oid("rollbackGitDeployment"),
            "Quay về release này (đổi symlink)", "Git", params=idp, job=True,
            job_example=jobs("git.rollback", "git_repository", g["uuid"], ["git.rollback"], realm=realm))
    # -- jobs
    jp = "/jobs"
    jobs_ex = copy.deepcopy(D.JOBS)
    for jx in jobs_ex:
        jx["links"] = {k: v.replace("/admin/", f"/{P}/") for k, v in jx["links"].items()}
    api.add("get", jp, oid("listJobs"), "Danh sách job", "Jobs", list_=True, params=[Api.p("FilterState")],
            ok=cref("Job"), ok_example=page(jobs_ex))
    api.add("get", jp + "/{id}", oid("getJob"), "Chi tiết job (gồm các bước)", "Jobs", params=idp, ok=cref("Job"),
            ok_example=one(jobs_ex[1]))
    api.add("get", jp + "/{id}/logs", oid("getJobLogs"), "Log job", "Jobs", params=idp, list_=True, ok=cref("JobLog"),
            ok_example=page(D.JOB_LOGS))
    api.add("post", jp + "/{id}:cancel", oid("cancelJob"), "Yêu cầu hủy job", "Jobs", params=idp, ok=cref("Job"),
            ok_example=one(jobs_ex[1] | {"state": "cancel_requested"}))
    api.add("post", jp + "/{id}:retry", oid("retryJob"), "Chạy lại job thất bại/đã hủy (tạo job mới cùng tham số)",
            "Jobs", params=idp, job=True,
            desc="Chỉ job `failed`, `cancelled`, `timed_out`; job khác → 409 `conflict`. Job mới tham chiếu cùng tài nguyên.",
            job_example=jobs(jobs_ex[1]["type"], jobs_ex[1]["resource"]["type"], jobs_ex[1]["resource"]["uuid"],
                             [st["op"] for st in jobs_ex[1]["steps"]], realm=realm))
    ev = api.add("get", jp + "/{id}/events", oid("streamJobEvents"), "Luồng tiến độ (SSE)", "Jobs",
                 params=idp + [{"name": "Last-Event-ID", "in": "header", "required": False, "schema": s(maxLength=20, pattern="^[0-9]{1,20}$"),
                                "description": "Nối lại: chỉ gửi sự kiện có id lớn hơn (EventSource tự gửi)."}],
                 ok=None, desc="`text/event-stream` (D-106, ADR 0051). Sự kiện đầu `event: job` là snapshot Job JSON; sau đó "
                 "`event: log` (JobLog JSON) cho mỗi dòng log mới và `event: job` khi trạng thái/tiến độ đổi. `id:` = seq của log "
                 "(tăng dần) để nối lại bằng `Last-Event-ID`. Heartbeat comment mỗi 15 giây; giữ tối đa 5 phút hoặc tới khi job "
                 "kết thúc; client lỗi SSE thì quay về poll `GET /jobs/{id}` 2 giây. Kiểm quyền như `GET /jobs/{id}`.")
    ev["responses"]["200"]["content"] = {"text/event-stream": {"schema": s(),
                                                                "example": ("retry: 2000\nid: 41\nevent: job\ndata: {\"uuid\":\"%s\",\"state\":\"running\",\"progress\":60}\n\n"
                                                                            "id: 42\nevent: log\ndata: {\"seq\":42,\"at\":\"2026-11-20T08:00:05+07:00\",\"level\":\"info\",\"message\":\"Bước 2 xong.\"}\n\n"
                                                                            ": ping\n\n") % jobs_ex[1]["uuid"]}}
    # -- notifications
    api.add("get", "/notifications", oid("listNotifications"), "Thông báo", "Notifications", list_=True,
            ok=cref("Notification"), ok_example=page(D.NOTIFICATIONS))
    api.add("post", "/notifications/{id}:read", oid("markNotificationRead"), "Đánh dấu đã đọc", "Notifications",
            params=idp, no_content=True)
    api.add("post", "/notifications:read-all", oid("markAllNotificationsRead"), "Đọc tất cả", "Notifications",
            no_content=True)
    api.add("get", "/notification-preferences", oid("getNotificationPreferences"), "Tùy chọn thông báo",
            "Notifications", ok=cref("NotificationPreferences"), ok_example=one(D.NOTIFICATION_PREFS))
    api.add("patch", "/notification-preferences", oid("updateNotificationPreferences"), "Đổi tùy chọn thông báo",
            "Notifications", body=cref("NotificationPreferences"),
            body_example={"channels": {"email": True, "telegram": False, "in_app": True},
                          "events": {"backup.failed": ["email"]}, "updated_at": D.T2},
            ok=cref("NotificationPreferences"), ok_example=one(D.NOTIFICATION_PREFS))
    api.add("get", "/notification-events", oid("listNotificationEvents"), "Danh mục sự kiện thông báo",
            "Notifications", list_=True, ok=cref("NotificationEvent"),
            ok_example=page(D.NOTIFICATION_EVENTS if realm == "admin"
                            else [e for e in D.NOTIFICATION_EVENTS if "user" in e["audiences"]]),
            desc="Portal chỉ thấy sự kiện có đối tượng `user`; kênh của USER chỉ `in_app` và `email` (D-104).")
    # -- terminal
    term_ex = D.TERMINAL if realm == "portal" else D.TERMINAL | {"ws_url": "wss://admin.itso.local/gateway/terminal"}
    term_op = api.add("post", "/terminal/sessions", oid("createTerminalSession"), "Mở terminal (ticket 30 giây, dùng một lần)",
            "Terminal", body=cref("TerminalRequest"),
            body_example={"hosting_account_uuid": acc["uuid"], "server_uuid": None, "mode": "account"},
            ok=cref("TerminalTicket"), ok_example=one(term_ex), status="201", step_up=True,
            desc=("`mode=root` chỉ chạy khi policy cục bộ của agent cho phép (mặc định tắt)." if realm == "admin"
                  else "Chỉ khi gói cho phép SSH; shell chạy trong jail của account. `mode=root` luôn bị từ chối."))
    term_op["responses"]["503"] = Api.r("AgentUnavailable")  # pty.open gọi agent đồng bộ
    return pre


# ---------------------------------------------------------------- wizard cài đặt lần đầu (Phase 4)
def setup_paths(api: Api, jobs):
    csrf = [{"csrfToken": []}]
    gone = {"$ref": "./common.yaml#/components/responses/Gone"}
    conflict = {"$ref": "./common.yaml#/components/responses/Conflict"}
    forbidden = {"$ref": "./common.yaml#/components/responses/Forbidden"}
    st = D.SETUP_STATUS

    def public(method, path, op_id, summary, *, extra=(), **kw):
        op = api.add(method, path, op_id, summary, "Setup", public=True, security=csrf if method != "get" else [], **kw)
        for code in extra:
            op["responses"][code] = {"409": conflict, "410": gone, "403": forbidden}[code]
        return op

    public("get", "/setup/status", "getSetupStatus", "Trạng thái wizard cài đặt", ok=ref("SetupStatus"),
           ok_example=one(st), desc="Công khai để trang /install biết bước hiện tại. Không lộ dữ liệu khi đã cài xong.")
    public("post", "/setup/code:verify", "verifySetupCode", "Xác minh mã thiết lập một lần", extra=("409", "410"),
           body=ref("SetupCodeVerify"), body_example={"code": "K7QM-2XPA-9RTD"}, ok=ref("SetupStatus"),
           ok_example=one({**st, "code_verified": True, "steps_done": ["code"]}),
           desc="Mã do `sudo itso setup-code` tạo (agent chỉ lưu sha256, hết hạn sau 60 phút). Mã sai → 422; "
                "mã đã dùng hoặc hết hạn → 409 `setup_code_used`/`setup_code_expired`; đã cài xong → 410.")
    public("put", "/setup/preferences", "putSetupPreferences", "Bước 1: ngôn ngữ, múi giờ", extra=("403", "410"),
           body=ref("SetupPreferences"), body_example={"locale": "vi", "timezone": "Asia/Ho_Chi_Minh"},
           ok=ref("SetupStatus"), ok_example=one({**st, "code_verified": True, "steps_done": ["code", "language"]}),
           desc="Cần phiên đã xác minh mã (403 nếu chưa).")
    public("post", "/setup/admin", "createSetupAdmin", "Bước 2: tạo SUPER_ADMIN đầu tiên và đăng nhập",
           extra=("403", "409", "410"), body=ref("SetupAdmin"),
           body_example={"name": "Nguyễn Văn An", "email": "an.nguyen@itso.local", "password": "Mat-khau-du-dai-2026"},
           ok=cref("Me"), ok_example=one(D.ME_ADMIN), status="201",
           desc="Cần phiên đã xác minh mã. Tạo một lần (409 nếu wizard đã tạo SA). TOTP bắt buộc đăng ký ngay sau đó "
                "qua `/api/v1/auth/mfa/totp:enroll` và `:confirm`.")
    op = api.add("put", "/setup/access", "putSetupAccess", "Bước 3: truy cập panel (domain, port, entrance, allowlist)",
                 "Setup", body=ref("SetupAccess"),
                 body_example={"panel_domain": "panel.itso.local", "panel_port": 8443, "entrance_path": "/itso-a7k2",
                               "allowlist": ["10.10.5.0/24", "203.0.113.7"]},
                 ok=ref("SetupStatus"), ok_example=one({**st, "code_verified": True, "admin_created": True,
                                                        "admin_mfa_enabled": True, "access": D.SETUP_ACCESS,
                                                        "steps_done": ["code", "language", "admin", "access"]}),
                 desc="Chỉ SUPER_ADMIN do wizard tạo, đã bật TOTP (403 nếu chưa).")
    op["responses"]["410"] = gone
    op = api.add("get", "/setup/stack", "getSetupStack", "Bước 4: trạng thái web stack (Nginx, PHP 8.3, lego)", "Setup",
                 ok=ref("SetupStack"), ok_example=one(D.SETUP_STACK),
                 desc="Chỉ SUPER_ADMIN do wizard tạo, đã bật TOTP. Bước này không bắt buộc để hoàn tất wizard.")
    op["responses"]["410"] = gone
    op = api.add("post", "/setup/stack:install", "installSetupStack", "Bước 4: cài web stack còn thiếu qua job", "Setup",
                 job=True, job_example=jobs("setup.stack", "server", D.SERVERS[0]["uuid"],
                                            ["software.install", "php.version.install", "software.install"]),
                 desc="Cài phần còn thiếu trên server panel (bỏ qua phần đã cài): recipe `nginx`, PHP 8.3 qua "
                      "`php.version.install` (tắt master mặc định của gói, D-68), recipe `lego`.")
    op["responses"]["410"] = gone
    op = api.add("get", "/setup/quota", "getSetupQuota", "Bước 6: trạng thái disk quota của server panel", "Setup",
                 ok=ref("SetupQuota"), ok_example=one({"mode": "kernel", "server": D.server_ref(0), "facts_at": D.T2}))
    op["responses"]["410"] = gone
    public("post", "/setup/restore:inspect", "inspectSetupRestore", "Khôi phục thảm họa: mở repo panel, liệt kê bản backup panel",
           extra=("403", "409", "410"), body=ref("SetupRestoreSource"),
           body_example={"type": "s3", "config": {"endpoint": "https://s3.ap-southeast-1.example.com", "bucket": "itso-backup"},
                         "credentials": {"access_key": "AKIA…", "secret_key": "********"},
                         "repository_path": "itso/" + D.SERVERS[0]["uuid"] + "/server",
                         "repository_password": "demo-Rk7-panel-9fQ2-xV4m-T8sL-3bNw", "panel_private_key": D.RECOVERY_KIT["panel_private_key"]},
           ok={"type": "array", "items": ref("SetupRestoreCandidate")}, ok_example=one(D.SETUP_RESTORE_CANDIDATES),
           desc="Cần phiên đã xác minh mã thiết lập (403 nếu chưa). Không lưu credential/mật khẩu/khóa riêng; sai mật khẩu → 422; đích SFTP → 422 (dùng CLI `itso backup panel-restore`, cần khóa SSH + host key của đích); wizard đã tạo SUPER_ADMIN → 409.")
    op = public("post", "/setup/restore", "startSetupRestore", "Khôi phục thảm họa: khôi phục DB panel + cấu hình rồi `itso repair`",
                extra=("403", "409", "410"), body=ref("SetupRestoreRequest"),
                body_example={"source": {"type": "s3", "config": {"endpoint": "https://s3.ap-southeast-1.example.com",
                                                                  "bucket": "itso-backup"},
                                         "credentials": {"access_key": "AKIA…", "secret_key": "********"},
                                         "repository_path": "itso/" + D.SERVERS[0]["uuid"] + "/server",
                         "repository_password": "demo-Rk7-panel-9fQ2-xV4m-T8sL-3bNw", "panel_private_key": D.RECOVERY_KIT["panel_private_key"]},
                              "snapshot_id": "6b3e91f0"},
                job=True, job_example=jobs("setup.restore", "server", D.SERVERS[0]["uuid"],
                                           ["panel.restore"]),
                desc="Chỉ khi wizard chưa tạo SUPER_ADMIN. Job giải mã backup panel vào staging; vài giây sau "
                     "`itso panel-restore-apply` thay DB panel + /etc/itso (giữ mật khẩu DB/Redis, TLS của máy mới), migrate, "
                     "`itso:reconcile` rồi khôi phục dữ liệu account song song có giới hạn (`itso:dr-restore`). Sau đó đăng nhập "
                     "bằng tài khoản cũ (D-87, docs/runbooks/disaster-recovery.md)."),
    op = api.add("post", "/setup:complete", "completeSetup", "Bước 9: tổng kết và khóa wizard", "Setup",
                 ok=ref("SetupStatus"), ok_example=one({**st, "installed": True, "code_verified": True,
                                                        "admin_created": True, "admin_mfa_enabled": True,
                                                        "access": D.SETUP_ACCESS,
                                                        "steps_done": ["code", "language", "admin", "access", "stack", "quota"]}),
                 desc="Ghi `installed_at`; sau đó mọi endpoint ghi của wizard trả 410.")
    op["responses"]["410"] = gone


# ---------------------------------------------------------------- admin
def admin_paths(api: Api):
    jobs = JobSeq(100)
    idp = [Api.p("Id")]
    auth_paths(api, "admin")
    srv = D.SERVERS[0]
    # -- dashboard / system
    api.add("get", "/dashboard/summary", "getDashboardSummary", "Số liệu dashboard", "Monitoring",
            ok=ref("DashboardSummary"), ok_example=one(D.DASHBOARD))
    api.add("get", "/system/version", "getSystemVersion", "Phiên bản panel", "System", ok=ref("SystemVersion"),
            ok_example=one({"version": "0.1.0-alpha", "commit": "8793c63", "agent_min_version": "0.1.0", "update_available": None}))
    api.add("get", "/system/status", "getSystemStatus", "Tình trạng API, PostgreSQL, Redis, agent", "System",
            ok=ref("SystemStatus"),
            ok_example=one({"api": "ok", "database": {"ok": True, "latency_ms": 1.8, "error": None},
                            "redis": {"ok": True, "latency_ms": 0.4, "error": None},
                            "agent": {"reachable": True, "mode": "mock", "version": "0.1.0-mock", "latency_ms": 2.1,
                                      "error": None},
                            "checked_at": D.T2}),
            desc="Agent được gọi bằng op `system.ping`. Trước khi có xác thực (Phase 3), route chỉ đăng ký khi APP_ENV=local/testing.")
    api.add("get", "/system/updates", "getSystemUpdates", "Phiên bản hiện tại, kênh và lệnh cập nhật", "System",
            ok=ref("SystemUpdates"), ok_example=one(D.SYSTEM_UPDATES),
            desc="Chỉ đọc. Cập nhật chạy bằng CLI root `itso update` trên server (D-65: release ký Ed25519, tự rollback).")
    api.add("get", "/system/readiness", "getSystemReadiness", "Sẵn sàng production: kiểm tự động + Gate G1–G8",
            "System", ok=ref("Readiness"), ok_example=one(D.READINESS),
            desc="Chỉ SUPER_ADMIN. Chỉ đọc dữ liệu panel; trạng thái Gate lấy từ bằng chứng đã ghi (D-115).")
    # -- import từ panel khác (Phase 12, D-108; chỉ SUPER_ADMIN)
    imp = D.IMPORTS[0]
    api.add("get", "/imports", "listImports", "Các lượt import từ panel khác", "Imports", list_=True,
            ok=ref("Import"), ok_example=page(D.IMPORTS))
    api.add("post", "/imports", "createImport", "Quét nguồn (chỉ đọc) và lập kế hoạch import", "Imports",
            body=ref("ImportScanInput"), body_example={"source": "aapanel", "server": srv["uuid"]}, job=True,
            job_example=jobs("import.scan", "import", imp["uuid"], ["import.scan"]),
            desc="Op `import.scan` chỉ đọc cấu hình/thư mục của nguồn trên server đã chọn. Đang có lượt `scanning`/`running` "
                 "trên cùng server → 409 `conflict`.")
    api.add("get", "/imports/{id}", "getImport", "Chi tiết lượt import", "Imports", params=idp, ok=ref("Import"),
            ok_example=one(imp))
    api.add("delete", "/imports/{id}", "deleteImport", "Xóa lượt import (không đụng máy nguồn hay account đã tạo)",
            "Imports", params=idp, no_content=True, desc="Đang `scanning`/`running` → 409 `conflict`.")
    api.add("get", "/imports/{id}/items", "listImportItems", "Mục tìm thấy (website, DB, cron) và kế hoạch", "Imports",
            params=idp, list_=True, ok=ref("ImportItem"), ok_example=page(D.IMPORT_ITEMS))
    api.add("put", "/imports/{id}/plan", "updateImportPlan", "Chọn mục, map sang gói và USER", "Imports", params=idp,
            body=ref("ImportPlanInput"),
            body_example={"items": [{"uuid": D.IMPORT_ITEMS[0]["uuid"], "selected": True, "username": "shopanphat",
                                     "package": D.PACKAGES[1]["uuid"], "user": D.USERS[2]["uuid"], "new_user": None}]},
            ok=ref("Import"), ok_example=one(imp),
            desc="Chỉ khi `planned`. Kiểm trùng domain/username, hạn mức gói; lỗi → 422 theo từng mục "
                 "(`errors[\"items.N.field\"]`).")
    api.add("post", "/imports/{id}:run", "runImport", "Chạy import các mục đã chọn", "Imports", params=idp, job=True,
            step_up=True,
            job_example=jobs("import.run", "import", imp["uuid"],
                             ["account.ensure", "import.copy", "db.mysql.dump", "db.mysql.import", "nginx.vhost.apply", "cert.issue"]),
            desc="Mỗi account một job con: tạo account → copy file dưới UID account → dump + import DB → vhost/SSL → "
                 "cron. Mật khẩu DB mới sinh ở panel, không vào params job. Site cũ vẫn chạy tới khi cutover.")
    api.add("post", "/imports/{id}:cutover", "cutoverImport", "Chuyển nginx sang site ITSO (tắt vhost nguồn)",
            "Imports", params=idp, job=True, step_up=True,
            job_example=jobs("import.cutover", "import", imp["uuid"], ["import.cutover"]),
            desc="Chỉ khi `completed`/`partially_failed`. Vhost của panel nguồn chỉ đổi tên `.conf` → `.itso-disabled`.")
    api.add("post", "/imports/{id}:rollback", "rollbackImport", "Quay lại vhost nguồn sau cutover", "Imports",
            params=idp, job=True, step_up=True,
            job_example=jobs("import.rollback", "import", imp["uuid"], ["import.rollback"]),
            desc="Chỉ khi `cut_over`. Account ITSO đã tạo được giữ nguyên để xem lại.")
    setup_paths(api, jobs)
    # -- servers
    api.crud("/servers", "server", ref("Server"), "Servers", D.SERVERS, ops="lru", update_body=ref("ServerUpdate"),
             update_example={"accepting_new_accounts": False})
    api.add("post", "/servers/enrollment-tokens", "createEnrollmentToken", "Tạo token thêm server (một lần)", "Servers",
            body=ref("EnrollmentRequest"), body_example={"name": "srv-hn-03", "role_tags": ["web"], "ttl_min": 60},
            ok=ref("EnrollmentToken"), ok_example=one(D.ENROLLMENT), status="201", step_up=True)
    api.add("post", "/api/v1/internal/nodes:enroll", "enrollNode",
            "Node join bằng token: ký CSR, tạo server + khóa HMAC (chỉ itso-relay gọi qua loopback)", "Servers",
            public=True, security=[], body=ref("NodeEnrollRequest"), body_example=D.NODE_ENROLL_REQUEST,
            ok=ref("NodeEnrollment"), ok_example=one(D.NODE_ENROLLMENT), status="201",
            desc="itso-relay nhận yêu cầu của node trên cổng 28444 (TLS, node ghim `ca_sha256`) rồi chuyển tiếp tới route này "
                 "qua 127.0.0.1 kèm header `X-Itso-Relay-Signature` (HMAC bằng khóa relay). Token sai/hết hạn/đã dùng → 422 "
                 "`enrollment_invalid` (đếm vào giới hạn 10 lần/10 phút/IP). CSR phải là ECDSA P-256 với CN `itso-enroll` (node chưa biết uuid); chứng chỉ cấp ra có CN = `server_uuid`.")
    api.add("post", "/servers/{id}:revoke", "revokeServer",
            "Thu hồi node: chặn chứng chỉ ngay, agent không kết nối lại được (chỉ khi không còn account)", "Servers",
            params=idp, body=obj({"confirm_name": s(pattern="^[a-z0-9][a-z0-9-]{1,62}$")}),
            body_example={"confirm_name": "srv-hcm-01"}, ok=ref("Server"), ok_example=one(D.SERVERS[2]), step_up=True)
    api.add("get", "/servers/{id}/capacity", "getServerCapacity", "Dung lượng đã cấp", "Servers", params=idp,
            ok=ref("ServerCapacity"), ok_example=one(D.CAPACITY))
    api.add("get", "/servers/{id}/services", "listServerServices", "Dịch vụ hệ thống", "Servers", params=idp,
            list_=True, ok=ref("ServerService"), ok_example=page(D.SERVICES))
    api.add("post", "/servers/{id}/services/{service}:{action}", "controlServerService",
            "start/stop/restart dịch vụ trong allowlist", "Servers",
            params=idp + [Api.p("ServiceName"), Api.p("ServiceAction")], job=True,
            job_example=jobs("service.restart", "server", srv["uuid"], ["service.control"]))
    api.add("post", "/servers/{id}:reboot", "rebootServer", "Khởi động lại server", "Servers", params=idp, job=True,
            step_up=True, job_example=jobs("server.reboot", "server", srv["uuid"], ["system.reboot"]))
    api.add("get", "/servers/{id}/software", "listServerSoftware", "Phần mềm trên server", "Software", params=idp,
            list_=True, ok=ref("Software"), ok_example=page(D.SOFTWARE))
    api.add("post", "/servers/{id}/software/{key}:{action}", "manageServerSoftware", "Cài/gỡ/nâng cấp theo recipe",
            "Software", params=idp + [Api.p("SoftwareKey"), Api.p("SoftwareAction")], job=True,
            desc="Xung đột (vd `redis` ↔ `valkey`) → 409 `conflict`; gỡ khi đang dùng hoặc thành phần lõi → 409 `resource_locked` (D-100).",
            job_example=jobs("software.install", "server", srv["uuid"], ["software.install"]))
    api.add("get", "/servers/{id}/os-updates", "getOsAutoUpdates", "Cập nhật bảo mật tự động của hệ điều hành", "Software",
            params=idp, ok=ref("OsAutoUpdates"), ok_example=one(D.OS_UPDATES))
    api.add("put", "/servers/{id}/os-updates", "putOsAutoUpdates", "Bật/tắt unattended-upgrades", "Software",
            params=idp, body=ref("OsAutoUpdatesInput"), body_example={"enabled": True, "security_only": True}, job=True,
            job_example=jobs("software.os_updates", "server", srv["uuid"], ["os.auto_updates"]),
            desc="Không bao giờ tự reboot (D-100).")
    api.add("get", "/servers/{id}/php-versions", "listPhpVersions", "Phiên bản PHP", "Software", params=idp,
            list_=True, ok=ref("PhpVersionInfo"), ok_example=page(D.PHP_VERSIONS))
    api.add("post", "/servers/{id}/php-versions/{version}:{action}", "managePhpVersion", "Cài/gỡ phiên bản PHP", "Software",
            params=idp + [Api.p("PhpVersionPath"), Api.p("PhpAction")], job=True,
            job_example=jobs("php.version.install", "server", srv["uuid"], ["php.version.install"]),
            desc="PHP 8.3 từ kho Ubuntu 24.04 (D-68); 8.1/8.2/8.4 từ PPA ondrej/php ghim khóa, kho chỉ bật khi cài bản đầu tiên (D-100). "
                 "Gỡ khi còn website dùng → 409 `resource_locked`.")
    api.add("post", "/servers/{id}/php-versions/{version}/extensions", "installPhpExtensions", "Cài extension PHP (allowlist)",
            "Software", params=idp + [Api.p("PhpVersionPath")], body=ref("PhpExtensionsInput"),
            body_example={"extensions": ["intl", "redis"]}, job=True,
            job_example=jobs("php.extensions.install", "server", srv["uuid"], ["php.ext.install"]))
    api.add("get", "/servers/{id}/nginx", "getNginxGlobal", "Cấu hình Nginx toàn server", "Servers", params=idp,
            ok=ref("NginxGlobal"), ok_example=one(D.NGINX_GLOBAL))
    api.add("patch", "/servers/{id}/nginx", "updateNginxGlobal", "Đổi cấu hình Nginx toàn server", "Servers",
            params=idp, body=partial(ADMIN, "NginxGlobal", ref), body_example={"worker_connections": 8192}, job=True,
            job_example=jobs("nginx.global.update", "server", srv["uuid"], ["nginx.global.apply"]))
    api.add("get", "/placement/suggestions", "getPlacementSuggestions", "Gợi ý server cho account mới (không tự cấp)",
            "Servers", params=[Api.p("PackageQuery")], list_=True, ok=ref("PlacementSuggestion"),
            ok_example=page(D.PLACEMENT))
    # -- packages
    api.crud("/hosting-packages", "hostingPackage", ref("HostingPackage"), "Packages", D.PACKAGES, ops="lcrud",
             create_body=ref("HostingPackageCreate"),
             create_example={"code": "pro", "name": "Pro", "description": "Ứng dụng lớn, nhiều website",
                             "limits": D.PACKAGES[2]["limits"]},
             update_body=ref("HostingPackageUpdate"), update_example={"limits": D.PACKAGES[0]["limits"]})
    api.add("get", "/hosting-packages/{id}/versions", "listPackageVersions", "Lịch sử phiên bản gói", "Packages",
            params=idp, list_=True, ok=ref("PackageVersion"), ok_example=page(D.PACKAGE_VERSIONS[:2]))
    api.add("post", "/hosting-packages/{id}/versions/{version}:migrate-accounts", "migratePackageVersionAccounts",
            "Chuyển mọi account từ phiên bản cũ sang phiên bản hiện tại", "Packages",
            params=idp + [Api.p("Version")], job=True,
            job_example=jobs("package.migrate_accounts", "hosting_package", D.PACKAGES[0]["uuid"], ["quota.apply"]))
    # -- accounts
    acc = D.ACCOUNTS[0]
    api.crud("/hosting-accounts", "hostingAccount", cref("HostingAccount"), "Accounts", D.ACCOUNTS, ops="lcru",
             create_body=ref("HostingAccountCreate"),
             create_example={"owner_user_uuid": D.USERS[2]["uuid"], "package_uuid": D.PACKAGES[1]["uuid"],
                             "server_uuid": srv["uuid"], "username": "anphat", "primary_domain": "anphat.vn",
                             "limits_override": {}},
             create_job=True, job_factory=lambda t, x: jobs("hosting_account.create", "hosting_account", x["uuid"],
                                                            ["account.ensure", "quota.apply", "php.pool.apply"]),
             update_body=ref("HostingAccountUpdate"), update_example={"legal_hold": True},
             list_params=[Api.p("FilterServer"), Api.p("FilterLifecycle")])
    acts = [
        ("suspend", "Khóa account", ref("ReasonRequest"), {"reason": "Website bị nhiễm mã độc, chờ làm sạch"},
         ["account.suspend", "nginx.vhost.apply"], False),
        ("unsuspend", "Mở khóa account", None, None, ["account.unsuspend", "nginx.vhost.apply"], False),
        ("change-package", "Đổi gói", ref("ChangePackageRequest"),
         {"package_uuid": D.PACKAGES[2]["uuid"], "version": None, "reason": "Nâng cấp theo yêu cầu phòng IT"},
         ["quota.apply", "php.pool.apply"], False),
        ("migrate", "Chuyển sang server khác (D-48)", ref("MigrateRequest"),
         {"target_server_uuid": D.SERVERS[1]["uuid"], "keep_source_days": 7},
         ["migrate.preflight", "account.ensure", "backup.run", "backup.restore", "migrate.verify"], True),
        ("terminate", "Chấm dứt account (giữ dữ liệu ≥ 30 ngày)", ref("TerminateRequest"),
         {"reason": "Dự án kết thúc", "confirm_username": "anphat"}, ["account.suspend", "backup.run"], True),
        ("schedule-purge", "Tạo yêu cầu purge (backup cuối + kiểm chứng)", ref("SchedulePurgeRequest"),
         {"final_backup": True, "note": None}, ["backup.run", "backup.check"], True),
        ("confirm-purge", "Xác nhận purge bước 2 (Super Admin khác)", ref("ConfirmPurgeRequest"),
         {"purge_uuid": D.PURGES[0]["uuid"], "confirm_username": "oldshop"}, ["account.remove"], True),
    ]
    # Phase 3 chưa hiện thực purge (Phase 8) và migrate (Phase 9): trả 501 có mã riêng, không giả thành công.
    later = {"schedule-purge": ("purge_not_available", "Phase 8"),
             "confirm-purge": ("purge_not_available", "Phase 8")}
    for action, label, body, body_ex, steps, step_up in acts:
        camel = "".join(x.title() for x in action.split("-"))
        op = api.add("post", f"/hosting-accounts/{{id}}:{action}", f"{camel[0].lower()}{camel[1:]}HostingAccount", label,
                "Accounts", params=idp, body=body, body_example=body_ex, job=True, step_up=step_up,
                job_example=jobs(f"hosting_account.{action.replace('-', '_')}", "hosting_account",
                                 (D.ACCOUNTS[3] if "purge" in action else acc)["uuid"], steps,
                                 server=2 if "purge" in action else 0))
        if action in later:
            code, phase = later[action]
            op["responses"]["501"] = {"$ref": "./common.yaml#/components/responses/NotImplemented"}
            op["description"] += f"\n\nPhase 3: trả `501` mã `{code}` (hiện thực ở {phase})."
    api.add("post", "/hosting-accounts/{id}:migrate-preflight", "preflightHostingAccountMigration",
            "Kiểm tra trước khi chuyển server (đồng bộ, không đổi gì)", "Accounts", params=idp,
            body=obj({"target_server_uuid": s("uuid")}), body_example={"target_server_uuid": D.SERVERS[1]["uuid"]},
            ok=ref("MigrationPreflight"), ok_example=one(D.MIGRATION_PREFLIGHT))
    api.add("get", "/hosting-accounts/{id}/usage", "getHostingAccountUsage", "Usage so với quota", "Accounts",
            params=idp, ok=cref("Usage"), ok_example=one(acc["usage"]))
    api.add("get", "/hosting-accounts/{id}/features", "getHostingAccountFeatures", "Tính năng theo gói (PHP, SSH, cron, backup)",
            "Accounts", params=idp, ok=cref("AccountFeatures"), ok_example=one(features_of(acc)))
    api.add("get", "/hosting-accounts/{id}/lifecycle-events", "listHostingAccountLifecycleEvents", "Lịch sử vòng đời",
            "Accounts", params=idp, list_=True, ok=cref("LifecycleEvent"), ok_example=page(D.LIFECYCLE))
    api.add("get", "/purge-records", "listPurgeRecords", "Yêu cầu purge đang chờ", "Accounts", list_=True,
            ok=ref("PurgeRecord"), ok_example=page(D.PURGES))
    # -- migrations
    mig = D.MIGRATIONS[0]
    api.add("get", "/account-migrations", "listAccountMigrations", "Phiên chuyển server", "Migrations", list_=True,
            ok=ref("AccountMigration"), ok_example=page(D.MIGRATIONS))
    api.add("get", "/account-migrations/{id}", "getAccountMigration", "Chi tiết phiên chuyển", "Migrations",
            params=idp, ok=ref("AccountMigration"), ok_example=one(mig))
    api.add("post", "/account-migrations/{id}:cutover", "cutoverAccountMigration",
            "Cutover (chỉ khi verifying khớp)", "Migrations", params=idp, job=True, step_up=True,
            job_example=jobs("migration.cutover", "account_migration", mig["uuid"], ["migrate.cutover"], server=2))
    api.add("post", "/account-migrations/{id}:rollback", "rollbackAccountMigration", "Hoàn tác về server nguồn",
            "Migrations", params=idp, job=True,
            job_example=jobs("migration.rollback", "account_migration", mig["uuid"], ["migrate.rollback"], server=2))
    api.add("post", "/account-migrations/{id}:cleanup", "cleanupAccountMigration",
            "Dọn dẹp server nguồn (sau hạn giữ, hoặc sớm khi xác nhận)", "Migrations", params=idp, job=True, step_up=True,
            body=obj({"confirm_username": cref("Username")}), body_example={"confirm_username": "lehoa"},
            job_example=jobs("migration.cleanup", "account_migration", mig["uuid"], ["account.remove"], server=2))
    # -- users
    api.crud("/users", "user", ref("AdminUser"), "Users", D.USERS, ops="lcru", create_body=ref("UserCreate"),
             create_example={"realm": "portal", "name": "Công ty An Phát", "email": "it@anphat.vn", "role": "USER",
                             "locale": "vi", "send_invite": True},
             update_body=ref("UserUpdate"), update_example={"name": "Công ty CP An Phát"},
             list_params=[Api.p("FilterRealm")])
    for action, label in [("lock", "Khóa user"), ("unlock", "Mở khóa user"), ("reset-mfa", "Đặt lại MFA")]:
        camel = "".join(x.title() for x in action.split("-"))
        api.add("post", f"/users/{{id}}:{action}", f"{camel[0].lower()}{camel[1:]}User", label, "Users", params=idp,
                step_up=action == "reset-mfa", ok=ref("AdminUser"),
                ok_example=one(D.USERS[4] | ({"status": "active"} if action == "unlock" else {})))
    api.add("post", "/users/{id}:impersonate", "impersonateUser", "Xem portal dưới danh nghĩa USER (có lý do, có hạn)",
            "Users", params=idp, body=ref("ReasonRequest"), body_example={"reason": "Hỗ trợ cấu hình SSL theo yêu cầu"},
            ok=ref("Impersonation"), ok_example=one(D.IMPERSONATION), status="201", step_up=True)
    api.add("get", "/users/{id}/scopes", "getUserScopes", "Phạm vi của ADMIN", "Users", params=idp, list_=True,
            ok=ref("UserScope"), ok_example=page(D.SCOPES))
    api.add("put", "/users/{id}/scopes", "setUserScopes", "Đặt phạm vi ADMIN", "Users", params=idp,
            body=ref("UserScopesPut"),
            body_example={"scopes": [{"scope_type": "server", "uuid": D.SERVERS[0]["uuid"]}]}, ok=arr(ref("UserScope")),
            ok_example=one(D.SCOPES[:1]))
    api.add("get", "/roles", "listRoles", "Vai trò và quyền", "Users", list_=True, ok=ref("Role"), ok_example=page(D.ROLES))
    api.add("get", "/api-tokens", "listApiTokens", "API token nội bộ (CLI, automation)", "Users", list_=True,
            ok=ref("ApiToken"), ok_example=page(D.API_TOKENS))
    api.add("post", "/api-tokens", "createApiToken", "Tạo API token (trả secret một lần)", "Users",
            body=ref("ApiTokenCreate"),
            body_example={"name": "CLI srv-hn-01", "scopes": ["accounts:write", "servers:read"], "expires_at": "2027-05-20T00:00:00+07:00"},
            ok=cref("SecretOnce"), ok_example=one({"secret": "itso_pat_5Nq1tYv8Xc2Lm7Rb"}), status="201", step_up=True)
    api.add("delete", "/api-tokens/{id}", "deleteApiToken", "Thu hồi API token", "Users", params=idp, no_content=True)
    # -- resources dùng chung
    resource_paths(api, "admin", jobs)
    # -- backup admin
    api.crud("/backup-destinations", "backupDestination", ref("BackupDestination"), "Backups", D.BACKUP_DESTS, ops="lcru",
             create_body=ref("BackupDestinationInput"),
             create_example={"name": "S3 Object Lock (offsite)", "type": "s3", "append_only": True, "immutable_days": 30,
                             "config": {"endpoint": "https://s3.ap-southeast-1.example.com", "bucket": "itso-backup",
                                        "region": "ap-southeast-1"},
                             "credentials": {"access_key": "AKIA…", "secret_key": "********"}},
             update_body=partial(ADMIN, "BackupDestinationInput", ref), update_example={"name": "S3 offsite (Object Lock 30 ngày)"})
    api.add("post", "/backup-destinations/{id}:test", "testBackupDestination", "Kiểm tra kết nối và quyền ghi",
            "Backups", params=idp, job=True,
            job_example=jobs("backup.destination_test", "backup_destination", D.BACKUP_DESTS[1]["uuid"], ["backup.check"]))
    api.crud("/backup-policies", "backupPolicy", ref("BackupPolicy"), "Backups", D.BACKUP_POLICIES, ops="lcrud",
             create_body=ref("BackupPolicyInput"),
             create_example={"name": "Hằng ngày, tất cả account", "scope_type": "all_accounts", "scope_uuid": None,
                             "schedule": "0 1 * * *", "destination_uuids": [D.BACKUP_DESTS[1]["uuid"]],
                             "retention": {"daily": 7, "weekly": 4, "monthly": 6}, "enabled": True},
             update_body=partial(ADMIN, "BackupPolicyInput", ref), update_example={"enabled": False}, plural="backupPolicies")
    api.add("post", "/backup-policies/{id}:run", "runBackupPolicy", "Chạy chính sách ngay", "Backups", params=idp,
            job=True, job_example=jobs("backup.policy_run", "backup_policy", D.BACKUP_POLICIES[0]["uuid"],
                                       ["backup.run", "backup.check"]))
    api.add("post", "/backup-destinations/{id}:recovery-kit", "getBackupRecoveryKit", "Bộ khôi phục của đích (hiện một lần)",
            "Backups", params=idp, ok=ref("RecoveryKit"), ok_example=one(D.RECOVERY_KIT),
            desc="Chỉ SUPER_ADMIN. Lần đầu (chưa xác nhận đã lưu offline) không cần step-up; sau đó cần step-up MFA "
                 "(403 `mfa_step_up_required`). Mỗi lượt xem ghi audit.")
    api.add("post", "/backup-destinations/{id}:recovery-kit-ack", "acknowledgeBackupRecoveryKit",
            "Xác nhận đã lưu bộ khôi phục offline", "Backups", params=idp, no_content=True)
    api.add("get", "/backup-repositories", "listBackupRepositories", "Repo backup (đích × account / server)", "Backups",
            list_=True, params=[Api.p("FilterHostingAccount"), Api.p("FilterDestination")], ok=ref("BackupRepository"),
            ok_example=page(D.BACKUP_REPOS))
    api.add("get", "/backup-verifications", "listBackupVerifications", "Lịch sử kiểm chứng (check + restore test)",
            "Backups", list_=True, params=[Api.p("FilterHostingAccount"), Api.p("FilterDestination")],
            ok=ref("BackupVerification"), ok_example=page(D.BACKUP_VERIFICATIONS))
    api.add("get", "/backups/overview", "getBackupOverview", "Tổng quan Backup Center (3-2-1-1-0)", "Backups",
            ok=ref("BackupOverview"), ok_example=one(D.BACKUP_OVERVIEW))
    api.add("post", "/backup-snapshots/{id}:verify", "verifyBackupSnapshot", "Kiểm chứng khôi phục được", "Backups",
            params=idp, job=True,
            job_example=jobs("backup.verify", "backup_snapshot", D.SNAPSHOTS[0]["uuid"], ["backup.check", "backup.restore_test"]))
    api.add("delete", "/backup-snapshots/{id}", "deleteBackupSnapshot",
            "Xóa snapshot (bị từ chối nếu đích append-only hoặc còn trong immutable_days)", "Backups", params=idp,
            job=True, step_up=True,
            job_example=jobs("backup.forget", "backup_snapshot", D.SNAPSHOTS[0]["uuid"], ["backup.forget"]))
    # -- security
    api.add("get", "/security/overview", "getSecurityOverview", "Tổng quan bảo mật", "Security",
            params=[Api.p("FilterServer")], ok=ref("SecurityOverview"), ok_example=one(D.SECURITY_OVERVIEW))
    api.add("get", "/security/events", "listSecurityEvents", "Sự kiện bảo mật", "Security", list_=True,
            params=[Api.p("FilterServer"), Api.p("FilterSeverity")], ok=ref("SecurityEvent"),
            ok_example=page(D.SECURITY_EVENTS))
    api.add("post", "/security/events/{id}:acknowledge", "acknowledgeSecurityEvent", "Xác nhận đã xử lý", "Security",
            params=idp, ok=ref("SecurityEvent"), ok_example=one(D.SECURITY_EVENTS[0] | {"acknowledged_at": D.T2}))
    api.add("get", "/servers/{id}/firewall/rules", "listFirewallRules", "Rule tường lửa", "Firewall", params=idp,
            list_=True, ok=ref("FirewallRule"), ok_example=page(D.FIREWALL_RULES))
    api.add("post", "/servers/{id}/firewall/rules", "createFirewallRule", "Thêm rule (nháp, chưa áp dụng)", "Firewall",
            params=idp, body=ref("FirewallRuleInput"),
            body_example={"priority": 40, "action": "drop", "direction": "in", "protocol": "tcp", "ports": "3306",
                          "source": "0.0.0.0/0", "comment": "Chặn MySQL từ ngoài", "enabled": True},
            ok=ref("FirewallRule"), ok_example=one(D.FIREWALL_RULES[0]), status="201")
    api.add("delete", "/servers/{id}/firewall/rules/{rule}", "deleteFirewallRule", "Xóa rule (nháp)", "Firewall",
            params=idp + [Api.p("RuleId")], no_content=True)
    api.add("post", "/servers/{id}/firewall:apply", "applyFirewall", "Áp dụng an toàn, tự hoàn tác nếu không xác nhận",
            "Firewall", params=idp, body=ref("FirewallApply"), body_example={"rollback_after_sec": 120}, job=True,
            step_up=True, job_example=jobs("firewall.apply", "server", srv["uuid"], ["firewall.apply"]))
    api.add("post", "/servers/{id}/firewall:confirm", "confirmFirewall", "Xác nhận giữ cấu hình vừa áp dụng",
            "Firewall", params=idp, job=True,
            job_example=jobs("firewall.confirm", "server", srv["uuid"], ["firewall.confirm"]))
    api.add("get", "/servers/{id}/firewall/preview", "previewFirewall", "Xem trước ruleset nft từ rule nháp", "Firewall",
            params=idp, ok=ref("FirewallPreview"), ok_example=one(D.FIREWALL_PREVIEW),
            desc="Sinh ruleset bảng `inet itso` như khi áp dụng và kiểm bất biến chống tự khóa (D-76); không đổi máy chủ.")
    api.add("get", "/servers/{id}/firewall/status", "getFirewallStatus", "Trạng thái safe-apply tường lửa", "Firewall",
            params=idp, ok=ref("FirewallStatus"), ok_example=one(D.FIREWALL_STATUS))
    api.add("get", "/security/ssh", "getSshSettings", "Cấu hình SSH", "Security", params=[Api.p("ServerQuery")],
            ok=ref("SshSettings"), ok_example=one(D.SSH_SETTINGS))
    api.add("patch", "/security/ssh", "updateSshSettings", "Đổi cấu hình SSH (safe-apply)", "Security",
            params=[Api.p("ServerQuery")], body=ref("SshSettingsPatch"),
            body_example={"max_auth_tries": 3, "rollback_after_sec": 120}, job=True, step_up=True,
            desc="Safe-apply như tường lửa: `sshd -t` → reload → tự hoàn tác nếu không gọi `:confirm` trong "
                 "`rollback_after_sec`. Tắt mật khẩu khi `admin_keys = 0` trả 422.",
            job_example=jobs("sshd.update", "server", srv["uuid"], ["sshd.config.apply"]))
    api.add("post", "/security/ssh:confirm", "confirmSsh", "Xác nhận giữ cấu hình SSH vừa áp dụng", "Security",
            params=[Api.p("ServerQuery")], job=True,
            job_example=jobs("sshd.confirm", "server", srv["uuid"], ["sshd.config.confirm"]))
    api.add("post", "/servers/{id}/fim:baseline", "rebaselineFim", "Chụp lại baseline toàn vẹn file", "Security",
            params=idp, job=True, step_up=True,
            job_example=jobs("fim.baseline", "server", srv["uuid"], ["fim.baseline"]))
    api.add("get", "/security/malware/findings", "listMalwareFindings", "File nghi nhiễm", "Malware", list_=True,
            params=[Api.p("FilterHostingAccount")], ok=cref("MalwareFinding"), ok_example=page(D.MALWARE_FINDINGS))
    api.add("post", "/security/malware/findings/{id}:quarantine", "quarantineMalwareFinding", "Cách ly file nghi nhiễm",
            "Malware", params=idp, job=True,
            job_example=jobs("malware.quarantine", "malware_finding", D.MALWARE_FINDINGS[1]["uuid"], ["malware.quarantine"]))
    api.add("get", "/servers/{id}/terminal/policy", "getTerminalPolicy", "Policy terminal của máy chủ (chỉ đọc)",
            "Terminal", params=idp, ok=ref("TerminalPolicy"), ok_example=one(D.TERMINAL_POLICY),
            desc="Đọc từ agent; chỉ bật/tắt được bằng `itso policy set` trên máy chủ (D-81).")
    api.add("get", "/terminal/sessions", "listTerminalSessions", "Phiên terminal", "Terminal", list_=True,
            params=[Api.p("FilterServer")], ok=ref("TerminalSession"), ok_example=page(D.TERMINAL_SESSIONS))
    api.add("get", "/terminal/sessions/{id}/recording", "getTerminalRecording", "Bản ghi phiên (asciicast)", "Terminal",
            params=idp + [Api.p("Offset")], ok=ref("TerminalRecording"), ok_example=one(D.TERMINAL_RECORDING),
            step_up=True)
    api.add("get", "/security/fail2ban", "getFail2ban", "Fail2ban", "Security", params=[Api.p("ServerQuery")],
            ok=ref("Fail2banSettings"), ok_example=one(D.FAIL2BAN))
    api.add("patch", "/security/fail2ban", "updateFail2ban", "Đổi cấu hình fail2ban", "Security",
            params=[Api.p("ServerQuery")], body=partial(ADMIN, "Fail2banSettings", ref), body_example={"enabled": True}, job=True,
            job_example=jobs("fail2ban.update", "server", srv["uuid"], ["fail2ban.apply"]))
    api.add("get", "/security/fail2ban/bans", "listFail2banBans", "IP đang bị fail2ban cấm", "Security", list_=True,
            params=[Api.p("FilterServer")], ok=ref("Fail2banBan"), ok_example=page(D.FAIL2BAN_BANS))
    api.add("post", "/security/fail2ban/bans:unban", "unbanIp", "Gỡ cấm một IP", "Security", body=ref("Fail2banUnban"),
            body_example={"server": srv["uuid"], "jail": "sshd", "ip": "203.0.113.45"}, job=True,
            job_example=jobs("fail2ban.unban", "server", srv["uuid"], ["fail2ban.unban"]))
    api.add("get", "/security/fim/changes", "listFimChanges", "Thay đổi toàn vẹn file (FIM)", "Security", list_=True,
            params=[Api.p("FilterServer")], ok=ref("FimChange"), ok_example=page(D.FIM_CHANGES))
    api.add("get", "/security/score", "getSecurityScore", "Điểm bảo mật chi tiết theo máy chủ", "Security",
            params=[Api.p("ServerQuery")], ok=ref("SecurityScore"), ok_example=one(D.SECURITY_SCORE),
            desc="Laravel tính từ `security.audit` của agent + dữ liệu panel theo bảng trọng số công khai (D-80).")
    api.add("get", "/security/cis", "getCisReport", "Kết quả kiểm CIS Ubuntu 24.04 L1 theo máy chủ", "Security",
            params=[Api.p("ServerQuery")], ok=ref("CisReport"), ok_example=one(D.CIS_REPORT),
            desc="Chỉ đọc (D-109). Chưa quét → `audited_at` null, `items` rỗng.")
    api.add("post", "/security/cis:audit", "auditCis", "Chạy kiểm CIS (chỉ đọc)", "Security",
            params=[Api.p("ServerQuery")], job=True,
            job_example=jobs("cis.audit", "server", srv["uuid"], ["cis.audit"]))
    api.add("get", "/security/ip-allowlist", "getIpAllowlist", "IP allowlist cho Admin Panel", "Security",
            ok=ref("IpAllowlist"), ok_example=one(D.IP_ALLOWLIST))
    api.add("put", "/security/ip-allowlist", "setIpAllowlist", "Đặt IP allowlist (từ chối nếu khóa chính mình)",
            "Security", body=ref("IpAllowlist"), body_example=D.IP_ALLOWLIST, ok=ref("IpAllowlist"),
            ok_example=one(D.IP_ALLOWLIST), step_up=True)
    api.add("get", "/websites/{id}/waf", "getWebsiteWaf", "WAF của website", "WAF", params=idp, ok=ref("WafSettings"),
            ok_example=one(D.WAF))
    api.add("patch", "/websites/{id}/waf", "updateWebsiteWaf", "Đổi WAF của website", "WAF", params=idp,
            body=ref("WafUpdate"), body_example={"mode": "block", "paranoia_level": 2}, job=True,
            job_example=jobs("waf.update", "website", D.WEBSITES[0]["uuid"], ["waf.apply", "nginx.vhost.apply"]))
    api.add("get", "/websites/{id}/waf/events", "listWafEvents", "Sự kiện WAF của website", "WAF", params=idp, list_=True,
            ok=ref("WafEvent"), ok_example=page(D.WAF_EVENTS))
    api.add("get", "/security/malware/scans", "listMalwareScans", "Lượt quét mã độc", "Malware", list_=True,
            ok=ref("MalwareScan"), ok_example=page(D.MALWARE_SCANS))
    api.add("post", "/websites/{id}/scans", "scanWebsite", "Quét mã độc website", "Malware", params=idp, job=True,
            job_example=jobs("malware.scan", "website", D.WEBSITES[3]["uuid"], ["malware.scan"], server=2))
    api.add("get", "/security/quarantine", "listQuarantine", "Khu cách ly", "Malware", list_=True,
            ok=ref("QuarantineItem"), ok_example=page(D.QUARANTINE))
    api.add("post", "/security/quarantine/{id}:restore", "restoreQuarantineItem", "Trả file về vị trí cũ", "Malware",
            params=idp, job=True, step_up=True,
            job_example=jobs("malware.restore", "quarantine_item", D.QUARANTINE[0]["uuid"], ["malware.restore"], server=2))
    # -- docker
    dk = [Api.p("Id")]
    api.add("get", "/servers/{id}/docker", "getDockerHost", "Trạng thái Docker trên server", "Docker", params=dk,
            ok=ref("DockerHost"), ok_example=one(D.DOCKER_HOSTS[0]))
    api.add("post", "/servers/{id}/docker:enable", "enableDocker", "Cài và cấu hình Docker an toàn", "Docker", params=dk,
            job=True, step_up=True, desc="Recipe `docker` (docker.io + docker-compose-v2) → daemon.json an toàn → DOCKER-USER (D-94, D-95).",
            job_example=jobs("docker.enable", "server", srv["uuid"], ["software.install", "docker.host.configure", "docker.firewall.sync"]))
    api.add("post", "/servers/{id}/docker:sync-firewall", "syncDockerFirewall", "Đồng bộ chain DOCKER-USER", "Docker", params=dk,
            job=True, job_example=jobs("docker.firewall_sync", "server", srv["uuid"], ["docker.firewall.sync"]))
    api.add("post", "/servers/{id}/docker/images:prune", "pruneDockerImages", "Xóa image không dùng", "Docker", params=dk,
            job=True, job_example=jobs("docker.image_prune", "server", srv["uuid"], ["docker.image.prune"]),
            desc="Không xóa image đang dùng hoặc bản rollback còn hạn (D-98).")
    api.add("delete", "/servers/{id}/docker/volumes/{volume}", "deleteDockerVolume", "Xóa volume", "Docker",
            params=dk + [Api.p("VolumeName")], job=True, step_up=True,
            job_example=jobs("docker.volume_remove", "server", srv["uuid"], ["docker.volume.remove"]),
            desc="Volume đang được container dùng → 409 `resource_locked`.")
    api.add("get", "/servers/{id}/docker/port-allocations", "listPortAllocations", "Cổng compose đã cấp", "Docker", params=dk,
            list_=True, ok=ref("PortAllocation"), ok_example=page(D.PORT_ALLOCATIONS),
            desc="Dải 20000–29999 mỗi server; cổng 22/80/443/cổng panel không bao giờ được cấp (D-97).")
    api.add("get", "/servers/{id}/docker/containers", "listContainers", "Container", "Docker", params=dk, list_=True,
            ok=ref("Container"), ok_example=page(D.CONTAINERS))
    api.add("post", "/servers/{id}/docker/containers/{container}:{action}", "controlContainer", "start/stop/restart",
            "Docker", params=dk + [Api.p("ContainerId"), Api.p("ContainerAction")], job=True,
            job_example=jobs("docker.container_control", "server", srv["uuid"], ["docker.container.control"]))
    api.add("get", "/servers/{id}/docker/containers/{container}/logs", "getContainerLogs", "Log container", "Docker",
            params=dk + [Api.p("ContainerId"), Api.p("Lines")], ok=arr(s()),
            ok_example=one(["1:M 20 Nov 2026 01:15:00.000 * Ready to accept connections tcp"]))
    for kind, sch, ex in [("images", "DockerImage", D.DOCKER_IMAGES), ("volumes", "DockerVolume", D.DOCKER_VOLUMES),
                          ("networks", "DockerNetwork", D.DOCKER_NETWORKS)]:
        api.add("get", f"/servers/{{id}}/docker/{kind}", f"listDocker{kind.title()}", f"Docker {kind}", "Docker",
                params=dk, list_=True, ok=ref(sch), ok_example=page(ex))
    api.crud("/compose-projects", "composeProject", ref("ComposeProject"), "Docker", D.COMPOSE, ops="lcrud",
             create_body=ref("ComposeProjectInput"),
             create_example={"server_uuid": srv["uuid"], "name": "cache",
                             "compose_yaml": "services:\n  redis:\n    image: redis:7.4-alpine\n    mem_limit: 256m\n", "env": {}},
             update_body=partial(ADMIN, "ComposeProjectInput", ref), update_example={"env": {"TZ": "Asia/Ho_Chi_Minh"}},
             create_job=True, update_job=True, delete_job=True,
             job_factory=lambda t, x: jobs(t.replace("composeProject", "compose"), "compose_project", x["uuid"],
                                           ["compose.validate", "compose.apply"]))
    for action in ("validate", "up", "down", "pull"):
        api.add("post", f"/compose-projects/{{id}}:{action}", f"{action}ComposeProject", f"Compose {action}", "Docker",
                params=idp, job=True,
                job_example=jobs(f"compose.{action}", "compose_project", D.COMPOSE[0]["uuid"], [f"compose.{action}"]))
    api.add("post", "/compose-projects:validate", "previewComposeValidation", "Kiểm YAML trước khi lưu (không chạy gì)",
            "Docker", body=ref("ComposeValidateRequest"),
            body_example={"server_uuid": srv["uuid"], "compose_yaml": "services:\n  app:\n    image: nginx:1.27\n    privileged: true\n",
                          "overrides": []},
            ok=ref("ComposeValidation"), ok_example=one(D.COMPOSE_PREVIEW),
            desc="Gọi `compose.validate` của agent (đọc, đồng bộ). Override chỉ SUPER_ADMIN.")
    api.add("get", "/compose-projects/{id}/revisions", "listComposeRevisions", "Revision của project", "Docker",
            params=idp, list_=True, ok=ref("ComposeRevision"), ok_example=page(D.COMPOSE_REVISIONS))
    for action, label, ops_ in [("update-images", "Cập nhật image (giữ bản cũ để rollback)", ["docker.image.update"]),
                                ("rollback-images", "Quay về image trước", ["docker.image.rollback"])]:
        api.add("post", f"/compose-projects/{{id}}:{action}", "".join(x.title() for x in action.split("-")).replace("Update", "update", 1).replace("Rollback", "rollback", 1) + "ComposeProject",
                label, "Docker", params=idp, job=True, body=ref("ComposeImageUpdate"), body_example={"services": ["app"]},
                job_example=jobs(f"compose.{action.replace('-', '_')}", "compose_project", D.COMPOSE[0]["uuid"], ops_))
    api.add("get", "/compose-templates", "listComposeTemplates", "Mẫu compose dựng sẵn", "Docker", list_=True,
            ok=ref("ComposeTemplate"), ok_example=page(D.COMPOSE_TEMPLATES))
    api.crud("/registries", "registry", ref("Registry"), "Docker", D.REGISTRIES, ops="lcd",
             create_body=ref("RegistryInput"),
             create_example={"name": "GHCR nội bộ", "url": "https://ghcr.io", "username": "itso-bot", "password": "********"},
             plural="registries")
    api.add("post", "/registries/{id}:test", "testRegistry", "Kiểm tra đăng nhập registry", "Docker", params=idp, job=True,
            job_example=jobs("registry.test", "registry", D.REGISTRIES[0]["uuid"], ["docker.registry.login"]),
            desc="Mật khẩu đi qua vault của agent (secret_ref), không vào params job (D-98).")
    # -- monitoring (Phase 11: D-101…D-105)
    mparams = idp + [Api.p("Metric"), Api.p("Range")]
    api.add("get", "/metrics/servers/{id}", "getServerMetrics", "Chuỗi số liệu server", "Monitoring",
            params=mparams, ok=cref("MetricSeries"), ok_example=one(D.METRICS),
            desc="≤ 24 giờ đọc samples 1 phút, dài hơn đọc rollup 1 giờ; tối đa ~500 điểm (D-101).")
    api.add("get", "/metrics/servers/{id}/accounts", "listServerAccountUsage", "Số liệu cgroup theo account trên server",
            "Monitoring", params=idp, list_=True, ok=ref("AccountUsageRow"), ok_example=page(D.ACCOUNT_USAGE),
            desc="Sắp xếp `-cpu_pct`, `-ram_mb`, `-io_write_bps`, `-disk_mb`. ADMIN chỉ server được giao.")
    api.add("get", "/metrics/hosting-accounts/{id}", "getAccountMetrics", "Chuỗi số liệu account", "Monitoring",
            params=mparams, ok=cref("MetricSeries"),
            ok_example=one(D.METRICS | {"resource": {"type": "hosting_account", "uuid": acc["uuid"]}}))
    api.crud("/alert-rules", "alertRule", ref("AlertRule"), "Monitoring", D.ALERT_RULES, ops="lcrud",
             create_body=ref("AlertRuleInput"),
             create_example={"name": "CPU server > 85% trong 10 phút", "metric": "cpu_pct", "scope_type": "server",
                             "scope_uuid": None, "operator": "gt", "threshold": 85, "for_sec": 600, "severity": "high",
                             "channels": ["email"], "enabled": True, "repeat_sec": 14400},
             update_body=partial(ADMIN, "AlertRuleInput", ref), update_example={"threshold": 90})
    api.paths[api.prefix + "/alert-rules/{id}"]["delete"]["description"] = "Rule mặc định (`is_default`) → 409 `conflict`."
    api.add("post", "/alert-rules:preview", "previewAlertRule", "Xem trước rule khớp bao nhiêu đối tượng", "Monitoring",
            body=ref("AlertRuleInput"), body_example={"name": "Disk > 80%", "metric": "disk_pct", "scope_type": "server",
                                                      "operator": "gt", "threshold": 80, "severity": "medium"},
            ok=ref("AlertRulePreview"), ok_example=one(D.ALERT_PREVIEW))
    api.add("get", "/alerts", "listAlerts", "Cảnh báo", "Monitoring", list_=True,
            params=[Api.p("FilterAlertState"), Api.p("FilterSeverity"), Api.p("FilterServer")],
            ok=ref("Alert"), ok_example=page(D.ALERTS))
    api.add("post", "/alerts/{id}:ack", "ackAlert", "Xác nhận đã biết (ngừng nhắc lại)", "Monitoring", params=idp,
            ok=ref("Alert"), ok_example=one(D.ALERTS[0] | {"acknowledged_by": D.ALERTS[0].get("acknowledged_by") or
                                                         {"uuid": D.USERS[0]["uuid"], "name": D.USERS[0]["name"],
                                                          "email": D.USERS[0]["email"]},
                                                         "acknowledged_at": D.T2}),
            desc="Chỉ cảnh báo `firing`; khác → 409 `conflict`.")
    api.add("post", "/alerts/{id}:silence", "silenceAlert", "Tắt tạm thông báo của cảnh báo", "Monitoring", params=idp,
            body=ref("AlertSilence"), body_example={"duration_sec": 3600, "reason": "Đang bảo trì đĩa"},
            ok=ref("Alert"), ok_example=one(D.ALERTS[0] | {"silenced_until": "2026-11-20T09:15:00+07:00"}))
    api.add("post", "/alerts/{id}:unsilence", "unsilenceAlert", "Bỏ tắt tạm", "Monitoring", params=idp,
            ok=ref("Alert"), ok_example=one(D.ALERTS[0]))
    api.crud("/uptime-checks", "uptimeCheck", cref("UptimeCheck"), "Monitoring", D.UPTIME, ops="lcud",
             create_body=cref("UptimeCheckInput"),
             create_example={"website_uuid": D.WEBSITES[0]["uuid"], "path": "/", "interval_sec": 60, "keyword": None},
             update_body=cref("UptimeCheckUpdate"), update_example={"enabled": False})
    api.add("get", "/uptime-checks/{id}/results", "listUptimeResults", "Kết quả kiểm gần đây (7 ngày)", "Monitoring",
            params=idp, list_=True, ok=cref("UptimeResult"), ok_example=page(D.UPTIME_RESULTS))
    # -- kênh + nhật ký gửi (SUPER_ADMIN, D-103)
    api.crud("/notification-channels", "notificationChannel", ref("NotificationChannel"), "Notifications",
             D.NOTIFICATION_CHANNELS, ops="lcud", create_body=ref("NotificationChannelInput"),
             create_example={"type": "webhook", "name": "Webhook trực ca", "enabled": True,
                             "config": {"url": "https://hooks.itso.vn/panel", "allow_private_network": False},
                             "secret": "whsec_6f2c1d9a7b3e4f50"},
             update_body=ref("NotificationChannelUpdate"), update_example={"enabled": False})
    api.add("post", "/notification-channels/{id}:test", "testNotificationChannel", "Gửi thử", "Notifications",
            params=idp, ok=ref("NotificationDelivery"), ok_example=one(D.NOTIFICATION_DELIVERIES[0]),
            desc="Gửi đồng bộ một tin thử; địa chỉ bị chặn (SSRF guard) → delivery `blocked`.")
    api.add("get", "/notification-deliveries", "listNotificationDeliveries", "Nhật ký gửi thông báo", "Notifications",
            list_=True, params=[Api.p("FilterDeliveryState"), Api.p("FilterChannel")],
            ok=ref("NotificationDelivery"), ok_example=page(D.NOTIFICATION_DELIVERIES))
    api.add("post", "/notification-deliveries/{id}:resend", "resendNotificationDelivery", "Gửi lại", "Notifications",
            params=idp, ok=ref("NotificationDelivery"), ok_example=one(D.NOTIFICATION_DELIVERIES[1] | {"state": "queued"}),
            desc="Chỉ delivery `failed` hoặc `blocked`; khác → 409 `conflict`.")
    # -- audit
    api.add("get", "/audit-logs", "listAuditLogs", "Nhật ký audit", "Audit", list_=True,
            params=[Api.p("FilterAction"), Api.p("FilterActor")], ok=ref("AuditLog"), ok_example=page(D.AUDIT))
    ex = api.add("get", "/audit-logs/export", "exportAuditLogs", "Xuất CSV", "Audit",
                 params=[Api.p("FilterAction"), Api.p("FilterActor")], ok=None)
    ex["responses"]["200"]["content"] = {"text/csv": {"schema": s(), "example": "at,actor,action,resource,result\n"
                                                                                 "2026-11-20T08:15:00+07:00,superadmin@itso.local,hosting_account.suspend,lehoa,success\n"}}
    # -- settings
    api.add("get", "/settings/{group}", "getSettings", "Cài đặt theo nhóm", "Settings", params=[Api.p("SettingsGroup")],
            ok=ref("SettingsGroup"), ok_example=one(D.SETTINGS["general"]))
    api.add("patch", "/settings/{group}", "updateSettings", "Đổi cài đặt", "Settings", params=[Api.p("SettingsGroup")],
            body=ref("SettingsGroup"), body_example={"panel_name": "ITSO Panel"}, ok=ref("SettingsGroup"),
            ok_example=one(D.SETTINGS["general"]), step_up=True)



def features_of(acc: dict) -> dict:
    """AccountFeatures từ phiên bản gói hiện hành của account (ví dụ trong contract)."""
    ver = next((v for v in D.PACKAGE_VERSIONS if v["package_uuid"] == acc["package"]["uuid"]
                and v["version"] == acc["package"]["version"]), None)
    lim = ver["limits"] if ver else next(p for p in D.PACKAGES if p["uuid"] == acc["package"]["uuid"])["limits"]
    return {"package": acc["package"], "php_versions": lim["php_versions"], "php_workers_max": lim["php_workers_max"],
            "ssh_allowed": lim["ssh_allowed"],
            "cron_min_interval_min": lim["cron_min_interval_min"], "backup_quota_mb": lim["backup_quota_mb"],
            "backup_retention": lim["backup_retention"]}

# ---------------------------------------------------------------- portal
def portal_paths(api: Api):
    jobs = JobSeq(300)
    idp = [Api.p("Id")]
    auth_paths(api, "portal")
    api.add("get", "/overview", "portalOverview", "Tổng quan: usage so với quota, cảnh báo", "Overview",
            ok=cref("PortalOverview"), ok_example=one(D.PORTAL_OVERVIEW))
    api.add("get", "/hosting-accounts", "portalListHostingAccounts", "Account của tôi", "Accounts", list_=True,
            ok=cref("HostingAccount"), ok_example=page(D.ACCOUNTS[:1]))
    api.add("get", "/hosting-accounts/{id}", "portalGetHostingAccount", "Chi tiết account (chỉ đọc)", "Accounts",
            params=idp, ok=cref("HostingAccount"), ok_example=one(D.ACCOUNTS[0]))
    api.add("get", "/hosting-accounts/{id}/usage", "portalGetHostingAccountUsage", "Usage so với quota", "Accounts",
            params=idp, ok=cref("Usage"), ok_example=one(D.ACCOUNTS[0]["usage"]))
    # Phase 11: số liệu + uptime của chính mình, đặt dưới tài nguyên portal (không mở segment admin-only).
    api.add("get", "/hosting-accounts/{id}/usage-history", "portalGetAccountMetrics", "Chuỗi số liệu account của tôi",
            "Accounts", params=idp + [Api.p("Metric"), Api.p("Range")], ok=cref("MetricSeries"),
            ok_example=one(D.METRICS | {"resource": {"type": "hosting_account", "uuid": D.ACCOUNTS[0]["uuid"]},
                                        "unit": "pct", "source": "samples", "limit": 100}))
    api.add("get", "/hosting-accounts/{id}/uptime", "portalListAccountUptimeChecks",
            "Uptime các website của account", "Accounts", params=idp, list_=True,
            ok=cref("UptimeCheck"), ok_example=page(D.UPTIME[:2]))
    api.add("get", "/websites/{id}/uptime", "portalGetWebsiteUptime", "Uptime check của website", "Websites",
            params=idp, ok=cref("UptimeCheck"), ok_example=one(D.UPTIME[0]),
            desc="Website chưa có uptime check → 404.")
    api.add("patch", "/websites/{id}/uptime", "portalUpdateWebsiteUptime", "Bật/tắt, đổi đường dẫn hoặc từ khóa kiểm",
            "Websites", params=idp, body=cref("UptimeCheckUpdate"), body_example={"keyword": "Liên hệ"},
            ok=cref("UptimeCheck"), ok_example=one(D.UPTIME[0]))
    api.add("get", "/websites/{id}/uptime/results", "portalListWebsiteUptimeResults", "Kết quả kiểm gần đây",
            "Websites", params=idp, list_=True, ok=cref("UptimeResult"), ok_example=page(D.UPTIME_RESULTS))
    api.add("get", "/hosting-accounts/{id}/features", "portalGetHostingAccountFeatures",
            "Tính năng theo gói (PHP, SSH, cron, backup)", "Accounts", params=idp, ok=cref("AccountFeatures"),
            ok_example=one(features_of(D.ACCOUNTS[0])))
    resource_paths(api, "portal", jobs)
    api.add("get", "/protection", "portalGetSecurity", "Bảo mật account của tôi: WAF, mã độc", "Protection",
            ok=cref("PortalSecurity"), ok_example=one(D.PORTAL_SECURITY))
    api.add("get", "/protection/findings", "portalListMalwareFindings", "File nghi nhiễm của tôi", "Protection",
            list_=True, params=[Api.p("FilterHostingAccount")], ok=cref("MalwareFinding"),
            ok_example=page(D.MALWARE_FINDINGS[1:]))
    api.add("post", "/hosting-accounts/{id}/scans", "portalScanAccount", "Quét mã độc account", "Protection",
            params=idp, job=True,
            job_example=jobs("malware.scan", "hosting_account", D.ACCOUNTS[0]["uuid"], ["malware.scan"]))
    api.add("post", "/protection/findings/{id}:quarantine", "portalQuarantineFinding", "Cách ly file nghi nhiễm",
            "Protection", params=idp, job=True,
            job_example=jobs("malware.quarantine", "malware_finding", D.MALWARE_FINDINGS[1]["uuid"], ["malware.quarantine"]))
    api.add("delete", "/protection/findings/{id}", "portalDeleteFinding", "Xóa file nghi nhiễm", "Protection",
            params=idp, job=True, step_up=True,
            job_example=jobs("malware.delete", "malware_finding", D.MALWARE_FINDINGS[1]["uuid"], ["malware.delete"]))
    api.add("get", "/profile", "portalGetProfile", "Hồ sơ", "Profile", ok=cref("User"), ok_example=one(D.USERS[2]))
    api.add("patch", "/profile", "portalUpdateProfile", "Đổi hồ sơ", "Profile",
            body=obj({"name": s(maxLength=120), "locale": enum("vi", "en"), "timezone": s()}, required=[]),
            body_example={"locale": "en"}, ok=cref("User"), ok_example=one(D.USERS[2] | {"locale": "en"}))


# ---------------------------------------------------------------- components
def common_components():
    def problem_resp(status, code, title, detail):
        return {"description": title, "content": {"application/problem+json": {
            "schema": {"$ref": "#/components/schemas/Problem"},
            "example": {"type": f"https://docs.itso.local/errors/{code}", "title": title, "status": status,
                        "code": code, "detail": detail, "request_id": "req_01JD8K2M4N"}}}}

    v422 = problem_resp(422, "validation_failed", "Dữ liệu không hợp lệ", "Một hoặc nhiều trường không hợp lệ.")
    v422["content"]["application/problem+json"]["example"]["errors"] = {"username": ["Username đã tồn tại trên server này."]}
    t429 = problem_resp(429, "rate_limited", "Quá nhiều yêu cầu", "Thử lại sau 30 giây.")
    t429["headers"] = {"Retry-After": {"schema": {"type": "integer"}, "description": "Số giây chờ."}}
    responses = {
        "Unauthorized": problem_resp(401, "unauthenticated", "Chưa đăng nhập", "Phiên đã hết hạn."),
        "Forbidden": problem_resp(403, "forbidden", "Không có quyền", "Thao tác yêu cầu quyền khác hoặc step-up MFA."),
        "NotFound": problem_resp(404, "not_found", "Không tìm thấy", "Tài nguyên không tồn tại hoặc ngoài phạm vi."),
        "Conflict": problem_resp(409, "conflict", "Xung đột", "Tài nguyên đang có job khác hoặc Idempotency-Key đã dùng với body khác."),
        "PreconditionFailed": problem_resp(412, "precondition_failed", "Phiên bản đã thay đổi", "If-Match không khớp ETag hiện tại."),
        "ValidationFailed": v422,
        "TooManyRequests": t429,
        "Gone": problem_resp(410, "setup_completed", "Wizard đã khóa", "Panel đã cài đặt xong; wizard không dùng lại được."),
        "AgentUnavailable": problem_resp(503, "agent_unavailable", "Agent không kết nối",
                                         "Không gọi được agent của server; thử lại sau."),
        "NotImplemented": problem_resp(501, "purge_not_available", "Chưa có ở phiên bản này",
                                       "Purge hiện thực ở Phase 8."),
    }

    def qp(name, schema, desc, required=False, where="query"):
        return {"name": name, "in": where, "required": required, "schema": schema, "description": desc}

    params = {
        "Id": qp("id", {"type": "string", "format": "uuid"}, "UUID tài nguyên.", True, "path"),
        "DomainId": qp("domain", {"type": "string", "format": "uuid"}, "UUID domain.", True, "path"),
        "RecordId": qp("record", {"type": "string", "format": "uuid"}, "UUID record DNS.", True, "path"),
        "RuleId": qp("rule", {"type": "string", "format": "uuid"}, "UUID rule tường lửa.", True, "path"),
        "UploadId": qp("upload", {"type": "string", "format": "uuid"}, "UUID phiên upload.", True, "path"),
        "Version": qp("version", {"type": "integer", "minimum": 1}, "Số phiên bản gói.", True, "path"),
        "ServiceName": qp("service", {"type": "string", "pattern": "^[a-z0-9@.-]{2,64}$"}, "Tên dịch vụ trong allowlist.", True, "path"),
        "ServiceAction": qp("action", {"type": "string", "enum": ["start", "stop", "restart", "reload"]}, "Hành động.", True, "path"),
        "PhpVersionPath": qp("version", {"type": "string", "pattern": "^[5-9]\\.[0-9]$"}, "Phiên bản PHP, ví dụ 8.3.", True, "path"),
        "PhpAction": qp("action", {"type": "string", "enum": ["install", "remove"]}, "Hành động.", True, "path"),
        "SoftwareKey": qp("key", {"type": "string", "pattern": "^[a-z0-9.+-]+$"}, "Khóa recipe.", True, "path"),
        "SoftwareAction": qp("action", {"type": "string", "enum": ["install", "remove", "upgrade"]}, "Hành động.", True, "path"),
        "ContainerId": qp("container", {"type": "string", "pattern": "^[0-9a-f]{12,64}$"}, "ID container.", True, "path"),
        "ContainerAction": qp("action", {"type": "string", "enum": ["start", "stop", "restart"]}, "Hành động.", True, "path"),
        "VolumeName": qp("volume", {"type": "string", "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"}, "Tên volume Docker.", True, "path"),
        "SettingsGroup": qp("group", {"type": "string", "enum": ["general", "security", "smtp", "backup", "updates"]}, "Nhóm cài đặt.", True, "path"),
        "Cursor": qp("cursor", {"type": "string"}, "Cursor trang tiếp theo."),
        "Limit": qp("limit", {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}, "Số bản ghi mỗi trang."),
        "Sort": qp("sort", {"type": "string", "pattern": "^-?[a-z_]+(,-?[a-z_]+)*$"}, "Sắp xếp, ví dụ `-created_at`."),
        "Q": qp("q", {"type": "string", "maxLength": 200}, "Tìm kiếm tự do."),
        "Offset": qp("offset", {"type": "integer", "minimum": 0, "default": 0}, "Vị trí byte bắt đầu đọc."),
        "PathQuery": qp("path", {"$ref": "#/components/schemas/RelPath"}, "Đường dẫn tương đối với home account.", True),
        "FilterHostingAccount": qp("filter[hosting_account]", {"type": "string", "format": "uuid"}, "Lọc theo account."),
        "FilterDestination": qp("filter[destination]", {"type": "string", "format": "uuid"}, "Lọc theo đích backup."),
        "FilterScopeType": qp("filter[scope_type]", {"type": "string", "enum": ["hosting_account", "website", "database", "server_config", "panel", "compose_project"]}, "Lọc theo loại backup."),
        "FilterServer": qp("filter[server]", {"type": "string", "format": "uuid"}, "Lọc theo server."),
        "FilterLifecycle": qp("filter[lifecycle_state]", {"$ref": "#/components/schemas/LifecycleState"}, "Lọc theo trạng thái vòng đời."),
        "FilterRealm": qp("filter[realm]", {"type": "string", "enum": ["admin", "portal"]}, "Lọc theo realm."),
        "FilterState": qp("filter[state]", {"$ref": "#/components/schemas/JobState"}, "Lọc theo trạng thái job."),
        "FilterSeverity": qp("filter[severity]", {"type": "string", "enum": ["info", "low", "medium", "high", "critical"]}, "Lọc theo mức độ."),
        "FilterAction": qp("filter[action]", {"type": "string"}, "Lọc theo action."),
        "FilterActor": qp("filter[actor]", {"type": "string", "format": "uuid"}, "Lọc theo người thực hiện."),
        "ServerQuery": qp("server", {"type": "string", "format": "uuid"}, "Server áp dụng.", True),
        "PackageQuery": qp("package", {"type": "string", "format": "uuid"}, "Gói dự định cấp.", True),
        "Metric": qp("metric", {"type": "string", "enum": ["cpu_pct", "ram_pct", "disk_pct", "net_in", "net_out", "load_1m",
                                                          "swap_pct", "inode_pct", "io_read", "io_write", "tasks"]}, "Số liệu.", True),
        "Range": qp("range", {"type": "string", "enum": ["1h", "24h", "7d", "30d", "90d"], "default": "24h"}, "Khoảng thời gian."),
        "FilterAlertState": qp("filter[state]", {"type": "string", "enum": ["pending", "firing", "resolved"]}, "Lọc theo trạng thái cảnh báo."),
        "FilterDeliveryState": qp("filter[delivery_state]", {"type": "string", "enum": ["queued", "sending", "sent", "retrying", "failed", "blocked"]}, "Lọc theo trạng thái gửi."),
        "FilterChannel": qp("filter[channel]", {"type": "string", "format": "uuid"}, "Lọc theo kênh thông báo."),
        "LogKind": qp("kind", {"type": "string", "enum": ["access", "error"]}, "Loại log.", True),
        "Lines": qp("lines", {"type": "integer", "minimum": 1, "maximum": 2000, "default": 200}, "Số dòng cuối."),
        "IdempotencyKey": qp("Idempotency-Key", {"type": "string", "format": "uuid"},
                             "Bắt buộc cho mọi POST tạo job. Lưu 24 giờ; trùng key khác body trả 409.", True, "header"),
        "IfMatch": qp("If-Match", {"type": "string"}, "ETag (theo spec_version) để tránh ghi đè đồng thời; sai trả 412.", False, "header"),
        "Realm": qp("X-ITSO-Realm", {"type": "string", "enum": ["admin", "portal"], "default": "portal"},
                    "Realm của request /auth/* khi Admin và Portal chung một origin (dev, demo). Khi cấu hình "
                    "host riêng (production), host quyết định và header bị bỏ qua (D-58).", False, "header"),
        "Expires": qp("expires", {"type": "integer"}, "Hạn chữ ký (Unix giây).", True),
        "Signature": qp("signature", {"type": "string", "pattern": "^[0-9a-f]{64}$"}, "Chữ ký HMAC của URL.", True),
        "ContentRange": qp("Content-Range", {"type": "string", "pattern": "^bytes [0-9]+-[0-9]+/[0-9]+$"}, "Vị trí chunk.", True, "header"),
    }
    headers = {"ETag": {"description": "Phiên bản tài nguyên (spec_version).", "schema": {"type": "string"}}}
    security = {
        "adminSession": {"type": "apiKey", "in": "cookie", "name": "itso_admin_session",
                         "description": "Session realm admin (D-58), cookie Secure; HttpOnly; SameSite=Strict."},
        "portalSession": {"type": "apiKey", "in": "cookie", "name": "itso_portal_session",
                          "description": "Session realm portal (D-58), cookie Secure; HttpOnly; SameSite=Strict."},
        "csrfToken": {"type": "apiKey", "in": "header", "name": "X-XSRF-TOKEN",
                      "description": "Giá trị cookie XSRF-TOKEN, bắt buộc cho request thay đổi trạng thái."},
        "bearerToken": {"type": "http", "scheme": "bearer",
                        "description": "API token nội bộ có scope (CLI `itso`, automation). Chỉ Admin API."},
    }
    return {"schemas": COMMON, "responses": responses, "parameters": params, "headers": headers,
            "securitySchemes": security}


INFO_DESC = {
    "admin": ("Admin API cho Private Admin Panel (SUPER_ADMIN, ADMIN) và CLI `itso` (API token). "
              "Chỉ truy cập từ origin admin + IP allowlist; MFA bắt buộc; step-up cho thao tác nguy hiểm. "
              "Mọi thao tác chạm Linux trả `202` + Job. Public Provisioning API: DEFERRED, không có trong contract này."),
    "portal": ("Portal API cho User Hosting Portal (USER). Public qua Internet: session cookie + CSRF, rate limit, "
               "CAPTCHA sau nhiều lần đăng nhập sai. Mọi truy vấn bị giới hạn trong tài nguyên của chính người dùng; "
               "truy cập tài nguyên ngoài phạm vi trả `404`."),
}


def build(realm: str) -> dict:
    api = Api(f"/api/v1/{realm}", realm)
    (admin_paths if realm == "admin" else portal_paths)(api)
    tags = sorted({t for p in api.paths.values() for op in p.values() for t in op["tags"]})
    sec = [{f"{realm}Session": [], "csrfToken": []}] + ([{"bearerToken": []}] if realm == "admin" else [])
    doc = {
        "openapi": "3.1.0",
        "info": {"title": f"ITSO Panel {'Admin' if realm == 'admin' else 'Portal'} API", "version": "1.0.0-p1",
                 "description": INFO_DESC[realm], "license": {"name": "Proprietary — ITSO", "identifier": "LicenseRef-ITSO"}},
        "servers": [{"url": "https://admin.itso.local" if realm == "admin" else "https://portal.itso.local",
                     "description": "Origin " + realm}],
        "security": sec,
        "tags": [{"name": t, "description": t} for t in tags],
        "paths": dict(sorted(api.paths.items())),
    }
    doc["components"] = {"securitySchemes": common_components()["securitySchemes"]}
    if realm == "admin":
        doc["components"]["schemas"] = ADMIN
    return doc


class Dumper(yaml.SafeDumper):
    def ignore_aliases(self, data):
        return True


def local_refs(node):
    """Trong common.yaml, ref tới chính nó dùng dạng `#/...`."""
    if isinstance(node, dict):
        return {k: (v.replace("./common.yaml#", "#") if k == "$ref" and isinstance(v, str) else local_refs(v))
                for k, v in node.items()}
    if isinstance(node, list):
        return [local_refs(x) for x in node]
    return node


def partial(store: dict, name: str, ref_fn) -> dict:
    """Tạo biến thể `<name>Patch` (bỏ required) cho PATCH cập nhật một phần."""
    patched = copy.deepcopy(store[name])
    patched.pop("required", None)
    patched["description"] = f"Cập nhật một phần {name}: chỉ gửi trường cần đổi."
    store[name + "Patch"] = patched
    return ref_fn(name + "Patch")


def dump(doc) -> str:
    return yaml.dump(doc, Dumper=Dumper, allow_unicode=True, sort_keys=False, width=120, default_flow_style=False)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    comps = common_components()
    common = {"openapi": "3.1.0",
              "info": {"title": "ITSO Panel — components chung", "version": "1.0.0-p1",
                       "license": {"name": "Proprietary — ITSO", "identifier": "LicenseRef-ITSO"}},
              "servers": [{"url": "https://admin.itso.local"}], "paths": {}, "components": comps}
    docs = {realm: build(realm) for realm in ("admin", "portal")}  # build trước: có thể thêm schema *Patch vào COMMON
    header = "# SINH TỰ ĐỘNG bởi contracts/tools/gen_openapi.py (make contracts). Không sửa tay.\n"
    text = dump(local_refs(common))
    (OUT / "common.yaml").write_text(header + text, encoding="utf-8")
    counts = {}
    for realm, doc in docs.items():
        counts[realm] = sum(len(v) for v in doc["paths"].values())
        (OUT / f"itso-{realm}-v1.yaml").write_text(header + dump(doc), encoding="utf-8")
    ex = ROOT / "examples"
    ex.mkdir(exist_ok=True)
    (ex / "demo-dataset.json").write_text(json.dumps(D.dataset(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Đã sinh OpenAPI: admin {counts['admin']} operation, portal {counts['portal']} operation")


if __name__ == "__main__":
    main()
