<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\WordPress\WordPressService;
use App\Models\WordPressSite;
use Illuminate\Console\Command;

/**
 * WordPress Toolkit (D-99): `--refresh` làm mới cache wp.info (bản mới) của mọi site; mặc định tạo job tự cập nhật cho
 * site đang trong cửa sổ giờ. Lịch: refresh hằng ngày, tự cập nhật mỗi giờ.
 */
final class WordPressAutoUpdateCommand extends Command
{
    protected $signature = 'itso:wordpress-auto-update {--refresh : chỉ làm mới thông tin phiên bản từ agent}';

    protected $description = 'Tự cập nhật WordPress theo chính sách và cửa sổ giờ';

    public function handle(WordPressService $wp): int
    {
        if ($this->option('refresh') === true) {
            $n = 0;
            foreach (WordPressSite::query()->where('state', 'ok')->with(['website', 'account'])->orderBy('id')->cursor() as $site) {
                if (! $site->website->trashed()) {
                    $wp->refresh($site, true);
                    $n++;
                }
            }
            $this->info("Đã làm mới $n site");

            return self::SUCCESS;
        }
        $this->info('Tạo '.$wp->autoUpdate().' job tự cập nhật');

        return self::SUCCESS;
    }
}
