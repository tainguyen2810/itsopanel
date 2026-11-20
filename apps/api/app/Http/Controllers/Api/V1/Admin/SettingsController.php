<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Domain\Audit\AuditLogger;
use App\Exceptions\ApiProblem;
use App\Models\Setting;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** /admin/settings/{group}: chỉ SUPER_ADMIN (quyền settings.*); không trả giá trị bí mật. */
final class SettingsController
{
    public function __construct(private readonly AuditLogger $audit) {}

    public function show(string $group): JsonResponse
    {
        $def = $this->definition($group);
        [$values, $etag] = $this->values($group, $def);

        return response()->json(['data' => ['group' => $group, 'values' => $values]])->header('ETag', $etag);
    }

    public function update(Request $request, string $group): JsonResponse
    {
        $def = $this->definition($group);
        [, $etag] = $this->values($group, $def);
        $ifMatch = $request->header('If-Match');
        if (is_string($ifMatch) && $ifMatch !== '' && $ifMatch !== $etag) {
            throw new ApiProblem(412, 'precondition_failed', 'Phiên bản đã thay đổi', 'Tải lại cài đặt rồi sửa lại.');
        }
        $input = $request->json()->all();
        $unknown = array_diff(array_keys($input), array_keys($def));
        if ($unknown !== []) {
            throw ApiProblem::field((string) reset($unknown), 'Không có cài đặt này trong nhóm '.$group.'.');
        }
        $rules = [];
        foreach ($input as $k => $_) {
            $rules[$k] = array_merge(['present'], $def[$k]['rules']);
        }
        $data = Validator::make($input, $rules)->validate();
        /** @var User $actor */
        $actor = $request->user();
        $changes = [];
        DB::transaction(function () use ($data, $def, $group, $actor, &$changes): void {
            foreach ($data as $k => $v) {
                $secret = ($def[$k]['secret'] ?? false) === true;
                $row = Setting::query()->firstOrNew(['group_key' => $group, 'key' => $k]);
                $old = $row->exists ? $row->value : null;
                $row->is_encrypted = $secret;
                $row->value = $secret ? ($v === null ? null : ['enc' => Crypt::encryptString((string) $v)]) : ['v' => $v];
                $row->updated_by_user_id = $actor->id;
                $row->updated_at = Carbon::now();
                $row->save();
                $changes[$k] = $secret ? '[REDACTED]' : ['from' => is_array($old) ? ($old['v'] ?? null) : null, 'to' => $v];
            }
        });
        $this->audit->record("settings.$group.update", null, $changes);
        [$values, $newEtag] = $this->values($group, $def);

        return response()->json(['data' => ['group' => $group, 'values' => $values]])->header('ETag', $newEtag);
    }

    /** Giá trị đã lưu (chưa giải mã) của một khóa — dùng nội bộ (vd. gửi mail SMTP). */
    public static function secret(string $group, string $key): ?string
    {
        $row = Setting::query()->where('group_key', $group)->where('key', $key)->first();
        $enc = $row !== null && is_array($row->value) ? ($row->value['enc'] ?? null) : null;

        return is_string($enc) ? Crypt::decryptString($enc) : null;
    }

    /** @return array<string, array{default: mixed, rules: list<string>, secret?: bool}> */
    private function definition(string $group): array
    {
        $all = (array) config('itso_settings');
        if (! isset($all[$group]) || ! is_array($all[$group])) {
            throw new NotFoundHttpException;
        }

        return $all[$group];
    }

    /**
     * @param  array<string, array{default: mixed, rules: list<string>, secret?: bool}>  $def
     * @return array{0: array<string, mixed>, 1: string}
     */
    private function values(string $group, array $def): array
    {
        $rows = Setting::query()->where('group_key', $group)->get()->keyBy('key');
        $out = [];
        $stamp = '';
        foreach ($def as $k => $d) {
            $row = $rows->get($k);
            $stamp .= $k.'='.($row?->updated_at?->format('U.u') ?? '-').';';
            if (($d['secret'] ?? false) === true) {
                $out[$k.'_set'] = $row !== null && is_array($row->value) && isset($row->value['enc']);

                continue;
            }
            $out[$k] = $row !== null && is_array($row->value) && array_key_exists('v', $row->value) ? $row->value['v'] : $d['default'];
        }

        return [$out, '"'.sha1($group.'|'.$stamp).'"'];
    }
}
