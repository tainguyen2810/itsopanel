<?php

declare(strict_types=1);

namespace App\Domain\Docker;

/**
 * Mẫu compose dựng sẵn (ADR 0041). Image ghim phiên bản; cổng chỉ ghi cổng container (validator cấp cổng host
 * 127.0.0.1:<20000–29999>); có mem_limit. Mẫu vẫn phải qua validator như YAML tự viết.
 */
final class ComposeTemplates
{
    /** @var list<array{key: string, name: string, description: string, category: string, web_service: string|null, compose_yaml: string}> */
    public const ALL = [
        ['key' => 'uptime-kuma', 'name' => 'Uptime Kuma', 'description' => 'Theo dõi uptime website và dịch vụ nội bộ',
            'category' => 'monitoring', 'web_service' => 'app',
            'compose_yaml' => "services:\n  app:\n    image: louislam/uptime-kuma:1.23.16\n    ports:\n      - \"3001\"\n    volumes:\n      - kuma-data:/app/data\n    mem_limit: 512m\n    cpus: 1\nvolumes:\n  kuma-data: {}\n"],
        ['key' => 'n8n', 'name' => 'n8n', 'description' => 'Tự động hóa quy trình (workflow automation)', 'category' => 'automation',
            'web_service' => 'app',
            'compose_yaml' => "services:\n  app:\n    image: n8nio/n8n:1.72.1\n    ports:\n      - \"5678\"\n    environment:\n      N8N_SECURE_COOKIE: \"true\"\n    volumes:\n      - n8n-data:/home/node/.n8n\n    mem_limit: 1024m\n    cpus: 1\nvolumes:\n  n8n-data: {}\n"],
        ['key' => 'minio', 'name' => 'MinIO', 'description' => 'Lưu trữ đối tượng tương thích S3 cho nội bộ', 'category' => 'storage',
            'web_service' => 'app',
            'compose_yaml' => "services:\n  app:\n    image: minio/minio:RELEASE.2024-11-07T00-52-20Z\n    command: [\"server\", \"/data\", \"--console-address\", \":9001\"]\n    ports:\n      - \"9001\"\n    volumes:\n      - minio-data:/data\n    mem_limit: 1024m\nvolumes:\n  minio-data: {}\n"],
        ['key' => 'redis', 'name' => 'Redis (cache)', 'description' => 'Redis riêng cho ứng dụng nội bộ, chỉ nghe 127.0.0.1',
            'category' => 'database', 'web_service' => null,
            'compose_yaml' => "services:\n  redis:\n    image: redis:7.4-alpine\n    ports:\n      - \"6379\"\n    volumes:\n      - redis-data:/data\n    mem_limit: 256m\nvolumes:\n  redis-data: {}\n"],
    ];

    /** @return array{key: string, name: string, description: string, category: string, web_service: string|null, compose_yaml: string}|null */
    public static function find(string $key): ?array
    {
        foreach (self::ALL as $t) {
            if ($t['key'] === $key) {
                return $t;
            }
        }

        return null;
    }
}
