<?php

declare(strict_types=1);

namespace Itso\PHPStan;

use PhpParser\Node;
use PHPStan\Analyser\Scope;
use PHPStan\Rules\IdentifierRuleError;
use PHPStan\Rules\Rule;
use PHPStan\Rules\RuleErrorBuilder;

/**
 * CLAUDE.md §2: Laravel không bao giờ chạy lệnh hệ thống. Mọi thao tác Linux đi qua Go Agent.
 * Cấm: exec, shell_exec, system, passthru, proc_open, popen, pcntl_exec, toán tử backtick,
 * và lớp chạy tiến trình (Symfony Process, Laravel Process facade/Factory).
 *
 * @implements Rule<Node>
 */
final class NoSystemCommandRule implements Rule
{
    public const FUNCTIONS = ['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen', 'pcntl_exec'];

    public const CLASSES = [
        'symfony\\component\\process\\process',
        'symfony\\component\\process\\phpprocess',
        'illuminate\\support\\facades\\process',
        'illuminate\\process\\factory',
        'illuminate\\process\\pendingprocess',
    ];

    public function getNodeType(): string
    {
        return Node::class;
    }

    public function processNode(Node $node, Scope $scope): array
    {
        if ($node instanceof Node\Expr\ShellExec) {
            return [self::error('Toán tử backtick (shell exec) bị cấm trong apps/api/app.')];
        }
        if ($node instanceof Node\Expr\FuncCall && $node->name instanceof Node\Name) {
            $name = strtolower($node->name->getLast());
            if (in_array($name, self::FUNCTIONS, true)) {
                return [self::error(sprintf('Hàm %s() bị cấm: Laravel không chạy lệnh hệ thống, dùng AgentClient.', $name))];
            }
        }
        if ($node instanceof Node\Expr\FuncCall && ! $node->name instanceof Node\Name) {
            // Gọi hàm động ($fn(...), 'exec'(...)) có thể né danh sách trên.
            if ($node->name instanceof Node\Scalar\String_ && in_array(strtolower($node->name->value), self::FUNCTIONS, true)) {
                return [self::error('Gọi động hàm chạy lệnh hệ thống bị cấm.')];
            }
        }
        if (($node instanceof Node\Expr\New_ || $node instanceof Node\Expr\StaticCall) && $node->class instanceof Node\Name) {
            $class = strtolower(ltrim($scope->resolveName($node->class), '\\'));
            if (in_array($class, self::CLASSES, true)) {
                return [self::error(sprintf('Lớp %s chạy tiến trình hệ thống, bị cấm trong apps/api/app.', $node->class->toString()))];
            }
        }
        if ($node instanceof Node\Stmt\UseUse) {
            $class = strtolower($node->name->toString());
            if (in_array($class, self::CLASSES, true)) {
                return [self::error(sprintf('Import %s bị cấm trong apps/api/app.', $node->name->toString()))];
            }
        }

        return [];
    }

    private static function error(string $message): IdentifierRuleError
    {
        return RuleErrorBuilder::message($message)->identifier('itso.noSystemCommand')->build();
    }
}
