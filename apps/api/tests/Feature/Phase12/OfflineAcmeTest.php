<?php

use App\Domain\Web\WebsiteSpec;
use App\Exceptions\ApiProblem;

// Prompt 12.6 (D-113): `itso install --offline` ghi ITSO_ACME_DIRECTORY=disabled → panel từ chối ACME với lỗi rõ ràng.

it('cài offline: ACME tắt → 409 kèm hướng dẫn tải chứng chỉ lên', function () {
    config(['itso.acme.directory' => 'disabled', 'itso.acme.email' => 'ops@itso.vn']);
    try {
        WebsiteSpec::acmeDirectory();
        $this->fail('phải từ chối');
    } catch (ApiProblem $e) {
        expect($e->status)->toBe(409)->and($e->detail)->toContain('offline');
    }
    config(['itso.acme.directory' => 'letsencrypt']);
    expect(WebsiteSpec::acmeDirectory())->toBe('letsencrypt');
});
