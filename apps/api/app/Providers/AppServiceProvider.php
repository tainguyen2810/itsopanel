<?php

declare(strict_types=1);

namespace App\Providers;

use App\Infrastructure\Agent\AgentClient;
use Illuminate\Http\Client\Factory as Http;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(AgentClient::class, function ($app): AgentClient {
            $socket = config('itso.agent.socket');
            $url = config('itso.agent.url');
            $timeout = config('itso.agent.timeout');

            return new AgentClient(
                $app->make(Http::class),
                is_string($socket) && $socket !== '' ? $socket : null,
                is_string($url) && $url !== '' ? $url : null,
                is_numeric($timeout) ? (float) $timeout : 5.0,
            );
        });
    }

    public function boot(): void {}
}
