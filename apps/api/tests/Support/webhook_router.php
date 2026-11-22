<?php

// Router cho `php -S` trong WebhookTransportTest: HTTP thật để kiểm webhook qua cURL handler (không Http::fake).
// Ghi mỗi request (header ITSO + body) thành một dòng JSON vào file trong ITSO_HOOK_LOG.

$log = getenv('ITSO_HOOK_LOG');
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$body = (string) file_get_contents('php://input');
if (is_string($log) && $log !== '') {
    file_put_contents($log, json_encode([
        'path' => $path,
        'host' => $_SERVER['HTTP_HOST'] ?? '',
        'ts' => $_SERVER['HTTP_X_ITSO_TIMESTAMP'] ?? '',
        'sig' => $_SERVER['HTTP_X_ITSO_SIGNATURE'] ?? '',
        'body' => $body,
    ])."\n", FILE_APPEND);
}
switch ($path) {
    case '/big':
        // 256 KB không có Content-Length (chunked): phía gửi phải cắt ở 64 KB.
        header('Content-Type: text/plain');
        for ($i = 0; $i < 64; $i++) {
            echo str_repeat('x', 4096);
            flush();
        }
        break;
    case '/redirect':
        header('Location: http://169.254.169.254/latest/meta-data/', true, 302);
        break;
    case '/fail':
        http_response_code(503);
        echo 'bảo trì';
        break;
    default:
        header('Content-Type: application/json');
        echo '{"ok":true}';
}
