<?php

use App\Domain\Notifications\NotificationDispatcher;
use App\Domain\Notifications\NotificationSender;
use App\Domain\Notifications\SsrfGuard;
use App\Models\NotificationChannel;
use App\Models\NotificationDelivery;
use Illuminate\Support\Facades\Queue;
use Tests\Support\Actors;

// Prompt 11.8: webhook qua HTTP thật (cURL handler, không Http::fake). E2E stack thật tìm ra lỗi: tùy chọn
// 'stream' chuyển Guzzle sang StreamHandler, bỏ qua CURLOPT_RESOLVE ⇒ mọi webhook lỗi 500. Test này giữ đường
// truyền thật: ghim IP, chữ ký, không redirect, giới hạn body 64 KB.

const P118_SECRET = 'hmac-secret-transport-0123456789';

/** @return array{0: resource, 1: int, 2: string} */
function p118server(): array
{
    $log = tempnam(sys_get_temp_dir(), 'hook');
    for ($try = 0; $try < 5; $try++) {
        $port = random_int(20000, 39999);
        $proc = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__.'/../../Support/webhook_router.php'],
            [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, null,
            ['ITSO_HOOK_LOG' => $log, 'PATH' => getenv('PATH')]);
        for ($i = 0; $i < 50; $i++) {
            $s = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.1);
            if ($s !== false) {
                fclose($s);

                return [$proc, $port, $log];
            }
            usleep(50_000);
        }
        proc_terminate($proc);
    }
    throw new RuntimeException('Không mở được php -S');
}

/** Guard test: tên hook.itso.test luôn trỏ về 127.0.0.1 (máy chủ php -S); vẫn đi qua CURLOPT_RESOLVE như thật. */
function p118guard(int $port): void
{
    app()->instance(SsrfGuard::class, new class($port) extends SsrfGuard
    {
        public function __construct(private readonly int $p) {}

        public function check(string $url, bool $allowPrivate): array
        {
            return ['scheme' => 'http', 'host' => 'hook.itso.test', 'port' => $this->p, 'ip' => '127.0.0.1'];
        }
    });
}

function p118channel(int $port, string $path): NotificationChannel
{
    $c = new NotificationChannel(['type' => 'webhook', 'name' => "Hook $path",
        'config' => ['url' => "http://hook.itso.test:$port$path", 'allow_private_network' => true], 'enabled' => true]);
    $c->setSecret(P118_SECRET);
    $c->save();

    return $c->refresh();
}

it('webhook qua cURL thật: ghim IP theo guard, ký HMAC đúng, 503 → retrying, redirect → failed, body > 64 KB bị cắt', function () {
    new Actors($this);
    [$proc, $port, $log] = p118server();
    try {
        p118guard($port);
        // Queue giả: tự gọi một lần gửi (queue sync sẽ chạy luôn các lần thử lại có delay).
        Queue::fake();
        $disp = new class
        {
            public function toChannel(NotificationChannel $c, string $type, string $title, string $body, string $sev): NotificationDelivery
            {
                $d = app(NotificationDispatcher::class)->toChannel($c, $type, $title, $body, $sev);
                app(NotificationSender::class)->attempt($d->id);

                return $d;
            }
        };

        $ok = $disp->toChannel(p118channel($port, '/ok'), 'alert.firing', 'Disk 95%', 'srv-01', 'high');
        expect($ok->refresh()->state)->toBe('sent')->and($ok->response_code)->toBe(200);
        $req = json_decode(trim((string) file_get_contents($log)), true);
        // Tên miền gốc giữ trong Host (ghim IP bằng CURLOPT_RESOLVE, không viết lại URL).
        expect($req['host'])->toBe("hook.itso.test:$port")
            ->and($req['sig'])->toBe('sha256='.hash_hmac('sha256', $req['ts'].'.'.$req['body'], P118_SECRET))
            ->and(json_decode($req['body'], true))->toMatchArray(['event' => 'alert.firing', 'delivery' => $ok->uuid]);

        $fail = $disp->toChannel(p118channel($port, '/fail'), 'alert.firing', 'Lần 2', '', 'high');
        expect($fail->refresh()->state)->toBe('retrying')->and($fail->response_code)->toBe(503)
            ->and($fail->error)->toContain('503');

        $redir = $disp->toChannel(p118channel($port, '/redirect'), 'alert.firing', 'Lần 3', '', 'high');
        expect($redir->refresh()->state)->toBe('failed')->and($redir->response_code)->toBe(302);

        $big = $disp->toChannel(p118channel($port, '/big'), 'alert.firing', 'Lần 4', '', 'high');
        expect($big->refresh()->state)->not->toBe('sent')->and($big->error)->toContain('quá lớn')->and($big->attempts)->toBe(1);
        // Không có lần gửi nào theo redirect tới 169.254.169.254.
        expect(substr_count((string) file_get_contents($log), "\n"))->toBe(4);
    } finally {
        proc_terminate($proc);
        @unlink($log);
    }
});
