<?php

use App\Auth\Totp;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use Database\Seeders\DemoSeeder;
use Tests\Support\FakeAgent;

it('DemoSeeder: người dùng mẫu đăng nhập được (SA có MFA dev), gói + account đồng bộ xuống agent; chạy lại không nhân đôi', function () {
    $agent = new FakeAgent(['*' => fn () => ['ok' => true]]);
    $this->seed(DemoSeeder::class);
    $this->seed(DemoSeeder::class);
    expect(HostingPackage::query()->pluck('code')->sort()->values()->all())->toBe(['basic', 'business', 'pro'])
        ->and(HostingAccount::query()->pluck('lifecycle_state', 'username')->all())
        ->toMatchArray(['anphat' => 'active', 'mktitso' => 'active', 'lehoa' => 'suspended', 'oldshop' => 'terminated'])
        ->and(HostingAccount::query()->pluck('status', 'username')->all())
        ->toMatchArray(['anphat' => 'ready', 'lehoa' => 'suspended', 'oldshop' => 'suspended'])
        ->and(count(array_filter($agent->ops(), fn ($o) => $o === 'account.ensure')))->toBe(4);

    $admin = $this->spa('admin');
    $admin->login('superadmin@itso.local', DemoSeeder::PASSWORD)->assertOk()->assertJsonPath('data.mfa_required', true);
    $admin->post('/api/v1/auth/mfa/verify', ['code' => Totp::at(DemoSeeder::SA_TOTP_SECRET, now()->getTimestamp()), 'method' => 'totp'])
        ->assertOk();
    expect($admin->get('/api/v1/admin/hosting-accounts')->json('data'))->toHaveCount(4);

    $minh = $this->spa('admin');
    $minh->login('minh.tran@itso.local', DemoSeeder::PASSWORD)->assertOk()->assertJsonPath('data.mfa_required', false);
    expect($minh->get('/api/v1/admin/hosting-accounts')->json('data'))->toHaveCount(4);
    $lan = $this->spa('admin');
    $lan->login('lan.pham@itso.local', DemoSeeder::PASSWORD)->assertOk();
    expect($lan->get('/api/v1/admin/hosting-accounts')->json('data'))->toHaveCount(0);

    $portal = $this->spa('portal');
    $portal->login('it@anphat.vn', DemoSeeder::PASSWORD)->assertOk();
    expect(collect($portal->get('/api/v1/portal/hosting-accounts')->json('data'))->pluck('username')->sort()->values()->all())
        ->toBe(['anphat', 'oldshop']);
    // Sai realm: tài khoản portal không đăng nhập được Admin.
    expect($this->spa('admin')->login('it@anphat.vn', DemoSeeder::PASSWORD)->status())->toBe(422);
});
