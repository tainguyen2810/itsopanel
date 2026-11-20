<?php

use App\Auth\Totp;

// RFC 6238 Phụ lục B: khóa ASCII "12345678901234567890" (SHA-1), 8 chữ số.
dataset('rfc6238', [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
]);

it('khớp test vector RFC 6238 (SHA-1)', function (int $time, string $expected) {
    $key = '12345678901234567890';
    expect(Totp::hotp($key, Totp::timestep($time), 8))->toBe($expected);
})->with('rfc6238');

it('khớp test vector RFC 4226 (HOTP 6 chữ số)', function () {
    $key = '12345678901234567890';
    $expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    foreach ($expected as $counter => $code) {
        expect(Totp::hotp($key, $counter))->toBe($code);
    }
});

it('base32 hai chiều và tương thích secret chuẩn', function () {
    expect(Totp::base32Encode('12345678901234567890'))->toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
        ->and(Totp::base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'))->toBe('12345678901234567890');
    $s = Totp::generateSecret();
    expect($s)->toMatch('/^[A-Z2-7]{32}$/')->and(Totp::base32Encode(Totp::base32Decode($s)))->toBe($s);
});

it('match chấp nhận lệch ±1 bước, từ chối ngoài cửa sổ và mã sai định dạng', function () {
    $secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    $t = 1_700_000_000;
    $code = Totp::at($secret, $t);
    expect(Totp::match($secret, $code, $t))->toBe(Totp::timestep($t))
        ->and(Totp::match($secret, $code, $t + 30))->toBe(Totp::timestep($t))
        ->and(Totp::match($secret, $code, $t - 30))->toBe(Totp::timestep($t))
        ->and(Totp::match($secret, $code, $t + 90))->toBeNull()
        ->and(Totp::match($secret, 'abcdef', $t))->toBeNull();
});

it('otpauth URI có issuer, secret và tham số chuẩn', function () {
    expect(Totp::uri('ITSO', 'it@anphat.vn', 'JBSWY3DPEHPK3PXP'))
        ->toBe('otpauth://totp/ITSO:it%40anphat.vn?secret=JBSWY3DPEHPK3PXP&issuer=ITSO&algorithm=SHA1&digits=6&period=30');
});
