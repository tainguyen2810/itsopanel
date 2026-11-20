<?php

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\OpenApi;
use Tests\TestCase;

// D-59: Feature test chạy trên PostgreSQL 16, mỗi test trong transaction (RefreshDatabase).
pest()->extend(TestCase::class)->use(RefreshDatabase::class)->in('Feature');

/** Response khớp schema trong contracts/openapi (status, Content-Type, body). */
function assertMatchesContract(string $file, string $method, string $path, int $status, $response): void
{
    if ($status === 204) {
        expect(OpenApi::declares($file, $method, $path, 204))->toBeTrue("$method $path không khai báo 204")
            ->and($response->status())->toBe(204)
            ->and($response->getContent())->toBe('');

        return;
    }
    ['schema' => $schema, 'contentType' => $ct, 'file' => $ctx] = OpenApi::responseSchema($file, $method, $path, $status);
    expect($response->status())->toBe($status)
        ->and($response->headers->get('Content-Type'))->toStartWith($ct);
    $error = OpenApi::validate($ctx, $schema, $response->json());
    expect($error)->toBeNull();
}
