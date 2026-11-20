<?php

declare(strict_types=1);

namespace App\Providers;

use App\Auth\ApiTokenAuth;
use App\Auth\RealmSessionHandler;
use App\Infrastructure\Agent\AgentClient;
use Illuminate\Http\Client\Factory as Http;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Session;
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

    public function boot(): void
    {
        // Phiên trên bảng sessions có realm + mfa_verified_at (D-58).
        Session::extend('itso', function ($app): RealmSessionHandler {
            $connection = $app['db']->connection(config('session.connection'));

            return new RealmSessionHandler($connection, (string) config('session.table', 'sessions'),
                (int) config('session.lifetime', 120), $app);
        });
        // Guard token nội bộ: Authorization: Bearer itso_… (D-58).
        Auth::viaRequest('itso-token', fn (Request $request) => ApiTokenAuth::user($request));
    }
}
