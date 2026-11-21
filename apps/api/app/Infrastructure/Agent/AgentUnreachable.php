<?php

declare(strict_types=1);

namespace App\Infrastructure\Agent;

/**
 * Node từ xa không kết nối với itso-relay (relay trả 503 agent_unreachable, D-91). Khác AgentUnavailable ở chỗ
 * job nên chờ node quay lại (waiting_agent) thay vì coi là lỗi.
 */
final class AgentUnreachable extends AgentUnavailable {}
