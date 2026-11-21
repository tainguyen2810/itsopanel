import raw from '@contracts/examples/demo-dataset.json';
import type { components as A } from '@/api/generated/admin/schema';

/** Kiểu của các tập dữ liệu demo (theo schema OpenAPI). JSON được sinh từ contracts/tools/demo.py. */
type S = A['schemas'];
export interface DemoData {
  users: S['AdminUser'][];
  servers: S['Server'][];
  packages: S['HostingPackage'][];
  package_versions: S['PackageVersion'][];
  accounts: S['HostingAccount'][];
  lifecycle: S['LifecycleEvent'][];
  websites: S['Website'][];
  domains: S['WebsiteDomain'][];
  certs: S['Certificate'][];
  databases: S['Database'][];
  db_users: S['DatabaseUser'][];
  files: S['FileEntry'][];
  sftp: S['SftpAccount'][];
  ssh_keys: S['SshKey'][];
  cron: S['CronJob'][];
  cron_runs: S['CronRun'][];
  dns_zones: S['DnsZone'][];
  dns_records: S['DnsRecord'][];
  backup_dests: S['BackupDestination'][];
  backup_policies: S['BackupPolicy'][];
  snapshots: S['BackupSnapshot'][];
  restores: S['Restore'][];
  backup_repos: S['BackupRepository'][];
  backup_verifications: S['BackupVerification'][];
  recovery_kit: S['RecoveryKit'];
  setup_restore_candidates: S['SetupRestoreCandidate'][];
  migrations: S['AccountMigration'][];
  purges: S['PurgeRecord'][];
  jobs: S['Job'][];
  job_logs: S['JobLog'][];
  audit: S['AuditLog'][];
  security_events: S['SecurityEvent'][];
  sessions: S['Session'][];
  notifications: S['Notification'][];
  [k: string]: unknown;
}

export const dataset = raw as unknown as DemoData;
