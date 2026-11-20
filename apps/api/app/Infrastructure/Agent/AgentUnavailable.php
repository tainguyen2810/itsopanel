<?php

declare(strict_types=1);

namespace App\Infrastructure\Agent;

use RuntimeException;

/** Không kết nối được agent hoặc agent trả dữ liệu sai giao thức. */
final class AgentUnavailable extends RuntimeException {}
