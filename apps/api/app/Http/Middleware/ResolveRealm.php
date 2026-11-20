<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\Realm;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Session\SessionManager;
use Symfony\Component\HttpFoundation\Response;

/**
 * Xác định realm và đặt tên cookie phiên theo realm (itso_admin_session / itso_portal_session) trước StartSession.
 */
final class ResolveRealm
{
    public function __construct(private readonly SessionManager $sessions) {}

    public function handle(Request $request, Closure $next): Response
    {
        $realm = Realm::resolve($request);
        $request->attributes->set(Realm::ATTRIBUTE, $realm);
        config(['session.cookie' => Realm::cookie($realm)]);
        $this->sessions->driver()->setName(Realm::cookie($realm));

        return $next($request);
    }
}
