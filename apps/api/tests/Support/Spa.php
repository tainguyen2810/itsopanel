<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Auth\Realm;
use App\Models\User;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Trình duyệt giả cho SPA: giữ cookie giữa các request như trình duyệt thật (cookie mã hóa do server gửi),
 * tự gửi header X-XSRF-TOKEN từ cookie XSRF của realm, và dựng lại session store/guard mỗi request
 * (không dùng trạng thái session trong bộ nhớ của test như actingAs).
 */
final class Spa
{
    /** @var array<string, string> */
    public array $jar = [];

    public bool $sendXsrf = true;

    public function __construct(private readonly TestCase $t, public string $realm = Realm::PORTAL, public string $ip = '127.0.0.1') {}

    /**
     * @param  array<string, mixed>  $data
     * @param  array<string, string>  $headers
     * @param  string|null  $raw  body nhị phân (application/octet-stream) thay cho JSON
     */
    public function call(string $method, string $uri, array $data = [], array $headers = [], ?string $raw = null): TestResponse
    {
        app('session')->forgetDrivers();
        app()->forgetInstance('session.store');
        app()->forgetInstance('auth.driver');
        app()->forgetScopedInstances();
        app('auth')->forgetGuards();
        config(['auth.defaults.guard' => 'web']);

        $headers += ['X-ITSO-Realm' => $this->realm, 'Accept' => 'application/json'];
        $xsrf = $this->jar[Realm::xsrfCookie($this->realm)] ?? null;
        if ($this->sendXsrf && is_string($xsrf) && ! isset($headers['X-XSRF-TOKEN'])) {
            $headers['X-XSRF-TOKEN'] = $xsrf;
        }
        $server = ['REMOTE_ADDR' => $this->ip, 'CONTENT_TYPE' => 'application/json'];
        foreach ($headers as $k => $v) {
            $server['HTTP_'.strtoupper(str_replace('-', '_', $k))] = $v;
        }
        $content = $method === 'GET' ? null : json_encode($data, JSON_THROW_ON_ERROR);
        if ($raw !== null) {
            $server['CONTENT_TYPE'] = 'application/octet-stream';
            $server['CONTENT_LENGTH'] = (string) strlen($raw);
            $content = $raw;
        }
        $res = $this->t->call($method, $uri, [], $this->jar, [], $server, $content);
        foreach ($res->headers->getCookies() as $c) {
            if ($c->isCleared() || $c->getValue() === null || $c->getValue() === '') {
                unset($this->jar[$c->getName()]);
            } else {
                $this->jar[$c->getName()] = $c->getValue();
            }
        }

        return $res;
    }

    /** @param  array<string, mixed>  $data */
    public function get(string $uri, array $data = []): TestResponse
    {
        return $this->call('GET', $uri.($data !== [] ? '?'.http_build_query($data) : ''));
    }

    /** @param  array<string, mixed>  $data */
    public function post(string $uri, array $data = []): TestResponse
    {
        return $this->call('POST', $uri, $data);
    }

    public function delete(string $uri): TestResponse
    {
        return $this->call('DELETE', $uri);
    }

    public function login(User|string $user, string $password = 'password-dev-only', bool $remember = false): TestResponse
    {
        $email = $user instanceof User ? $user->email : $user;
        if (! isset($this->jar[Realm::xsrfCookie($this->realm)])) {
            $this->get('/api/v1/auth/csrf');
        }

        return $this->post('/api/v1/auth/login', ['email' => $email, 'password' => $password, 'remember' => $remember]);
    }
}
