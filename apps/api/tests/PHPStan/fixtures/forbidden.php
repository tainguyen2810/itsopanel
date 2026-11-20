<?php

// Fixture cho NoSystemCommandRule — KHÔNG phải mã chạy được, chỉ để test rule.

use Illuminate\Support\Facades\Process;
use Symfony\Component\Process\Process as SymfonyProcess;

function forbidden(string $cmd): void
{
    exec($cmd);
    shell_exec($cmd);
    system($cmd);
    passthru($cmd);
    proc_open($cmd, [], $pipes);
    popen($cmd, 'r');
    $x = `id`;
    Process::run($cmd);
    new SymfonyProcess([$cmd]);
    \EXEC($cmd);
}

function allowed(string $s): string
{
    return preg_replace('/a/', 'b', $s) ?? $s; // không bị bắt nhầm
}
