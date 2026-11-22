<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

use App\Http\Controllers\Api\V1\Admin\SettingsController;
use App\Models\Setting;
use Symfony\Component\Mailer\Exception\TransportExceptionInterface;
use Symfony\Component\Mailer\Transport\Smtp\EsmtpTransport;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;

/** Gửi email qua SMTP cấu hình ở Settings → SMTP (mật khẩu Crypt). Không phải final để test thay bằng bản giả. */
class EmailSender
{
    /**
     * @param  list<string>  $to
     * @return int mã phản hồi SMTP khi thành công (250)
     *
     * @throws SendFailure
     */
    public function send(array $to, string $subject, string $text): int
    {
        $cfg = $this->settings();
        if ($cfg['host'] === '') {
            throw new SendFailure('SMTP chưa được cấu hình (Cài đặt → SMTP).', null, false);
        }
        $password = SettingsController::secret('smtp', 'password');
        $transport = new EsmtpTransport($cfg['host'], $cfg['port'], $cfg['encryption'] === 'tls');
        if ($cfg['encryption'] === 'none') {
            $transport->setAutoTls(false);
        } elseif ($cfg['encryption'] === 'starttls') {
            $transport->setRequireTls(true);
        }
        if ($cfg['username'] !== '') {
            $transport->setUsername($cfg['username']);
            $transport->setPassword((string) $password);
        }
        try {
            $email = (new Email)->from(Address::create($cfg['from']))->subject($subject)->text($text);
            foreach ($to as $addr) {
                $email->addTo($addr);
            }
            $transport->send($email);
        } catch (TransportExceptionInterface $e) {
            $msg = $e->getMessage();
            if (is_string($password) && $password !== '') {
                $msg = str_replace($password, '[REDACTED]', $msg);
            }
            throw new SendFailure('SMTP: '.$msg, $e->getCode() > 0 ? $e->getCode() : null);
        } catch (\Throwable $e) {
            throw new SendFailure('SMTP: '.$e::class, null, false);
        }

        return 250;
    }

    /** @return array{host: string, port: int, username: string, from: string, encryption: string} */
    private function settings(): array
    {
        $def = (array) config('itso_settings.smtp');
        $rows = Setting::query()->where('group_key', 'smtp')->get()->keyBy('key');
        $v = function (string $k) use ($rows, $def): mixed {
            $row = $rows->get($k);

            return $row !== null && is_array($row->value) && array_key_exists('v', $row->value) ? $row->value['v'] : ($def[$k]['default'] ?? null);
        };

        return ['host' => (string) $v('host'), 'port' => (int) $v('port'), 'username' => (string) $v('username'),
            'from' => (string) $v('from'), 'encryption' => (string) $v('encryption')];
    }
}
