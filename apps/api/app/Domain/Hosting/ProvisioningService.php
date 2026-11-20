<?php

declare(strict_types=1);

namespace App\Domain\Hosting;

/**
 * Hosting Provisioning Service — điểm vào DUY NHẤT để tạo/sửa/treo/xóa hosting account.
 *
 * D-49: Admin Panel (Laravel controller) và CLI `itso` (qua gateway) dùng chung service này,
 * nên mọi luồng đều đi qua cùng một chuỗi kiểm tra: quota gói (snapshot), placement server,
 * state machine (docs/planning, database/docs/lifecycle.md), audit, rồi tạo Job gồm các bước
 * agent op có kiểu (contracts/agent-ops). Service KHÔNG chạy lệnh hệ thống; mọi thao tác
 * Linux đi qua Go Agent.
 *
 * Public Provisioning API (/api/provisioning/*) và Billing Adapter: DEFERRED — khi bật lại
 * cũng phải gọi qua service này, không đi đường riêng.
 *
 * Phase 1: chỉ khai báo interface. Phương thức được định nghĩa ở Phase 3 (Prompt 3.x) theo
 * contracts/openapi (createHostingAccount, suspend, unsuspend, terminate, changePackage...).
 */
interface ProvisioningService {}
