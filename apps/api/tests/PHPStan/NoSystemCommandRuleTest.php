<?php

declare(strict_types=1);

namespace Tests\PHPStan;

use Itso\PHPStan\NoSystemCommandRule;
use PHPStan\Rules\Rule;
use PHPStan\Testing\RuleTestCase;

/** @extends RuleTestCase<NoSystemCommandRule> */
final class NoSystemCommandRuleTest extends RuleTestCase
{
    protected function getRule(): Rule
    {
        return new NoSystemCommandRule;
    }

    public function test_bat_moi_cach_chay_lenh_he_thong(): void
    {
        $this->analyse([__DIR__.'/fixtures/forbidden.php'], [
            ['Import Illuminate\Support\Facades\Process bị cấm trong apps/api/app.', 5],
            ['Import Symfony\Component\Process\Process bị cấm trong apps/api/app.', 6],
            ['Hàm exec() bị cấm: Laravel không chạy lệnh hệ thống, dùng AgentClient.', 10],
            ['Hàm shell_exec() bị cấm: Laravel không chạy lệnh hệ thống, dùng AgentClient.', 11],
            ['Hàm system() bị cấm: Laravel không chạy lệnh hệ thống, dùng AgentClient.', 12],
            ['Hàm passthru() bị cấm: Laravel không chạy lệnh hệ thống, dùng AgentClient.', 13],
            ['Hàm proc_open() bị cấm: Laravel không chạy lệnh hệ thống, dùng AgentClient.', 14],
            ['Hàm popen() bị cấm: Laravel không chạy lệnh hệ thống, dùng AgentClient.', 15],
            ['Toán tử backtick (shell exec) bị cấm trong apps/api/app.', 16],
            ['Lớp Illuminate\Support\Facades\Process chạy tiến trình hệ thống, bị cấm trong apps/api/app.', 17],
            ['Lớp Symfony\Component\Process\Process chạy tiến trình hệ thống, bị cấm trong apps/api/app.', 18],
            ['Hàm exec() bị cấm: Laravel không chạy lệnh hệ thống, dùng AgentClient.', 19],
        ]);
    }
}
