<?php

declare(strict_types=1);

namespace Tests\Support;

use Opis\JsonSchema\Errors\ErrorFormatter;
use Opis\JsonSchema\Validator;
use RuntimeException;
use Symfony\Component\Yaml\Yaml;

/**
 * Kiểm response theo schema trong contracts/openapi (nguồn sự thật).
 * Gộp components.schemas của file realm + common.yaml thành một tài liệu JSON Schema 2020-12.
 */
final class OpenApi
{
    private const BASE = 'https://schemas.itso.local/openapi/';

    /** @var array<string, array<string, mixed>> */
    private static array $docs = [];

    public static function contractsDir(): string
    {
        return dirname(__DIR__, 4).'/contracts/openapi';
    }

    /** @return array<string, mixed> */
    public static function doc(string $file): array
    {
        if (! isset(self::$docs[$file])) {
            $path = self::contractsDir().'/'.$file;
            if (! is_file($path)) {
                throw new RuntimeException("Không thấy $path");
            }
            /** @var array<string, mixed> $doc */
            $doc = Yaml::parseFile($path);
            self::$docs[$file] = $doc;
        }

        return self::$docs[$file];
    }

    /**
     * Schema của response 2xx/4xx cho (method, path) trong file realm.
     *
     * @return array{schema: mixed, contentType: string, file: string}
     */
    public static function responseSchema(string $file, string $method, string $path, int $status): array
    {
        $doc = self::doc($file);
        $op = $doc['paths'][$path][$method] ?? throw new RuntimeException("$method $path không có trong $file");
        $resp = $op['responses'][(string) $status] ?? throw new RuntimeException("$method $path không khai báo $status");
        $ctx = $file;
        if (isset($resp['$ref'])) {
            [$resp, $ctx] = self::resolve($file, $resp['$ref']);
        }
        $contentType = array_key_first($resp['content']);

        return ['schema' => $resp['content'][$contentType]['schema'], 'contentType' => (string) $contentType, 'file' => $ctx];
    }

    /** (method, path) có khai báo response `$status` trong file realm. */
    public static function declares(string $file, string $method, string $path, int $status): bool
    {
        return isset(self::doc($file)['paths'][$path][$method]['responses'][(string) $status]);
    }

    /** Trả về null nếu hợp lệ, ngược lại là thông báo lỗi. */
    public static function validate(string $file, mixed $schema, mixed $data): ?string
    {
        $validator = new Validator;
        $validator->setMaxErrors(5);
        foreach (array_unique(['common.yaml', 'itso-admin-v1.yaml', 'itso-portal-v1.yaml', $file]) as $f) {
            $validator->resolver()->registerRaw(self::toJson(self::bundle($f)), self::BASE.$f);
        }
        $root = json_decode(json_encode(self::rewrite($schema, $file)), false);
        $instance = json_decode(json_encode($data), false);
        $result = $validator->validate($instance, $root);
        if ($result->isValid()) {
            return null;
        }

        return json_encode((new ErrorFormatter)->format($result->error()), JSON_UNESCAPED_UNICODE) ?: 'invalid';
    }

    /** @return array<string, mixed> */
    private static function bundle(string $file): array
    {
        $schemas = self::doc($file)['components']['schemas'] ?? [];

        return [
            '$schema' => 'https://json-schema.org/draft/2020-12/schema',
            '$id' => self::BASE.$file,
            '$defs' => self::rewrite($schemas, $file),
        ];
    }

    /** Đổi $ref OpenAPI (#/components/schemas/X, ./common.yaml#/components/schemas/X) sang $defs tuyệt đối. */
    private static function rewrite(mixed $node, string $file): mixed
    {
        if (! is_array($node)) {
            return $node;
        }
        $out = [];
        foreach ($node as $k => $v) {
            if ($k === '$ref' && is_string($v)) {
                [$target, $pointer] = array_pad(explode('#', $v, 2), 2, '');
                $target = $target === '' ? $file : ltrim($target, './');
                $out[$k] = self::BASE.$target.'#'.str_replace('/components/schemas/', '/$defs/', $pointer);
            } else {
                $out[$k] = self::rewrite($v, $file);
            }
        }

        return $out;
    }

    /** @return array{0: array<string, mixed>, 1: string} */
    private static function resolve(string $file, string $ref): array
    {
        [$target, $pointer] = array_pad(explode('#', $ref, 2), 2, '');
        $target = $target === '' ? $file : ltrim($target, './');
        $node = self::doc($target);
        foreach (array_filter(explode('/', $pointer)) as $part) {
            $node = $node[$part] ?? throw new RuntimeException("Không giải được $ref");
        }

        return [$node, $target];
    }

    private static function toJson(mixed $v): object
    {
        $o = json_decode(json_encode($v, JSON_THROW_ON_ERROR), false, 512, JSON_THROW_ON_ERROR);
        if (! is_object($o)) {
            throw new RuntimeException('schema không phải object');
        }

        return $o;
    }
}
