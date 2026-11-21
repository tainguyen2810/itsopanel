import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File, FileText, Folder, FolderOpen, FolderPlus, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/http';
import { useFmt } from '@/shared/format/useFmt';
import {
  baseName,
  crumbs,
  isInside,
  isTextFile,
  isValidName,
  joinPath,
  MODE_RE,
  modeString,
  normalizePath,
  parentPath,
} from '@/shared/hosting/paths';
import { FormDialog } from '@/shared/page/FormDialog';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { useUrlState } from '@/shared/page/useUrlState';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Card, CardContent } from '@/ui/Card';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { EmptyState } from '@/ui/Feedback';
import { Input, Textarea } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { get, list, send, type Row } from '@/shared/api/realm';
import { errorText, useAction } from '@/shared/api/useAction';
import { DEMO } from '@/shared/demoMode';
import { AccountSelect, RowMenu, useActiveAccounts } from './common';
import { UploadList, useUploads } from './Uploads';

type Entry = Row<'/hosting-accounts/{id}/files'>;
type Op = 'mkdir' | 'move' | 'copy' | 'delete' | 'chmod' | 'compress' | 'extract';

export default function FilesPage() {
  const { t } = useTranslation('admin');
  const [url, setUrl] = useUrlState();
  const { accounts } = useActiveAccounts();
  const acc = accounts.find((a) => a.uuid === url.account);
  const path = url.path ?? '.';
  return (
    <>
      <PageHeader title={t('files.title')} description={t('files.description')} />
      <div className="mb-4">
        <AccountSelect
          id="files-account"
          value={url.account}
          onChange={(v) => setUrl({ account: v, path: undefined })}
        />
      </div>
      {acc ? (
        <Browser
          key={acc.uuid}
          account={acc.uuid}
          home={acc.home_path}
          path={path}
          go={(p) => setUrl({ path: p === '.' ? undefined : p })}
        />
      ) : (
        <Card>
          <CardContent>
            <EmptyState
              icon={FolderOpen}
              title={t('files.pickTitle')}
              description={t('files.pickHint')}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

const filesKey = (account: string, path: string) => ['admin', 'files', account, path];

function useDir(account: string, path: string, enabled = true) {
  return useQuery({
    queryKey: filesKey(account, path),
    queryFn: () =>
      list('/hosting-accounts/{id}/files', undefined, {
        path: { id: account },
        query: { path },
      }),
    enabled,
  });
}

function Browser({
  account,
  home,
  path,
  go,
}: {
  account: string;
  home: string;
  path: string;
  go: (p: string) => void;
}) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const dir = useDir(account, path);
  const [draft, setDraft] = useState<string | null>(null);
  const [pathError, setPathError] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<{ op: Op; paths: string[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const display = path === '.' ? home : `${home}/${path}`;

  const submitPath = (e: FormEvent) => {
    e.preventDefault();
    const p = normalizePath(draft ?? display, home);
    if (p === null) {
      setPathError(true);
      return;
    }
    setPathError(false);
    setDraft(null);
    go(p);
  };

  const download = async (p: string) => {
    try {
      const r = await get('/hosting-accounts/{id}/files/download', {
        path: { id: account },
        query: { path: p },
      });
      // Link ký HMAC 5 phút, gắn với phiên hiện tại: trình duyệt tải trực tiếp (Content-Disposition: attachment).
      if (DEMO) {
        toast.success(t('files.downloadReady', { time: fmt.time(r.expires_at) }), {
          description: r.url,
        });
      } else {
        const a = document.createElement('a');
        a.href = r.url;
        a.rel = 'noopener';
        a.download = baseName(p);
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const uploads = useUploads(account, () => void dir.refetch());
  const onUpload = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) uploads.add(f, joinPath(path, f.name));
  };

  const rows = dir.data ?? [];
  const columns: ColumnDef<Entry, unknown>[] = [
    {
      id: 'name',
      header: t('files.name'),
      accessorKey: 'name',
      cell: ({ row }) => {
        const e = row.original;
        const Icon = e.type === 'dir' ? Folder : isTextFile(e.name) ? FileText : File;
        const open = () =>
          e.type === 'dir'
            ? go(e.path)
            : isTextFile(e.name)
              ? setEditing(e.path)
              : void download(e.path);
        return (
          <button
            type="button"
            onClick={open}
            className="flex min-w-0 items-center gap-2 text-left hover:underline"
          >
            <Icon aria-hidden className="size-4 shrink-0 text-muted" />
            <span className="font-mono text-sm break-all">{e.name}</span>
          </button>
        );
      },
    },
    {
      id: 'size',
      header: t('files.size'),
      accessorKey: 'size',
      cell: ({ row }) => (row.original.type === 'dir' ? '—' : fmt.bytes(row.original.size)),
    },
    {
      id: 'mode',
      header: t('files.mode'),
      accessorKey: 'mode',
      cell: ({ row }) => (
        <span className="font-mono text-sm" title={row.original.mode}>
          {modeString(row.original.mode)}
        </span>
      ),
    },
    {
      id: 'modified',
      header: t('files.modified'),
      accessorKey: 'modified_at',
      cell: ({ row }) => fmt.dateTime(row.original.modified_at),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => {
        const e = row.original;
        const archive = /\.(zip|tar\.gz|tgz)$/.test(e.name);
        return (
          <RowMenu
            label={t('files.actionsFor', { name: e.name })}
            actions={[
              {
                label: t('files.edit'),
                onSelect: () => setEditing(e.path),
                hidden: e.type !== 'file' || !isTextFile(e.name),
              },
              {
                label: t('files.download'),
                onSelect: () => void download(e.path),
                hidden: e.type !== 'file',
              },
              {
                label: t('files.extract'),
                onSelect: () => setDialog({ op: 'extract', paths: [e.path] }),
                hidden: !archive,
              },
              {
                label: t('files.move'),
                onSelect: () => setDialog({ op: 'move', paths: [e.path] }),
              },
              {
                label: t('files.copy'),
                onSelect: () => setDialog({ op: 'copy', paths: [e.path] }),
              },
              {
                label: t('files.chmod'),
                onSelect: () => setDialog({ op: 'chmod', paths: [e.path] }),
              },
              {
                label: t('files.delete'),
                onSelect: () => setDialog({ op: 'delete', paths: [e.path] }),
                danger: true,
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submitPath} className="flex flex-col gap-1.5" noValidate>
        <Label htmlFor="files-path">{t('files.path')}</Label>
        <div className="flex gap-2">
          <Input
            id="files-path"
            className="font-mono"
            value={draft ?? display}
            onChange={(e) => {
              setDraft(e.target.value);
              setPathError(false);
            }}
            aria-invalid={pathError}
            aria-describedby="files-path-hint"
            spellCheck={false}
          />
          <Button type="submit" variant="outline">
            {t('files.go')}
          </Button>
        </div>
        <p
          id="files-path-hint"
          className={pathError ? 'text-xs text-danger-text' : 'text-xs text-muted'}
          {...(pathError ? { role: 'alert' } : {})}
        >
          {pathError ? t('files.outsideHome', { home }) : t('files.pathHint', { home })}
        </p>
      </form>
      <nav aria-label={t('files.breadcrumb')}>
        <ol className="flex flex-wrap items-center gap-1 text-sm">
          {crumbs(path, home).map(([p, label], i, all) => (
            <li key={p} className="flex items-center gap-1">
              {i > 0 && <ChevronRight aria-hidden className="size-3.5 text-muted" />}
              {i === all.length - 1 ? (
                <span aria-current="page" className="font-mono font-medium">
                  {label}
                </span>
              ) : (
                <button type="button" className="font-mono hover:underline" onClick={() => go(p)}>
                  {label}
                </button>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Card className="hidden lg:block">
          <CardContent className="p-2">
            <nav aria-label={t('files.tree')}>
              <button
                type="button"
                onClick={() => go('.')}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-sm hover:bg-surface-2"
                {...(path === '.' ? { 'aria-current': 'page' as const } : {})}
              >
                <FolderOpen aria-hidden className="size-4 text-muted" />~
              </button>
              <Tree account={account} dir="." current={path} go={go} depth={1} />
            </nav>
          </CardContent>
        </Card>
        <div className="flex min-w-0 flex-col gap-2">
          {dir.isError ? (
            <ErrorState error={dir.error} onRetry={() => void dir.refetch()} />
          ) : dir.isPending ? (
            <TableSkeleton />
          ) : (
            <DataTable<Entry>
              key={`${path}:${rows.map((r) => r.path).join('|')}`}
              caption={t('files.caption', { path: display })}
              data={rows}
              columns={columns}
              getRowId={(e) => e.path}
              primaryColumnId="name"
              selectable
              onSelectionChange={setSelected}
              pageSize={50}
              toolbar={
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialog({ op: 'mkdir', paths: [] })}
                  >
                    <FolderPlus aria-hidden />
                    {t('files.newFolder')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => upload.current?.click()}>
                    <Upload aria-hidden />
                    {t('files.upload')}
                  </Button>
                  <input
                    ref={upload}
                    type="file"
                    multiple
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden
                    onChange={(e) => {
                      onUpload(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  {selected.length > 0 && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog({ op: 'move', paths: selected })}
                      >
                        {t('files.moveN', { count: selected.length })}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog({ op: 'compress', paths: selected })}
                      >
                        {t('files.compressN', { count: selected.length })}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setDialog({ op: 'delete', paths: selected })}
                      >
                        {t('files.deleteN', { count: selected.length })}
                      </Button>
                    </>
                  )}
                </div>
              }
              empty={<p className="p-6 text-center text-base text-muted">{t('files.empty')}</p>}
            />
          )}
          <UploadList items={uploads.items} onDismiss={uploads.dismiss} />
          {path !== '.' && (
            <button
              type="button"
              className="self-start text-sm text-primary-text hover:underline"
              onClick={() => go(parentPath(path))}
            >
              {t('files.up')}
            </button>
          )}
        </div>
      </div>
      {dialog && (
        <OperateDialog
          account={account}
          home={home}
          cwd={path}
          op={dialog.op}
          paths={dialog.paths}
          onClose={() => setDialog(null)}
        />
      )}
      {editing && <Editor account={account} path={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Cây thư mục: chỉ tải thư mục con khi mở; tự mở các thư mục tổ tiên của đường dẫn hiện tại. */
function Tree({
  account,
  dir,
  current,
  go,
  depth,
}: {
  account: string;
  dir: string;
  current: string;
  go: (p: string) => void;
  depth: number;
}) {
  const q = useDir(account, dir);
  const folders = (q.data ?? []).filter((e) => e.type === 'dir');
  if (folders.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {folders.map((f) => {
        const open = isInside(current, f.path);
        return (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => go(f.path)}
              className="flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left font-mono text-sm hover:bg-surface-2 aria-[current=page]:bg-surface-2 aria-[current=page]:font-medium"
              style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
              {...(current === f.path ? { 'aria-current': 'page' as const } : {})}
            >
              {open ? (
                <FolderOpen aria-hidden className="size-4 shrink-0 text-muted" />
              ) : (
                <Folder aria-hidden className="size-4 shrink-0 text-muted" />
              )}
              <span className="truncate">{f.name}</span>
            </button>
            {open && depth < 6 && (
              <Tree account={account} dir={f.path} current={current} go={go} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function OperateDialog({
  account,
  home,
  cwd,
  op,
  paths,
  onClose,
}: {
  account: string;
  home: string;
  cwd: string;
  op: Op;
  paths: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const first = paths[0] ?? '.';
  const initial =
    op === 'mkdir'
      ? ''
      : op === 'chmod'
        ? '0644'
        : op === 'compress'
          ? `${baseName(first)}.zip`
          : op === 'extract'
            ? cwd
            : parentPath(first);
  const [value, setValue] = useState(initial);
  const [format, setFormat] = useState<'zip' | 'tar.gz'>('zip');
  const needsTarget = op === 'move' || op === 'copy' || op === 'extract';
  let target: string | null = null;
  let error: string | null = null;
  if (op === 'mkdir') {
    if (value && !isValidName(value)) error = t('files.errors.name');
  } else if (op === 'chmod') {
    if (!MODE_RE.test(value)) error = t('files.errors.mode');
  } else if (op === 'compress') {
    if (!isValidName(value)) error = t('files.errors.name');
    else target = joinPath(cwd, value);
  } else if (needsTarget) {
    target = normalizePath(value, home);
    if (target === null) error = t('files.outsideHome', { home });
    else if ((op === 'move' || op === 'copy') && paths.some((p) => isInside(target as string, p))) {
      error = t('files.errors.intoSelf');
    }
  }
  const run = useAction(
    () =>
      send('POST', '/hosting-accounts/{id}/files:operate', {
        path: { id: account },
        body: {
          op,
          paths: op === 'mkdir' ? [joinPath(cwd, value)] : paths,
          target,
          mode: op === 'chmod' ? value.padStart(4, '0') : null,
          format: op === 'compress' ? format : null,
        },
      }),
    { onSuccess: onClose },
  );
  const names = paths.map(baseName);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t(`files.ops.${op}`, { count: paths.length })}
      description={
        op === 'mkdir'
          ? t('files.inFolder', { path: cwd === '.' ? '~' : `~/${cwd}` })
          : names.join(', ')
      }
      submitLabel={t(`files.opsSubmit.${op}`)}
      pending={run.isPending || error !== null || (op === 'mkdir' && !value)}
      onSubmit={() => error === null && run.mutate()}
    >
      {op === 'delete' ? (
        <Alert tone="danger" title={t('files.deleteWarn', { count: paths.length })} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="op-value">{t(`files.opsField.${op}`)}</Label>
          <Input
            id="op-value"
            className="font-mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error !== null}
            aria-describedby="op-hint"
            spellCheck={false}
            autoComplete="off"
          />
          <p
            id="op-hint"
            className={error ? 'text-xs text-danger-text' : 'text-xs text-muted'}
            {...(error ? { role: 'alert' } : {})}
          >
            {error ?? (op === 'chmod' ? modeString(value.padStart(3, '0')) : t('files.relHint'))}
          </p>
        </div>
      )}
      {op === 'compress' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="op-format">{t('files.format')}</Label>
          <Select
            id="op-format"
            value={format}
            onValueChange={(v) => {
              const f = v as 'zip' | 'tar.gz';
              setFormat(f);
              setValue(
                (x) => x.replace(/\.(zip|tar\.gz)$/, '') + (f === 'zip' ? '.zip' : '.tar.gz'),
              );
            }}
            options={[
              { value: 'zip', label: 'ZIP' },
              { value: 'tar.gz', label: 'TAR.GZ' },
            ]}
          />
        </div>
      )}
    </FormDialog>
  );
}

function Editor({
  account,
  path,
  onClose,
}: {
  account: string;
  path: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const q = useQuery({
    queryKey: ['admin', 'file', account, path],
    queryFn: () =>
      get('/hosting-accounts/{id}/files/content', {
        path: { id: account },
        query: { path },
      }),
    gcTime: 0,
  });
  const [text, setText] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const save = useAction(
    () =>
      send('PUT', '/hosting-accounts/{id}/files/content', {
        path: { id: account },
        body: {
          path,
          content: text ?? q.data?.content ?? '',
          encoding: 'utf-8',
          if_etag: q.data?.etag ?? null,
        },
      }),
    {
      success: t('files.saved'),
      invalidate: [['admin', 'files', account]],
      onSuccess: onClose,
    },
  );
  const submit = () =>
    save.mutate(undefined, {
      onError: (e) => {
        if (e instanceof ApiError && e.problem.status === 412) setConflict(true);
      },
    });
  const reload = () => {
    setConflict(false);
    setText(null);
    void q.refetch();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={baseName(path)} description={`~/${path}`} className="max-w-4xl">
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <TableSkeleton rows={8} />
        ) : (
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {conflict && (
              <Alert
                tone="warning"
                title={t('files.conflict')}
                action={
                  <Button type="button" size="sm" variant="outline" onClick={reload}>
                    {t('files.reload')}
                  </Button>
                }
              />
            )}
            <Label htmlFor="file-content" className="sr-only">
              {t('files.content')}
            </Label>
            <Textarea
              id="file-content"
              rows={18}
              spellCheck={false}
              className="font-mono text-sm"
              value={text ?? q.data.content}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {t('files.close')}
              </Button>
              <Button type="submit" disabled={save.isPending || text === null}>
                {t('files.save')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
