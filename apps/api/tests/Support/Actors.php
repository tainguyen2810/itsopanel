<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Auth\Totp;
use App\Models\HostingAccount;
use App\Models\Server;
use App\Models\User;
use App\Models\UserScope;
use Tests\TestCase;

/**
 * Nhân vật cho ma trận quyền: SA, ADMIN trong phạm vi, ADMIN ngoài phạm vi, USER chủ, USER khác.
 * Nhân vật realm admin đăng nhập, bật TOTP và step-up sẵn (để chỉ còn kiểm quyền + phạm vi).
 */
final class Actors
{
    public Server $server;

    public HostingAccount $account;

    public User $owner;

    public User $otherUser;

    public User $sa;

    public User $adminIn;

    public User $adminOut;

    /** @var array<string, string> secret TOTP theo nhân vật (đã bật) */
    public array $secrets = [];

    public function __construct(private readonly TestCase $t)
    {
        $this->server = Server::factory()->create();
        $this->owner = User::factory()->portalUser()->create(['name' => 'Chu Tai Khoan']);
        $this->account = HostingAccount::factory()->create(['server_id' => $this->server->id, 'owner_user_id' => $this->owner->id]);
        $this->otherUser = User::factory()->portalUser()->create(['name' => 'Nguoi Khac']);
        HostingAccount::factory()->create(['owner_user_id' => $this->otherUser->id]); // server khác
        $this->sa = User::factory()->superAdmin()->create();
        $this->adminIn = User::factory()->admin()->create();
        UserScope::query()->create(['user_id' => $this->adminIn->id, 'scope_type' => 'server', 'scope_id' => $this->server->id]);
        $this->adminOut = User::factory()->admin()->create();
    }

    public function user(string $persona): User
    {
        return match ($persona) {
            'SA' => $this->sa,
            'AD_IN' => $this->adminIn,
            'AD_OUT' => $this->adminOut,
            'US_OWNER' => $this->owner,
            'US_OTHER' => $this->otherUser,
        };
    }

    /** Phiên của nhân vật: admin realm đã bật TOTP + step-up; USER đăng nhập realm portal. */
    public function spa(string $persona): Spa
    {
        $u = $this->user($persona);
        if ($u->realm === 'portal') {
            $spa = $this->t->spa('portal');
            $spa->login($u)->assertOk();

            return $spa;
        }
        $spa = $this->t->spa('admin');
        $spa->login($u)->assertOk();
        if (! isset($this->secrets[$persona])) {
            $this->secrets[$persona] = self::enrollAndStepUp($this->t, $spa);

            return $spa;
        }
        $this->t->travel(31)->seconds();
        $spa->post('/api/v1/auth/mfa/verify', ['code' => Totp::at($this->secrets[$persona], now()->getTimestamp()), 'method' => 'totp'])->assertOk();
        $this->t->travel(31)->seconds();
        $spa->post('/api/v1/auth/step-up', ['code' => Totp::at($this->secrets[$persona], now()->getTimestamp()), 'method' => 'totp'])->assertOk();

        return $spa;
    }

    /** Bật TOTP cho phiên đang đăng nhập rồi step-up; trả secret. */
    public static function enrollAndStepUp(TestCase $t, Spa $spa): string
    {
        $secret = (string) $spa->post('/api/v1/auth/mfa/totp:enroll')->json('data.secret');
        $spa->post('/api/v1/auth/mfa/totp:confirm', ['code' => Totp::at($secret, now()->getTimestamp()), 'method' => 'totp'])
            ->assertNoContent();
        $t->travel(31)->seconds();
        $spa->post('/api/v1/auth/step-up', ['code' => Totp::at($secret, now()->getTimestamp()), 'method' => 'totp'])->assertOk();

        return $secret;
    }
}
