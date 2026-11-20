<?php

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

// D-59: Feature test chạy trên PostgreSQL 16, mỗi test trong transaction (RefreshDatabase).
pest()->extend(TestCase::class)->use(RefreshDatabase::class)->in('Feature');
