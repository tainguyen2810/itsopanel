<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Domain\Data\FileService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\DataPresenter;
use App\Http\Presenters\JobPresenter;
use App\Models\UploadSession;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\HeaderUtils;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * File Manager /admin|portal/hosting-accounts/{id}/files/* (Prompt 6.3, D-75): đọc/sửa đồng bộ qua agent (dưới UID account),
 * thao tác dài qua job file.operate, upload kiểu tus theo chunk 8 MiB, tải xuống bằng link ký HMAC 5 phút.
 */
final class FileController extends DataController
{
    public function __construct(Access $access, JobPresenter $jobs, private readonly FileService $files)
    {
        parent::__construct($access, $jobs);
    }

    public function index(Request $request, string $id): JsonResponse
    {
        $a = $this->pathAccount($request, $id);
        $limit = $request->query('limit', '200');
        if (! is_string($limit) || ! ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 1000) {
            throw ApiProblem::field('limit', 'limit phải là số nguyên 1–1000.');
        }
        $sort = $request->query('sort', 'name');
        if (! is_string($sort) || ! in_array(ltrim($sort, '-'), ['name', 'size', 'modified_at'], true)) {
            throw ApiProblem::field('sort', 'sort chỉ nhận name, size, modified_at.');
        }
        $cursor = $request->query('cursor');
        $offset = 0;
        if ($cursor !== null) {
            $dec = is_string($cursor) ? base64_decode($cursor, true) : false;
            if ($dec === false || ! ctype_digit($dec)) {
                throw ApiProblem::field('cursor', 'cursor không hợp lệ.');
            }
            $offset = (int) $dec;
        }
        $entries = $this->files->list($this->actor($request), $a, self::path($request, '.'));
        $q = $request->query('q');
        if (is_string($q) && trim($q) !== '') {
            $entries = array_values(array_filter($entries, fn (array $e): bool => mb_stripos((string) $e['name'], trim($q)) !== false));
        }
        $key = ltrim($sort, '-');
        $desc = str_starts_with($sort, '-');
        usort($entries, function (array $x, array $y) use ($key, $desc): int {
            $dirs = ($y['type'] === 'dir') <=> ($x['type'] === 'dir');
            if ($dirs !== 0) {
                return $dirs;
            }
            $c = $key === 'name' ? strnatcasecmp((string) $x['name'], (string) $y['name']) : $x[$key] <=> $y[$key];

            return $desc ? -$c : $c;
        });
        $page = array_slice($entries, $offset, (int) $limit);
        $next = $offset + (int) $limit < count($entries) ? base64_encode((string) ($offset + (int) $limit)) : null;

        return response()->json(['data' => $page, 'meta' => ['next_cursor' => $next, 'limit' => (int) $limit]]);
    }

    public function content(Request $request, string $id): JsonResponse
    {
        $a = $this->pathAccount($request, $id);
        $c = $this->files->read($this->actor($request), $a, self::path($request));

        return response()->json(['data' => $c])->header('ETag', (string) $c['etag'])->header('Cache-Control', 'no-store');
    }

    public function write(Request $request, string $id): JsonResponse
    {
        $a = $this->pathAccount($request, $id);
        self::only($request, ['path', 'content', 'encoding', 'if_etag']);
        $in = $request->validate(['path' => ['required', 'string', 'max:1024'], 'content' => ['present', 'string', 'max:2097152'],
            'encoding' => ['sometimes', 'in:utf-8,base64'], 'if_etag' => ['sometimes', 'nullable', 'string', 'max:100']]);
        $in['content'] = (string) ($in['content'] ?? '');

        return response()->json(['data' => $this->files->write($this->actor($request), $a, $in)]);
    }

    public function operate(Request $request, string $id): JsonResponse
    {
        $a = $this->pathAccount($request, $id);
        self::only($request, ['op', 'paths', 'target', 'mode', 'format']);
        $in = $request->validate(['op' => ['required', 'in:mkdir,rename,move,copy,delete,chmod,compress,extract'],
            'paths' => ['required', 'array', 'min:1', 'max:500'], 'paths.*' => ['string', 'max:1024'],
            'target' => ['sometimes', 'nullable', 'string', 'max:1024'], 'mode' => ['sometimes', 'nullable', 'string', 'regex:/^0[0-7]{3}$/'],
            'format' => ['sometimes', 'nullable', 'in:zip,tar.gz']]);

        return $this->accepted($request, $this->files->operate($this->actor($request), $a, $in));
    }

    public function download(Request $request, string $id): JsonResponse
    {
        $a = $this->pathAccount($request, $id);

        return response()->json(['data' => $this->files->downloadLink($this->actor($request), $a, self::path($request), $this->realm($request))])
            ->header('Cache-Control', 'no-store');
    }

    public function raw(Request $request, string $id): StreamedResponse
    {
        $a = $this->pathAccount($request, $id);
        $actor = $this->actor($request);
        $path = self::path($request);
        [$size, $name] = $this->files->verifyDownload($actor, $a, $path, $request->query('expires'), $request->query('signature'));
        $files = $this->files;
        $fallback = preg_replace('/[^A-Za-z0-9._-]/', '_', $name) ?: 'download';

        return new StreamedResponse(function () use ($files, $actor, $a, $path, $size): void {
            for ($off = 0; $off < $size;) {
                $chunk = $files->chunkAt($actor, $a, $path, $off);
                if ($chunk === '') {
                    break;
                }
                echo $chunk;
                flush();
                $off += strlen($chunk);
            }
        }, 200, ['Content-Type' => 'application/octet-stream', 'Content-Length' => (string) $size, 'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
            'Content-Disposition' => HeaderUtils::makeDisposition(HeaderUtils::DISPOSITION_ATTACHMENT, $name, $fallback)]);
    }

    public function createUpload(Request $request, string $id): JsonResponse
    {
        $a = $this->pathAccount($request, $id);
        self::only($request, ['path', 'size', 'overwrite']);
        $in = $request->validate(['path' => ['required', 'string', 'max:1024'], 'size' => ['required', 'integer', 'min:1', 'max:10737418240'],
            'overwrite' => ['sometimes', 'boolean']]);
        $u = $this->files->createUpload($this->actor($request), $a, (string) $in['path'], (int) $in['size'], (bool) ($in['overwrite'] ?? false));

        return response()->json(['data' => DataPresenter::upload($u)], 201);
    }

    public function chunk(Request $request, string $id, string $upload): JsonResponse
    {
        $u = $this->upload($request, $id, $upload);
        $len = $request->header('Content-Length');
        if (! is_string($len) || ! ctype_digit($len)) {
            throw ApiProblem::field('Content-Length', 'Cần Content-Length.');
        }
        $u = $this->files->chunk($this->actor($request), $u, (string) $request->header('Content-Range', ''), $request->getContent(true), (int) $len);

        return response()->json(['data' => DataPresenter::upload($u)]);
    }

    public function showUpload(Request $request, string $id, string $upload): JsonResponse
    {
        return response()->json(['data' => DataPresenter::upload($this->upload($request, $id, $upload))]);
    }

    public function cancelUpload(Request $request, string $id, string $upload): Response
    {
        $this->files->cancelUpload($this->upload($request, $id, $upload));

        return response()->noContent();
    }

    /** Phiên upload thuộc đúng account trên đường dẫn và của chính người dùng; khác → 404. */
    private function upload(Request $request, string $id, string $upload): UploadSession
    {
        $a = $this->pathAccount($request, $id);
        $u = Str::isUuid($upload) ? UploadSession::query()->where('uuid', $upload)->where('hosting_account_id', $a->id)
            ->where('user_id', $this->actor($request)->id)->first() : null;
        if (! $u instanceof UploadSession) {
            throw new NotFoundHttpException;
        }

        return $u;
    }

    private static function path(Request $request, ?string $default = null): string
    {
        $p = $request->query('path', $default);
        if (! is_string($p) || $p === '' || strlen($p) > 1024) {
            throw ApiProblem::field('path', 'Cần tham số path (đường dẫn tương đối trong home).');
        }

        return $p;
    }
}
