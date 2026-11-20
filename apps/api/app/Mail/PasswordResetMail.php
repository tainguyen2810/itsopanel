<?php

declare(strict_types=1);

namespace App\Mail;

use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;

/** Email đặt lại mật khẩu (dạng text; driver `log` ở dev). */
final class PasswordResetMail extends Mailable
{
    public function __construct(public readonly string $name, public readonly string $url, public readonly int $minutes) {}

    public function envelope(): Envelope
    {
        return new Envelope(subject: 'ITSO Panel: đặt lại mật khẩu / Reset your password');
    }

    public function content(): Content
    {
        return new Content(text: 'mail.password-reset');
    }
}
