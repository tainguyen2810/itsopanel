<?php

use Illuminate\Support\Facades\Route;

// API-only. Giao diện do apps/web phục vụ (/admin, /portal).
Route::get('/', fn () => response('ITSO Panel API — xem /api/v1/system/health', 200, ['Content-Type' => 'text/plain; charset=UTF-8']));
