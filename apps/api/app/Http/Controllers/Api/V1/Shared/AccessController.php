<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Domain\Data\AccessService;
use App\Http\Presenters\DataPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\SftpAccount;
use App\Models\SshKey;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** /admin|portal/sftp-accounts/* và /ssh-keys/* (Prompt 6.3, D-72/D-73). */
final class AccessController extends DataController
{
    public function __construct(Access $access, JobPresenter $jobs, private readonly AccessService $service)
    {
        parent::__construct($access, $jobs);
    }

    public function index(Request $request): JsonResponse
    {
        $q = $this->scoped($request, SftpAccount::class);
        Listing::search($request, $q, ['sftp_accounts.username']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'sftp_accounts.created_at',
            'username' => 'sftp_accounts.username', 'status' => 'sftp_accounts.status'], '-created_at',
            fn (SftpAccount $s): array => DataPresenter::sftp($s)));
    }

    public function store(Request $request): JsonResponse
    {
        self::only($request, ['hosting_account_uuid', 'username', 'protocol', 'root_path', 'password', 'read_only']);
        $in = $request->validate(['hosting_account_uuid' => ['required', 'uuid'], 'username' => ['required', 'string', 'max:64'],
            'protocol' => ['required', 'in:sftp,ftps'], 'root_path' => ['required', 'string', 'max:1024'],
            'password' => ['sometimes', 'nullable', 'string', 'max:128'], 'read_only' => ['sometimes', 'boolean']]);
        [, $job, $secret] = $this->service->create($this->actor($request), $this->account($request, $in['hosting_account_uuid']), $in);

        return $this->accepted($request, $job, $secret);
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->delete($this->actor($request), $this->find($request, SftpAccount::class, $id)));
    }

    public function rotatePassword(Request $request, string $id): JsonResponse
    {
        [$job, $secret] = $this->service->rotatePassword($this->actor($request), $this->find($request, SftpAccount::class, $id));

        return $this->accepted($request, $job, $secret);
    }

    public function keys(Request $request): JsonResponse
    {
        $q = $this->scoped($request, SshKey::class);
        Listing::search($request, $q, ['ssh_keys.name', 'ssh_keys.fingerprint']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'ssh_keys.created_at', 'name' => 'ssh_keys.name'],
            '-created_at', fn (SshKey $k): array => DataPresenter::sshKey($k)));
    }

    public function storeKey(Request $request): JsonResponse
    {
        self::only($request, ['hosting_account_uuid', 'name', 'public_key']);
        $in = $request->validate(['hosting_account_uuid' => ['required', 'uuid'], 'name' => ['required', 'string', 'max:80'],
            'public_key' => ['required', 'string', 'max:16384']]);
        [, $job] = $this->service->addKey($this->actor($request), $this->account($request, $in['hosting_account_uuid']),
            (string) $in['name'], (string) $in['public_key']);

        return $this->accepted($request, $job);
    }

    public function destroyKey(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->deleteKey($this->actor($request), $this->find($request, SshKey::class, $id)));
    }
}
