# Runbook: nhiều máy chủ (control plane + node)

Áp dụng từ Phase 9 (ADR 0034–0036). Node chỉ kết nối **ra** cổng 28444 của control plane; không mở cổng quản trị inbound.

## 1. Control plane

- Cài mới: `sudo bash install.sh --role control-plane` (hoặc `--role all-in-one`, mặc định). Bước `pki` tạo CA nội bộ (`/etc/itso/pki/ca.key` root 0600), chứng chỉ relay (`/etc/itso/relay/relay.pem`, khóa 0600 thuộc `itso-relay`) và khóa ký enroll (`/etc/itso/relay/enroll.key`, 0640 `root:itso-relay`).
- Máy cài từ Phase 4–8 (chưa có CA): `sudo itso pki init` rồi `sudo systemctl enable --now itso-relay.service`.
- Pin CA cho lệnh join: `itso pki pin` (sha256 chứng chỉ CA, 64 ký tự hex).
- Tường lửa: mở `28444/tcp` inbound (node vào), cổng panel và 80/443 như cũ.
- Trạng thái: `itso node status` (vai trò, pin CA, trạng thái `itso-relay`).

## 2. Thêm node

1. Panel → Máy chủ → Thêm node: tạo token một lần (hạn 5–1440 phút) và lệnh join.
2. Trên máy node (Ubuntu 24.04 sạch):

   ```bash
   sudo bash install.sh --role node --join https://<control-plane>:28444 \
     --token itso_enr_… --ca-sha256 <pin>
   ```

   Có thể đặt token qua biến `ITSO_JOIN_TOKEN` để không hiện trong lịch sử shell.
3. Installer tải CA từ relay, so sha256 với `--ca-sha256` (sai → dừng, **không gửi token**), sinh khóa ECDSA P-256 trên node, gửi CSR + token qua TLS đã ghim, nhận chứng chỉ 30 ngày + khóa HMAC riêng, ghi `/etc/itso/node/` (0700) và `/etc/itso/agent.key` (0600), bật `itso-agent-node.service`.
4. Node không cài Laravel, PostgreSQL panel, Redis, itso-relay.

## 3. Vận hành node

| Việc | Lệnh |
|---|---|
| Xem trạng thái (server_uuid, relay, hạn chứng chỉ, agent) | `itso node status` |
| Cấp lại chứng chỉ khi bị thu hồi/mất/hết hạn | `sudo itso node rejoin --token itso_enr_… --ca-sha256 <pin>` (`--join` mặc định lấy từ `/etc/itso/node.json`) |
| Rời control plane (giữ dữ liệu hosting) | Thu hồi node trong panel trước, rồi `sudo itso node leave --yes` |
| Nhật ký agent | `journalctl -u itso-agent-node` |

Chứng chỉ node được panel xoay tự động khi qua 2/3 hạn (`itso-cert-rotate.timer` trên control plane, op `agent.cert.rotate` hai pha).

## 4. Sự cố

- **Node mất kết nối:** job mới cho node chờ ở trạng thái `waiting_agent` (D-91); kiểm `itso node status` trên node, mạng ra cổng 28444, `systemctl status itso-relay` trên control plane.
- **`CA … KHÔNG khớp --ca-sha256`:** lệnh join sai hoặc có thiết bị chặn giữa đường; lấy lại pin bằng `itso pki pin` trên control plane.
- **Chứng chỉ hết hạn:** relay từ chối bắt tay; chạy `itso node rejoin` với token mới.
