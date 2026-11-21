<?php

declare(strict_types=1);

namespace App\Domain\Data;

use App\Domain\Hosting\QuotaService;
use App\Exceptions\ApiProblem;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\SftpAccount;
use App\Models\SshKey;
use App\Models\User;
use Illuminate\Support\Facades\Crypt;

/**
 * Truy cập file từ xa (Prompt 6.3, D-73): SFTP = user Linux chính của account (một bản ghi, chroot home); FTPS phụ =
 * virtual user Pure-FTPd giới hạn thư mục con (đếm vào ftp_limit); SSH key do panel quản lý (trùng fingerprint → 409).
 */
final class AccessService
{
    public const KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'];

    public function __construct(private readonly DataJobs $jobs, private readonly QuotaService $quota) {}

    /**
     * @param  array<string, mixed>  $in  SftpAccountCreate
     * @return array{0: SftpAccount, 1: Job, 2: string|null}
     */
    public function create(User $actor, HostingAccount $a, array $in): array
    {
        $protocol = (string) $in['protocol'];
        if (($in['read_only'] ?? false) === true) {
            throw ApiProblem::field('read_only', 'Phase 6 chưa hỗ trợ tài khoản chỉ đọc (Pure-FTPd không giới hạn theo user).');
        }
        $given = $in['password'] ?? null;
        $secret = $given === null ? DataSpec::password() : DataSpec::checkPassword($given);
        if ($protocol === 'sftp') {
            if (($in['username'] ?? null) !== $a->username) {
                throw ApiProblem::field('username', "SFTP dùng user Linux chính của account: username phải là {$a->username}.");
            }
            if (($in['root_path'] ?? '.') !== '.') {
                throw ApiProblem::field('root_path', 'SFTP chroot vào home của account: root_path phải là ".".');
            }
            $name = $a->username;
            $root = '';
        } else {
            $name = DataSpec::prefixed($a, $in['username'] ?? null, 'username', 48);
            $root = DataSpec::relPath($in['root_path'] ?? null, 'root_path');
            $root = $root === '.' ? '' : $root;
        }
        [$s, $job] = $this->jobs->run($actor, $a, 'sftp_account.create', function (HostingAccount $acc) use ($protocol, $name, $root, $secret): array {
            if ($protocol === 'ftps') {
                $this->quota->ensureCanAdd($acc, 'ftp_accounts');
            } elseif (SftpAccount::query()->where('hosting_account_id', $acc->id)->where('protocol', 'sftp')->exists()) {
                throw new ApiProblem(409, 'conflict', 'Đã có tài khoản SFTP', 'Mỗi account có một tài khoản SFTP (user Linux chính).');
            }
            if (SftpAccount::query()->where('username', $name)->exists()) {
                throw new ApiProblem(409, 'conflict', 'Username đã tồn tại', "Đã có tài khoản $name.");
            }
            $s = SftpAccount::query()->create(['hosting_account_id' => $acc->id, 'username' => $name, 'root_subpath' => $root,
                'protocol' => $protocol, 'password_encrypted' => Crypt::encryptString($secret), 'status' => 'provisioning']);
            $spec = DataJobs::spec('sftp_account.create', $s, $acc);
            if ($protocol === 'sftp') {
                $spec->step('sshd.match.apply', ['password_authentication' => true])
                    ->step('sftp.user.ensure', DataSpec::sftpUser($s, $acc, (bool) ($this->quota->limits($acc)['ssh_allowed'] ?? false), true));
            } else {
                $spec->step('ftp.user.ensure', DataSpec::ftpUser($s, $acc));
            }

            return [$s, $spec, ['protocol' => $protocol, 'username' => $name, 'root_path' => $root === '' ? '.' : $root]];
        });

        /** @var SftpAccount $s */
        return [$s, $job, $given === null ? $secret : null];
    }

    public function delete(User $actor, SftpAccount $s): Job
    {
        DataJobs::ensureIdle($s);
        [, $job] = $this->jobs->run($actor, $s->account, 'sftp_account.delete', function (HostingAccount $acc) use ($s): array {
            $s->status = 'deleting';
            $s->save();
            $spec = DataJobs::spec('sftp_account.delete', $s, $acc);
            $spec->step($s->protocol === 'sftp' ? 'sftp.user.remove' : 'ftp.user.remove', $s->protocol === 'sftp'
                ? ['account' => DataSpec::acct($acc)] : ['account' => DataSpec::acct($acc), 'username' => $s->username]);

            return [$s, $spec, ['username' => $s->username]];
        }, false);

        return $job;
    }

    /** @return array{0: Job, 1: string} */
    public function rotatePassword(User $actor, SftpAccount $s): array
    {
        if (! in_array($s->status, ['ready', 'degraded'], true)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Tài khoản chưa sẵn sàng', "Trạng thái hiện tại: {$s->status}.");
        }
        DataJobs::ensureIdle($s);
        $secret = DataSpec::password();
        [, $job] = $this->jobs->run($actor, $s->account, 'sftp_account.rotate_password', function (HostingAccount $acc) use ($s, $secret): array {
            $s->password_encrypted = Crypt::encryptString($secret);
            $s->spec_version++;
            $s->save();
            $spec = DataJobs::spec('sftp_account.rotate_password', $s, $acc);
            $spec->step($s->protocol === 'sftp' ? 'sftp.user.ensure' : 'ftp.user.ensure', $s->protocol === 'sftp'
                ? DataSpec::sftpUser($s, $acc, (bool) ($this->quota->limits($acc)['ssh_allowed'] ?? false), true)
                : DataSpec::ftpUser($s, $acc));

            return [$s, $spec, ['password' => 'rotated']];
        });

        return [$job, $secret];
    }

    /**
     * Phân tích khóa công khai: `<type> <base64> [comment]`, blob mở đầu bằng đúng type, fingerprint SHA256 như ssh-keygen.
     *
     * @return array{type: string, line: string, fingerprint: string}
     */
    public static function parseKey(string $key): array
    {
        $parts = preg_split('/ +/', trim($key), 3) ?: [];
        $bad = fn (string $why): ApiProblem => ApiProblem::field('public_key', $why);
        if (count($parts) < 2 || ! in_array($parts[0], self::KEY_TYPES, true)) {
            throw $bad('Chỉ nhận khóa ssh-ed25519, ecdsa-sha2-nistp256 hoặc ssh-rsa dạng "<loại> <base64> [ghi chú]".');
        }
        $blob = base64_decode($parts[1], true);
        if ($blob === false || strlen($blob) < 4) {
            throw $bad('Phần base64 của khóa không hợp lệ.');
        }
        $n = unpack('N', substr($blob, 0, 4))[1] ?? 0;
        if ($n !== strlen($parts[0]) || substr($blob, 4, $n) !== $parts[0]) {
            throw $bad("Nội dung khóa không khớp loại {$parts[0]}.");
        }
        if ($parts[0] === 'ssh-rsa' && strlen($blob) < 256) {
            throw $bad('Khóa RSA quá ngắn (tối thiểu 2048 bit).');
        }
        $line = $parts[0].' '.$parts[1];
        if (isset($parts[2]) && $parts[2] !== '') {
            if (preg_match('#^[A-Za-z0-9 ._@:+=/-]{0,100}$#', $parts[2]) !== 1) {
                throw $bad('Ghi chú của khóa có ký tự không cho phép.');
            }
            $line .= ' '.$parts[2];
        }

        return ['type' => $parts[0], 'line' => $line,
            'fingerprint' => 'SHA256:'.rtrim(base64_encode(hash('sha256', $blob, true)), '=')];
    }

    /** @return array{0: SshKey, 1: Job} */
    public function addKey(User $actor, HostingAccount $a, string $name, string $publicKey): array
    {
        $k = self::parseKey($publicKey);
        [$key, $job] = $this->jobs->run($actor, $a, 'ssh_key.create', function (HostingAccount $acc) use ($name, $k): array {
            if (SshKey::query()->where('hosting_account_id', $acc->id)->where('fingerprint', $k['fingerprint'])->exists()) {
                throw new ApiProblem(409, 'conflict', 'Khóa SSH đã tồn tại', "Account đã có khóa {$k['fingerprint']}.");
            }
            if (SshKey::query()->where('hosting_account_id', $acc->id)->count() >= 50) {
                throw QuotaService::exceeded('ssh_keys', 'Tối đa 50 khóa SSH mỗi account.');
            }
            $key = SshKey::query()->create(['hosting_account_id' => $acc->id, 'name' => $name, 'type' => $k['type'],
                'public_key' => $k['line'], 'fingerprint' => $k['fingerprint']]);
            $spec = DataJobs::spec('ssh_key.create', $key, $acc)
                ->step('ssh.keys.apply', ['account' => DataSpec::acct($acc), 'keys' => DataSpec::sshKeys($acc)]);

            return [$key, $spec, ['name' => $name, 'fingerprint' => $k['fingerprint']]];
        });

        /** @var SshKey $key */
        return [$key, $job];
    }

    public function deleteKey(User $actor, SshKey $key): Job
    {
        [, $job] = $this->jobs->run($actor, $key->account, 'ssh_key.delete', function (HostingAccount $acc) use ($key): array {
            $key->delete();
            $spec = DataJobs::spec('ssh_key.delete', $acc, $acc)
                ->step('ssh.keys.apply', ['account' => DataSpec::acct($acc), 'keys' => DataSpec::sshKeys($acc)]);

            return [$acc, $spec, ['ssh_key' => ['name' => $key->name, 'fingerprint' => $key->fingerprint]]];
        }, false);

        return $job;
    }
}
