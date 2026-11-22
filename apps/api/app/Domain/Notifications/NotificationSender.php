<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

use App\Jobs\SendNotification;
use App\Models\NotificationChannel;
use App\Models\NotificationDelivery;
use App\Models\User;
use GuzzleHttp\Exception\TransferException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

/**
 * Gửi một delivery (ADR 0048): email (SMTP Settings), Telegram Bot API, webhook ký HMAC qua SSRF guard.
 * Lỗi được thử lại tối đa 3 lần sau 1/5/15 phút (state retrying) rồi failed; bị chặn → blocked, không thử lại.
 * Thông điệp lỗi và payload không chứa bí mật (bot token, secret HMAC, mật khẩu SMTP).
 */
final class NotificationSender
{
    public const RETRY_MINUTES = [1, 5, 15];

    public const TIMEOUT_SEC = 5;

    public const MAX_RESPONSE_BYTES = 65536;

    public const TELEGRAM_API = 'https://api.telegram.org';

    public function __construct(private readonly SsrfGuard $guard, private readonly EmailSender $email) {}

    /** Một lần gửi. $retry = false (gửi thử đồng bộ): lỗi → failed ngay, không lên lịch thử lại. */
    public function attempt(int $deliveryId, bool $retry = true): ?NotificationDelivery
    {
        /** @var NotificationDelivery|null $d */
        $d = DB::transaction(function () use ($deliveryId): ?NotificationDelivery {
            $d = NotificationDelivery::query()->whereKey($deliveryId)->lockForUpdate()->first();
            if (! $d instanceof NotificationDelivery || ! in_array($d->state, ['queued', 'retrying'], true)) {
                return null;
            }
            $d->state = 'sending';
            $d->attempts++;
            $d->next_retry_at = null;
            $d->save();

            return $d;
        });
        if ($d === null) {
            return NotificationDelivery::query()->find($deliveryId);
        }
        $now = Carbon::now();
        try {
            $d->response_code = $this->send($d);
            $d->state = 'sent';
            $d->sent_at = $now;
            $d->error = null;
        } catch (BlockedDestination $e) {
            $d->state = 'blocked';
            $d->error = mb_substr($e->getMessage(), 0, 300);
            $d->response_code = null;
        } catch (SendFailure $e) {
            $d->error = $e->getMessage();
            $d->response_code = $e->responseCode;
            $n = $d->attempts - 1; // số lần đã thử lại
            if ($retry && $e->retryable && $n < count(self::RETRY_MINUTES)) {
                $d->state = 'retrying';
                $d->next_retry_at = $now->copy()->addMinutes(self::RETRY_MINUTES[$n]);
            } else {
                $d->state = 'failed';
            }
        }
        $d->save();
        if ($d->state === 'retrying' && $d->next_retry_at !== null) {
            SendNotification::dispatch($d->id)->delay($d->next_retry_at);
        }

        return $d;
    }

    /** @throws BlockedDestination|SendFailure */
    private function send(NotificationDelivery $d): int
    {
        $p = $d->payload;
        $text = self::text($d);
        if ($d->channel_id === null) {
            $u = $d->recipient;
            if (! $u instanceof User || $u->status !== 'active' || $u->email === '') {
                throw new SendFailure('Người nhận không còn hoạt động.', null, false);
            }

            return $this->email->send([$u->email], self::subject($d), $text);
        }
        $c = $d->channel;
        if (! $c instanceof NotificationChannel) {
            throw new SendFailure('Kênh đã bị xóa.', null, false);
        }
        if (! $c->enabled && ($p['test'] ?? false) !== true) {
            throw new SendFailure('Kênh đang tắt.', null, false);
        }

        return match ($c->type) {
            'email' => $this->email->send(array_values(array_filter((array) ($c->config['recipients'] ?? []), 'is_string')),
                self::subject($d), $text),
            'telegram' => $this->telegram($c, $text),
            default => $this->webhook($c, $d),
        };
    }

    private function telegram(NotificationChannel $c, string $text): int
    {
        $token = (string) $c->secret();
        $redact = fn (string $s): string => $token === '' ? $s : str_replace($token, '[REDACTED]', $s);
        try {
            $res = Http::timeout(self::TIMEOUT_SEC)->connectTimeout(self::TIMEOUT_SEC)->withOptions(['allow_redirects' => false])
                ->asJson()->post(self::TELEGRAM_API.'/bot'.$token.'/sendMessage', [
                    'chat_id' => (string) ($c->config['chat_id'] ?? ''), 'text' => mb_substr($text, 0, 4000),
                    'disable_web_page_preview' => true,
                ]);
        } catch (ConnectionException $e) {
            throw new SendFailure($redact('Telegram: không kết nối được ('.$e->getMessage().')'));
        }
        if (! $res->successful()) {
            $desc = is_string($res->json('description')) ? ': '.$res->json('description') : '';
            throw new SendFailure($redact('Telegram HTTP '.$res->status().$desc), $res->status(), $res->status() >= 500 || $res->status() === 429);
        }

        return $res->status();
    }

    /** @throws BlockedDestination|SendFailure */
    private function webhook(NotificationChannel $c, NotificationDelivery $d): int
    {
        $url = (string) ($c->config['url'] ?? '');
        $dest = $this->guard->check($url, ($c->config['allow_private_network'] ?? false) === true);
        $secret = (string) $c->secret();
        $body = json_encode(self::webhookBody($d), JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $ts = (string) Carbon::now()->getTimestamp();
        $ip = str_contains($dest['ip'], ':') ? '['.$dest['ip'].']' : $dest['ip'];
        $tooBig = false;
        try {
            /** @var Response $res */
            $res = Http::timeout(self::TIMEOUT_SEC)->connectTimeout(self::TIMEOUT_SEC)
                // proxy '' = CURLOPT_PROXY rỗng: bỏ HTTPS_PROXY/HTTP_PROXY của môi trường (proxy tự phân giải DNS,
                // làm mất ghim IP của SsrfGuard ⇒ DNS rebinding). Webhook luôn đi thẳng.
                // Không dùng 'stream' (StreamHandler bỏ qua tùy chọn cURL ⇒ mất CURLOPT_RESOLVE): body giới hạn bằng
                // callback progress (trả true ⇒ cURL hủy khi đã nhận > 64 KB, kể cả chunked) + timeout tổng 5 giây.
                ->withOptions(['allow_redirects' => false, 'proxy' => '',
                    'progress' => static function (int $total, int $got) use (&$tooBig): bool {
                        return $tooBig = $got > self::MAX_RESPONSE_BYTES;
                    },
                    'curl' => [CURLOPT_RESOLVE => [$dest['host'].':'.$dest['port'].':'.$ip]]])
                ->withHeaders(['X-ITSO-Timestamp' => $ts, 'X-ITSO-Signature' => 'sha256='.self::sign($secret, $ts, $body),
                    'X-ITSO-Event' => $d->event_type, 'X-ITSO-Delivery' => $d->uuid, 'User-Agent' => 'ITSO-Panel-Webhook/1'])
                ->withBody($body, 'application/json')->post($url);
        } catch (ConnectionException|TransferException $e) {
            if ($tooBig) {
                throw new SendFailure('Webhook: phản hồi quá lớn (> 64 KB) từ '.$dest['host'].'; đã ngắt.', null, false);
            }
            if ($e instanceof ConnectionException) {
                throw new SendFailure('Webhook: không kết nối được tới '.$dest['host'].'.');
            }
            // Lỗi truyền sau khi kết nối: không đưa URL/chi tiết cURL vào lỗi.
            throw new SendFailure('Webhook: kết nối tới '.$dest['host'].' bị ngắt khi nhận phản hồi.');
        }
        $snippet = mb_substr(trim((string) $res->toPsrResponse()->getBody()->read(self::MAX_RESPONSE_BYTES)), 0, 120);
        if ($res->status() >= 300 && $res->status() < 400) {
            throw new SendFailure('Webhook trả chuyển hướng HTTP '.$res->status().'; không theo redirect.', $res->status(), false);
        }
        if (! $res->successful()) {
            throw new SendFailure('Webhook HTTP '.$res->status().($snippet !== '' ? ': '.$snippet : ''), $res->status());
        }

        return $res->status();
    }

    public static function sign(string $secret, string $ts, string $body): string
    {
        return hash_hmac('sha256', $ts.'.'.$body, $secret);
    }

    /** @return array<string, mixed> */
    public static function webhookBody(NotificationDelivery $d): array
    {
        $p = $d->payload;

        return ['event' => $d->event_type, 'delivery' => $d->uuid, 'severity' => $d->severity, 'title' => $d->title,
            'body' => (string) ($p['body'] ?? ''), 'link' => $p['link'] ?? null, 'created_at' => $d->created_at->toIso8601String()];
    }

    private static function subject(NotificationDelivery $d): string
    {
        return '['.strtoupper($d->severity).'] '.$d->title;
    }

    private static function text(NotificationDelivery $d): string
    {
        $p = $d->payload;
        $link = is_string($p['link'] ?? null) ? "\n".self::absoluteLink($d, $p['link']) : '';

        return '['.strtoupper($d->severity).'] '.$d->title."\n".(string) ($p['body'] ?? '').$link;
    }

    /**
     * Link trong payload là đường dẫn trong realm (vd. `/monitoring/alerts`, như in-app). Email/Telegram cần URL đầy đủ
     * kèm tiền tố realm: kênh admin → `/admin`, email cá nhân theo realm của người nhận.
     */
    private static function absoluteLink(NotificationDelivery $d, string $link): string
    {
        $realm = 'admin';
        if ($d->recipient_user_id !== null) {
            $realm = (string) (User::query()->whereKey($d->recipient_user_id)->value('realm') ?? 'admin');
        }
        $path = preg_match('#^/(admin|portal)(/|$)#', $link) === 1 ? $link : '/'.$realm.'/'.ltrim($link, '/');

        return rtrim((string) config('app.url'), '/').$path;
    }
}
