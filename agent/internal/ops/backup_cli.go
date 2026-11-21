package ops

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// Lệnh CLI `itso backup prune|panel-restore` (ADR 0029 §4, ADR 0033 §6): chạy trên máy chủ bằng bộ khôi phục,
// ngoài luồng panel. Credential có quyền xóa (prune) do SA nhập qua stdin, không lưu ở đâu.

// KitCreds là credential SA nhập cho lệnh CLI (không có trong bộ khôi phục).
type KitCreds struct {
	AccessKeyID, SecretAccessKey string // s3
	Password                     string // rest
	SSHKey                       []byte // sftp: khóa riêng OpenSSH (tùy chọn nếu máy đã có khóa của đích)
}

// KeepPolicy là chính sách giữ của prune (restic forget --keep-*).
type KeepPolicy struct{ Last, Daily, Weekly, Monthly, Yearly int }

func (k KeepPolicy) args() ([]string, error) {
	var a []string
	any := false
	for _, f := range []struct {
		flag string
		n    int
	}{{"--keep-last", k.Last}, {"--keep-daily", k.Daily}, {"--keep-weekly", k.Weekly}, {"--keep-monthly", k.Monthly}, {"--keep-yearly", k.Yearly}} {
		if f.n < 0 || f.n > 1000 {
			return nil, bkInvalid(f.flag + " phải trong 0–1000")
		}
		if f.n > 0 {
			a, any = append(a, f.flag, strconv.Itoa(f.n)), true
		}
	}
	if !any {
		return nil, bkInvalid("cần ít nhất một --keep-*")
	}
	return a, nil
}

// ReadKitCreds đọc credential từ r theo loại đích: s3 = 2 dòng (access key id, secret); rest = 1 dòng (mật khẩu);
// local/sftp = không đọc gì.
func ReadKitCreds(destType string, r io.Reader) (KitCreds, error) {
	var c KitCreds
	need := map[string]int{"s3": 2, "rest": 1}[destType]
	if need == 0 {
		return c, nil
	}
	b, err := io.ReadAll(io.LimitReader(r, 8192))
	if err != nil {
		return c, err
	}
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(string(b), "\r", ""), "\n"), "\n")
	if len(lines) < need || strings.TrimSpace(lines[0]) == "" {
		return c, bkInvalid(fmt.Sprintf("stdin cần %d dòng credential cho đích %s", need, destType))
	}
	if destType == "s3" {
		c.AccessKeyID, c.SecretAccessKey = strings.TrimSpace(lines[0]), strings.TrimSpace(lines[1])
	} else {
		c.Password = strings.TrimSpace(lines[0])
	}
	return c, nil
}

// KitDestination dựng tham số đích từ bộ khôi phục + credential (agent vẫn kiểm lại như op thường).
func KitDestination(k backup.Kit, c KitCreds) (json.RawMessage, error) {
	d := map[string]any{"type": k.DestType, "destination_uuid": k.DestinationUUID}
	for key, v := range k.Config {
		switch key {
		case "host", "user", "path", "endpoint", "bucket", "url":
			d[key] = v
		case "region", "host_key_sha256":
			if v != "" && v != "-" {
				d[key] = v
			}
		case "port":
			n, err := strconv.Atoi(v)
			if err != nil {
				return nil, bkInvalid("port trong bộ khôi phục không hợp lệ")
			}
			d[key] = n
		}
	}
	switch k.DestType {
	case "s3":
		d["access_key_id"], d["secret_access_key"] = c.AccessKeyID, c.SecretAccessKey
	case "rest":
		if c.Password != "" {
			d["password"] = c.Password
		}
	}
	return json.Marshal(d)
}

func cliEnv(op string) *envelope.Envelope {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return &envelope.Envelope{V: 1, Op: op, OpID: "cli-" + hex.EncodeToString(b)}
}

func randUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// kitPrepare kiểm đích như backup.destination.test (SFTP: ghim host key, đặt khóa SSH nếu SA đưa).
func (d *Deps) kitPrepare(ctx context.Context, k backup.Kit, c KitCreds) (json.RawMessage, error) {
	if !reUUIDStr(k.DestinationUUID) {
		return nil, bkInvalid("bộ khôi phục thiếu destination_uuid")
	}
	dest, err := KitDestination(k, c)
	if err != nil {
		return nil, err
	}
	pd, err := backup.ParseDest(dest)
	if err != nil {
		return nil, bkErr(err)
	}
	if pd.Type == "sftp" && !d.Sandbox {
		if len(c.SSHKey) > 0 {
			if _, err := backup.PublicFromPrivate(c.SSHKey, "itso-backup"); err != nil {
				return nil, bkInvalid("--ssh-key không phải khóa riêng OpenSSH hợp lệ")
			}
			if err := d.ensureTree(backup.KeyDir, 0o700); err != nil {
				return nil, opErr(err)
			}
			if _, err := d.FS.WriteAtomic(pd.KeyPath(), c.SSHKey, 0o600, platform.Owner{}); err != nil {
				return nil, opErr(err)
			}
		} else if !d.FS.Exists(pd.KeyPath()) {
			return nil, bkInvalid("đích SFTP: máy này chưa có khóa SSH của đích, cần --ssh-key")
		}
		params, _ := json.Marshal(map[string]any{"destination": json.RawMessage(dest)})
		env := cliEnv("backup.destination.test")
		env.Params = params
		res, err := d.backupDestTest(ctx, env)
		if err != nil {
			return nil, err
		}
		if ok, _ := res["ok"].(bool); !ok {
			return nil, &registry.OpError{Code: "dependency_unavailable", Message: fmt.Sprintf("không kết nối được đích: %v", res["error"])}
		}
	}
	return dest, nil
}

// KitPrune áp chính sách giữ lên mọi repo trong bộ khôi phục: restic forget --dry-run --json để biết snapshot bị bỏ
// (nhóm theo host+tags), cộng snapshot meta đi kèm (of:<id8>) và meta mồ côi, rồi forget --prune (trừ khi dryRun).
func (d *Deps) KitPrune(ctx context.Context, k backup.Kit, c KitCreds, keep KeepPolicy, dryRun bool, out io.Writer) error {
	kargs, err := keep.args()
	if err != nil {
		return err
	}
	dest, err := d.kitPrepare(ctx, k, c)
	if err != nil {
		return err
	}
	for _, kr := range k.Repos {
		rp := backup.RepoParams{RepoUUID: randUUID(), Path: kr.Path, Destination: dest, Password: kr.Password}
		ids, kept, err := d.pruneRepo(ctx, rp, kargs, dryRun)
		if err != nil {
			return fmt.Errorf("%s: %w", kr.Label, err)
		}
		verb := "đã xóa"
		if dryRun {
			verb = "sẽ xóa"
		}
		fmt.Fprintf(out, "%s (%s): giữ %d, %s %d snapshot\n", kr.Label, kr.Path, kept, verb, len(ids))
		for _, id := range ids {
			fmt.Fprintf(out, "  - %s\n", id)
		}
	}
	return nil
}

func (d *Deps) pruneRepo(ctx context.Context, rp backup.RepoParams, kargs []string, dryRun bool) ([]string, int, error) {
	r, done, err := d.openRepo(cliEnv("backup.forget"), rp)
	if err != nil {
		return nil, 0, err
	}
	defer done()
	code, out, stderr, err := r.restic(ctx, "", nil, nil, "snapshots", "--json")
	if err != nil {
		return nil, 0, err
	}
	if code != 0 {
		return nil, 0, r.fail(code, stderr)
	}
	var all []backup.Snapshot
	if err := json.Unmarshal(out, &all); err != nil {
		return nil, 0, opErr(err)
	}
	args := append([]string{"forget", "--dry-run", "--json", "--group-by", "host,tags"}, kargs...)
	code, out, stderr, err = r.restic(ctx, "", nil, nil, args...)
	if err != nil {
		return nil, 0, err
	}
	if code != 0 {
		return nil, 0, r.fail(code, stderr)
	}
	var groups []struct {
		Remove []backup.Snapshot `json:"remove"`
	}
	if err := json.Unmarshal(out, &groups); err != nil {
		return nil, 0, opErr(err)
	}
	isMeta := func(s backup.Snapshot) bool {
		for _, t := range s.Tags {
			if t == backup.MetaTag {
				return true
			}
		}
		return false
	}
	remove := map[string]bool{}
	for _, g := range groups {
		for _, s := range g.Remove {
			if !isMeta(s) && backup.ValidSnapshotID(s.ID) {
				remove[s.ID] = true
			}
		}
	}
	alive := map[string]bool{} // id8 của snapshot chính còn giữ
	mains := 0
	for _, s := range all {
		if !isMeta(s) && len(s.ID) >= 8 {
			mains++
			if !remove[s.ID] {
				alive[s.ID[:8]] = true
			}
		}
	}
	var ids []string
	for _, s := range all {
		if !backup.ValidSnapshotID(s.ID) {
			continue
		}
		if remove[s.ID] {
			ids = append(ids, s.ID)
			continue
		}
		if isMeta(s) {
			of := ""
			for _, t := range s.Tags {
				if strings.HasPrefix(t, "of:") {
					of = t[3:]
				}
			}
			if !alive[of] {
				ids = append(ids, s.ID) // meta của snapshot bị xóa hoặc mồ côi
			}
		}
	}
	kept := mains - len(remove)
	if dryRun || len(ids) == 0 {
		return ids, kept, nil
	}
	code, _, stderr, err = r.restic(ctx, "", nil, nil, append([]string{"forget", "--prune"}, ids...)...)
	if err != nil {
		return nil, 0, err
	}
	if code != 0 {
		return nil, 0, r.fail(code, stderr)
	}
	return ids, kept, nil
}

// PanelArchiveMax giới hạn kích thước giải nén của backup panel (dump DB panel + /etc/itso).
const PanelArchiveMax = 4 << 30

// KitPanelRestore tải `panel/itso-panel.tar.age` của snapshot panel từ repo server trong bộ khôi phục, giải mã age
// bằng khóa riêng trong bộ khôi phục và giải vào dst (thư mục mới, root 0700). Áp DB + /etc/itso: luồng DR (8.5).
func (d *Deps) KitPanelRestore(ctx context.Context, k backup.Kit, c KitCreds, snapshot, dst string) ([]string, error) {
	if !backup.ValidSnapshotID(snapshot) {
		return nil, bkInvalid("snapshot id không hợp lệ")
	}
	if !strings.HasPrefix(k.PrivateKey, "AGE-SECRET-KEY-1") {
		return nil, bkInvalid("bộ khôi phục thiếu panel_private_key")
	}
	var server *backup.KitRepo
	for i := range k.Repos {
		if strings.HasSuffix(k.Repos[i].Path, "/server") {
			server = &k.Repos[i]
		}
	}
	if server == nil {
		return nil, bkInvalid("bộ khôi phục không có repo server")
	}
	dest, err := d.kitPrepare(ctx, k, c)
	if err != nil {
		return nil, err
	}
	r, done, err := d.openRepo(cliEnv("backup.restore"), backup.RepoParams{RepoUUID: randUUID(), Path: server.Path, Destination: dest, Password: server.Password})
	if err != nil {
		return nil, err
	}
	defer done()
	if err := os.Mkdir(dst, 0o700); err != nil {
		return nil, opErr(err)
	}
	pr, pw := io.Pipe()
	type res struct {
		names []string
		err   error
	}
	ch := make(chan res, 1)
	go func() {
		n, err := backup.ExtractPanelArchive(pr, k.PrivateKey, dst, PanelArchiveMax)
		_, _ = io.Copy(io.Discard, pr)
		ch <- res{n, err}
	}()
	code, _, stderr, rerr := r.restic(ctx, "", nil, pw, "dump", snapshot, "/panel/itso-panel.tar.age")
	_ = pw.Close()
	x := <-ch
	if rerr != nil {
		return nil, rerr
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	if x.err != nil {
		return nil, x.err
	}
	return x.names, nil
}
