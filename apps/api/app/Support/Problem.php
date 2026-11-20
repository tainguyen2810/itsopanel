<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Http\JsonResponse;

/**
 * RFC 9457 Problem Details (contracts/openapi/common.yaml#/components/schemas/Problem).
 */
final class Problem
{
    public const TYPE_BASE = 'https://docs.itso.local/errors/';

    /**
     * @param  array<string, list<string>>|null  $errors
     * @param  array<string, string>  $headers
     */
    public static function response(
        int $status,
        string $code,
        string $title,
        ?string $detail = null,
        ?array $errors = null,
        array $headers = [],
    ): JsonResponse {
        $body = [
            'type' => self::TYPE_BASE.$code,
            'title' => $title,
            'status' => $status,
            'code' => $code,
        ];
        if ($detail !== null && $detail !== '') {
            $body['detail'] = $detail;
        }
        if ($errors !== null) {
            $body['errors'] = $errors;
        }
        $requestId = request()->attributes->get('request_id');
        if (is_string($requestId)) {
            $body['request_id'] = $requestId;
        }
        $body['instance'] = '/'.ltrim(request()->path(), '/');

        return new JsonResponse($body, $status, $headers + ['Content-Type' => 'application/problem+json'],
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
