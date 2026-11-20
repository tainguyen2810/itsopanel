<?php

return [
    // Phiên bản panel; commit được truyền qua biến môi trường lúc build (không gọi git từ PHP).
    'version' => env('ITSO_VERSION', '0.1.0-alpha'),
    'commit' => env('ITSO_COMMIT', 'dev'),
    'agent_min_version' => '0.1.0',

    'agent' => [
        // Linux: unix socket. Windows dev: ITSO_AGENT_URL=http://127.0.0.1:7810.
        'socket' => env('ITSO_AGENT_SOCKET', '/tmp/itso-mock-agent.sock'),
        'url' => env('ITSO_AGENT_URL'),
        'timeout' => (float) env('ITSO_AGENT_TIMEOUT', 5),
    ],

    // Trước Phase 3 (chưa có auth), các route /api/v1/admin/system/* chỉ bật ở các môi trường này.
    'dev_routes_envs' => ['local', 'testing'],
];
