<?php

// Web (apps/web) gọi API cùng origin (Vite proxy ở dev, Nginx ở production) nên không cần CORS.
// Chỉ mở khi đặt ITSO_CORS_ORIGINS (danh sách phân tách bằng dấu phẩy), ví dụ cho công cụ dev.
$origins = array_values(array_filter(array_map('trim', explode(',', (string) env('ITSO_CORS_ORIGINS', '')))));

return [
    'paths' => $origins === [] ? [] : ['api/*'],
    'allowed_methods' => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    'allowed_origins' => $origins,
    'allowed_origins_patterns' => [],
    'allowed_headers' => ['Accept', 'Content-Type', 'Idempotency-Key', 'If-Match', 'X-Request-Id', 'X-XSRF-TOKEN'],
    'exposed_headers' => ['ETag', 'X-Request-Id', 'Retry-After'],
    'max_age' => 600,
    'supports_credentials' => true,
];
