<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

/** Đích gửi bị SSRF guard chặn: delivery `blocked`, không thử lại. */
final class BlockedDestination extends \RuntimeException {}
