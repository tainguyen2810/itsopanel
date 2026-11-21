package install

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"itso.local/agent/internal/platform"
)

// State là checkpoint /var/lib/itso/install-state.json.
type State struct {
	Version  string            `json:"version"`
	Previous string            `json:"previous,omitempty"`
	Steps    map[string]string `json:"steps"` // bước → thời điểm xong (RFC 3339)
}

func (e *Env) saveState(st *State) error {
	return e.writeJSON(StateFile, st, 0o600, platform.Owner{})
}

// Panel là /etc/itso/panel.json: cổng, entrance path, domain.
type Panel struct {
	Port     int    `json:"port"`
	Entrance string `json:"entrance"`
	Domain   string `json:"domain,omitempty"`
}

// Step là một bước cài có checkpoint.
type Step struct {
	Name  string
	Title string
	Run   func(ctx context.Context, e *Env, o Options, r *Release) error
}

var systemGroups = []string{"itso-agent-clients", "itso-proc", "itso-ssh", "itso-sftp", "itso-suspended"}
var systemUsers = []string{"itso", "itso-gw", "itso-redis"}

// basePackages: gói tối thiểu từ kho Ubuntu (10 §4 bước 2). Nginx/PHP/MySQL do Wizard chọn.
var basePackages = []string{"postgresql-16", "redis-server", "nftables", "acl", "quota", "ca-certificates"}

// Steps là các bước itso install theo thứ tự (10 §4).
var Steps = []Step{
	{"users", "Tạo user và group hệ thống", stepUsers},
	{"packages", "Cài gói tối thiểu (apt)", stepPackages},
	{"release", "Giải nén bản phát hành", stepRelease},
	{"secrets", "Sinh khóa và cấu hình", stepSecrets},
	{"database", "Tạo cluster PostgreSQL itso", stepDatabase},
	{"migrate", "Chạy migration và seed", stepMigrate},
	{"tls", "Sinh chứng chỉ tự ký cho panel", stepTLS},
	{"systemd", "Cài và bật itso.target", stepSystemd},
	{"firewall", "Tường lửa cơ bản", stepFirewall},
}

// Install chạy preflight rồi các bước chưa xong; ghi checkpoint sau mỗi bước.
func (e *Env) Install(ctx context.Context, o Options) error {
	if o.Port == 0 {
		o.Port = 28443
	}
	e.printf("Kiểm tra trước khi cài (preflight):\n")
	cs := e.Preflight(ctx, o)
	e.PrintChecks(cs)
	var st State
	if _, err := e.readJSON(StateFile, &st); err != nil {
		return fmt.Errorf("đọc %s: %w", StateFile, err)
	}
	if st.Steps == nil {
		st.Steps = map[string]string{}
	}
	if o.DryRun {
		e.printf("\n--dry-run: các bước sẽ chạy (không thay đổi gì):\n")
		for i, s := range Steps {
			mark := "chờ"
			if st.Steps[s.Name] != "" {
				mark = "đã xong " + st.Steps[s.Name]
			}
			e.printf("  %2d. %-9s %s [%s]\n", i+1, s.Name, s.Title, mark)
		}
		if Failed(cs) {
			return errors.New("preflight có mục FAIL")
		}
		return nil
	}
	if Failed(cs) {
		return errors.New("preflight có mục FAIL: sửa rồi chạy lại (không có cờ bỏ qua)")
	}
	warn := false
	for _, c := range cs {
		warn = warn || c.Status == Warn
	}
	if warn && !o.Yes {
		return errors.New("preflight có cảnh báo: xem lại rồi chạy lại với --yes để tiếp tục")
	}
	r, err := e.loadRelease(o.ReleaseDir)
	if err != nil {
		return err
	}
	for i, s := range Steps {
		if st.Steps[s.Name] != "" {
			e.printf("[%d/%d] %s: đã xong (%s), bỏ qua\n", i+1, len(Steps), s.Title, st.Steps[s.Name])
			continue
		}
		e.printf("[%d/%d] %s…\n", i+1, len(Steps), s.Title)
		if err := s.Run(ctx, e, o, r); err != nil {
			return fmt.Errorf("bước %s lỗi: %w (sửa rồi chạy lại itso install: các bước đã xong được giữ)", s.Name, err)
		}
		st.Steps[s.Name] = e.now().UTC().Format(time.RFC3339)
		if s.Name == "release" {
			st.Version = r.Manifest.Version
		}
		if err := e.saveState(&st); err != nil {
			return err
		}
	}
	mode := ""
	if o.Restore {
		mode = "restore"
	}
	code, err := e.newSetupCode(mode)
	if err != nil {
		return err
	}
	e.printf("\nITSO Panel %s đã cài đặt thành công\n", st.Version)
	e.printf("URL:          %s\n", e.URL())
	e.printf("Mã thiết lập: %s (hết hạn sau 60 phút, chỉ dùng một lần)\n", code)
	if fp, err := e.certFingerprint(); err == nil {
		e.printf("Chứng chỉ:    tự ký, SHA256 %s\n", fp)
	}
	if o.Restore {
		e.printf("Chế độ khôi phục: mở URL, nhập mã thiết lập rồi chọn \"Khôi phục từ backup\" với bộ khôi phục\n")
		e.printf("              (đích, repo server + mật khẩu, khóa riêng age). Runbook: docs/runbooks/disaster-recovery.md\n")
	}
	e.printf("Lệnh quản trị: itso status | itso doctor | itso help\n")
	return nil
}

func stepUsers(ctx context.Context, e *Env, _ Options, _ *Release) error {
	for _, g := range systemGroups {
		if _, ok := e.gid(g); !ok {
			if _, err := e.cmd(ctx, "groupadd", "-r", g); err != nil {
				return err
			}
		}
	}
	for _, u := range systemUsers {
		if _, ok := e.uid(u); !ok {
			if _, err := e.cmd(ctx, "useradd", "-r", "-U", "-M", "-d", "/nonexistent", "-s", "/usr/sbin/nologin", "-c", "ITSO Panel", u); err != nil {
				return err
			}
		}
	}
	// itso gọi agent (socket group) và Redis (socket group itso-redis).
	for _, m := range [][2]string{{"itso", "itso-agent-clients"}, {"itso", "itso-redis"}, {"itso-gw", "itso-agent-clients"}} {
		if !e.inGroup(m[0], m[1]) {
			if _, err := e.cmd(ctx, "gpasswd", "-a", m[0], m[1]); err != nil {
				return err
			}
		}
	}
	return nil
}

func (e *Env) inGroup(user, group string) bool {
	for _, l := range strings.Split(e.readFile("/etc/group"), "\n") {
		f := strings.Split(l, ":")
		if len(f) == 4 && f[0] == group {
			for _, m := range strings.Split(f[3], ",") {
				if m == user {
					return true
				}
			}
		}
	}
	return false
}

func stepPackages(ctx context.Context, e *Env, _ Options, _ *Release) error {
	var missing []string
	for _, p := range basePackages {
		r := e.try(ctx, "dpkg-query", "-W", "-f=${Status}", p)
		if r.ExitCode != 0 || strings.TrimSpace(string(r.Stdout)) != "install ok installed" {
			missing = append(missing, p)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	if _, err := e.cmd(ctx, "apt-get", "update", "-q"); err != nil {
		return err
	}
	args := append([]string{"install", "-y", "-q", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confdef",
		"-o", "Dpkg::Options::=--force-confold"}, missing...)
	_, err := e.cmd(ctx, "apt-get", args...)
	return err
}

func stepRelease(_ context.Context, e *Env, _ Options, r *Release) error {
	if _, err := e.extract(r); err != nil {
		return err
	}
	for _, d := range []struct {
		p     string
		mode  os.FileMode
		owner platform.Owner
	}{
		{EtcDir, 0o750, e.rootGroup("itso")}, {VarDir, 0o750, e.rootGroup("itso")}, {LogDir, 0o750, e.rootGroup("itso")},
		{BackupDir, 0o700, platform.Owner{}},
		// Phase 6: chunk upload do panel (itso) ghi, agent (root) đọc khi commit; cron/SSH key do agent quản lý.
		{VarDir + "/uploads", 0o700, e.userOwner("itso")},
		{"/etc/itso-cron", 0o755, platform.Owner{}}, {"/etc/ssh/itso_authorized_keys", 0o755, platform.Owner{}},
	} {
		if err := e.FS.MkdirAll(dirOf(d.p)); err != nil {
			return err
		}
		if _, err := e.FS.EnsureDir(d.p, d.mode, d.owner); err != nil {
			return err
		}
	}
	return e.activate(r.Manifest.Version)
}

func (e *Env) randomString(n int, alphabet string) (string, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(e.rand(), b); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i, c := range b {
		out[i] = alphabet[int(c)%len(alphabet)]
	}
	return string(out), nil
}

func (e *Env) randomB64(n int) (string, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(e.rand(), b); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

// writeOnce ghi file chỉ khi chưa có (secret không bao giờ bị ghi đè khi chạy lại).
func (e *Env) writeOnce(p string, gen func() (string, error), mode os.FileMode, owner platform.Owner) error {
	if e.FS.Exists(p) {
		return nil
	}
	s, err := gen()
	if err != nil {
		return err
	}
	if err := e.FS.MkdirAll(dirOf(p)); err != nil {
		return err
	}
	_, err = e.FS.WriteAtomic(p, []byte(s), mode, owner)
	return err
}

const lower = "abcdefghijkmnpqrstuvwxyz23456789"

func stepSecrets(_ context.Context, e *Env, o Options, _ *Release) error {
	itso := e.rootGroup("itso")
	if err := e.writeOnce(AgentKey, func() (string, error) { s, err := e.randomB64(48); return s + "\n", err }, 0o640, itso); err != nil {
		return err
	}
	var p Panel
	if ok, err := e.readJSON(PanelFile, &p); err != nil {
		return err
	} else if !ok {
		ent, err := e.randomString(8, lower)
		if err != nil {
			return err
		}
		p = Panel{Port: o.Port, Entrance: ent}
		if err := e.writeJSON(PanelFile, p, 0o644, platform.Owner{}); err != nil {
			return err
		}
	}
	redisPass, err := e.randomString(40, lower)
	if err != nil {
		return err
	}
	if err := e.writeOnce(RedisConf, func() (string, error) {
		return "# Sinh bởi itso install. Redis riêng của panel: chỉ socket Unix, không TCP.\nport 0\nunixsocket /run/itso-redis/redis.sock\nunixsocketperm 770\n" +
			"dir /var/lib/itso-redis\nappendonly yes\nrequirepass " + redisPass + "\n", nil
	}, 0o640, e.rootGroup("itso-redis")); err != nil {
		return err
	}
	// Lấy lại mật khẩu Redis đã ghi (chạy lại không sinh mới).
	for _, l := range strings.Split(e.readFile(RedisConf), "\n") {
		if v, ok := strings.CutPrefix(l, "requirepass "); ok {
			redisPass = v
		}
	}
	return e.writeOnce(EnvFile, func() (string, error) {
		k, err := e.randomB64(32)
		if err != nil {
			return "", err
		}
		return strings.Join([]string{
			"# Sinh bởi itso install. Không commit, không chia sẻ.",
			"APP_ENV=production", "APP_DEBUG=false", "APP_KEY=base64:" + k,
			"DB_CONNECTION=pgsql", "DB_HOST=/var/run/postgresql", "DB_PORT=" + strconv.Itoa(PGPort), "DB_DATABASE=itso", "DB_USERNAME=itso",
			"REDIS_CLIENT=phpredis", "REDIS_SCHEME=unix", "REDIS_PATH=/run/itso-redis/redis.sock", "REDIS_PASSWORD=" + redisPass,
			"QUEUE_CONNECTION=redis", "CACHE_STORE=redis", "SESSION_DRIVER=redis",
			"ITSO_PANEL_PORT=" + strconv.Itoa(p.Port), "ITSO_ENTRANCE=" + p.Entrance,
			"ITSO_AGENT_SOCKET=" + AgentSocket, "ITSO_AGENT_KEY_FILE=" + AgentKey, "ITSO_SETUP_CODE_FILE=" + SetupFile, "",
		}, "\n"), nil
	}, 0o640, itso)
}

func stepDatabase(ctx context.Context, e *Env, _ Options, _ *Release) error {
	if !e.FS.Exists("/etc/postgresql/16/itso") {
		if _, err := e.cmd(ctx, "pg_createcluster", "16", "itso", "-p", strconv.Itoa(PGPort), "--start", "--", "--auth-local=peer"); err != nil {
			return err
		}
	}
	pg, err := e.as("postgres")
	if err != nil {
		return err
	}
	psql := func(sql string) (string, error) {
		r, err := e.run(ctx, platform.Cmd{Bin: "psql", Args: []string{"--cluster", "16/itso", "-v", "ON_ERROR_STOP=1", "-tAc", sql}, As: pg})
		return strings.TrimSpace(string(r.Stdout)), err
	}
	// Câu SQL cố định (không có giá trị từ người dùng).
	if v, err := psql("SELECT 1 FROM pg_roles WHERE rolname = 'itso'"); err != nil {
		return err
	} else if v != "1" {
		if _, err := psql("CREATE ROLE itso LOGIN"); err != nil {
			return err
		}
	}
	if v, err := psql("SELECT 1 FROM pg_database WHERE datname = 'itso'"); err != nil {
		return err
	} else if v != "1" {
		if _, err := psql("CREATE DATABASE itso OWNER itso ENCODING 'UTF8'"); err != nil {
			return err
		}
	}
	return nil
}

func stepMigrate(ctx context.Context, e *Env, _ Options, _ *Release) error {
	// .env của Laravel trỏ tới /etc/itso/itso.env.
	if err := e.linkEnv(); err != nil {
		return err
	}
	if _, err := e.artisan(ctx, "migrate", "--force"); err != nil {
		return err
	}
	if _, err := e.artisan(ctx, "db:seed", "--force"); err != nil {
		return err
	}
	_, err := e.artisan(ctx, "optimize")
	return err
}

// linkEnv tạo symlink api/.env → /etc/itso/itso.env (tuyệt đối, trong cùng hệ thống file đích).
func (e *Env) linkEnv() error {
	rp, err := e.FS.Path(CurrentLink + "/api/.env")
	if err != nil {
		return err
	}
	if t, err := os.Readlink(rp); err == nil && t == EnvFile {
		return nil
	}
	_ = os.Remove(rp)
	return os.Symlink(EnvFile, rp)
}

func stepTLS(_ context.Context, e *Env, _ Options, _ *Release) error {
	if e.FS.Exists(TLSCert) && e.FS.Exists(TLSKey) {
		return nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), e.rand())
	if err != nil {
		return err
	}
	serial, err := randSerial(e.rand())
	if err != nil {
		return err
	}
	host := strings.TrimSpace(e.hostText("/proc/sys/kernel/hostname"))
	if host == "" {
		host = "itso-panel"
	}
	now := e.now()
	tpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: host, Organization: []string{"ITSO Panel (tự ký)"}},
		NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(2, 0, 0), DNSNames: []string{host},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(e.rand(), tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	if err := e.FS.MkdirAll(dirOf(TLSCert)); err != nil {
		return err
	}
	if _, err := e.FS.WriteAtomic(TLSKey, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o640, e.rootGroup("itso")); err != nil {
		return err
	}
	_, err = e.FS.WriteAtomic(TLSCert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644, platform.Owner{})
	return err
}

func randSerial(r io.Reader) (*big.Int, error) {
	b := make([]byte, 16)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	return new(big.Int).SetBytes(b), nil
}

func (e *Env) cert() (*x509.Certificate, error) {
	b, _ := pem.Decode([]byte(e.readFile(TLSCert)))
	if b == nil {
		return nil, errors.New("không đọc được chứng chỉ panel")
	}
	return x509.ParseCertificate(b.Bytes)
}

func (e *Env) certFingerprint() (string, error) {
	c, err := e.cert()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c.Raw)
	h := strings.ToUpper(hex.EncodeToString(sum[:]))
	var parts []string
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}
	return strings.Join(parts, ":"), nil
}

// releaseUnits đọc unit systemd trong release hiện tại (packaging/systemd).
func (e *Env) releaseUnits() (map[string][]byte, error) {
	rp, err := e.FS.Path(CurrentLink + "/packaging/systemd")
	if err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(rp)
	if err != nil {
		return nil, fmt.Errorf("release thiếu packaging/systemd: %w", err)
	}
	out := map[string][]byte{}
	for _, d := range ents {
		n := d.Name()
		if d.Type().IsRegular() && (strings.HasSuffix(n, ".service") || strings.HasSuffix(n, ".target") ||
			strings.HasSuffix(n, ".timer") || strings.HasSuffix(n, ".slice")) {
			b, err := os.ReadFile(filepath.Join(rp, n)) //nolint:gosec // trong release đã kiểm chữ ký
			if err != nil {
				return nil, err
			}
			out[n] = b
		}
	}
	return out, nil
}

// installUnits chép unit của release vào /etc/systemd/system; daemon-reload khi có thay đổi.
func (e *Env) installUnits(ctx context.Context) error {
	units, err := e.releaseUnits()
	if err != nil {
		return err
	}
	changed := false
	names := make([]string, 0, len(units))
	for n := range units {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		c, err := e.FS.WriteAtomic(UnitDir+"/"+n, units[n], 0o644, platform.Owner{})
		if err != nil {
			return err
		}
		changed = changed || c
	}
	if changed {
		_, err = e.cmd(ctx, "systemctl", "daemon-reload")
	}
	return err
}

func stepSystemd(ctx context.Context, e *Env, _ Options, _ *Release) error {
	if err := e.installUnits(ctx); err != nil {
		return err
	}
	_, err := e.cmd(ctx, "systemctl", "enable", "--now", "itso.target")
	return err
}

func stepFirewall(_ context.Context, e *Env, o Options, _ *Release) error {
	if o.NoFirewall {
		e.printf("  --no-firewall: bỏ qua\n")
		return nil
	}
	// Tường lửa có safe-apply + rollback là op firewall.apply (Phase 7); installer không tự đóng port.
	e.printf("  Chưa áp dụng ở Phase 4: tường lửa có safe-apply làm ở Phase 7. Hãy mở port panel và 80/443 nếu đang có tường lửa.\n")
	return nil
}
