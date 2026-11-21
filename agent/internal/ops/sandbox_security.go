package ops

import (
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"itso.local/agent/internal/platform"
)

// secSim mô phỏng nft và fail2ban-client cho --sandbox (Phase 7). Không chạy lệnh nào.
type secSim struct {
	mu    sync.Mutex
	table string // nội dung `table inet itso { … }` đang áp dụng; rỗng = chưa có bảng
	fs    *platform.FS
}

// NftFailMarker: script chứa chuỗi này bị `nft -c` coi là sai cú pháp (test luồng lỗi trong sandbox).
const NftFailMarker = "SANDBOX-NFT-FAIL"

func (s *secSim) handle(c platform.Cmd) (platform.Result, bool) {
	switch c.Bin {
	case "nft":
		return s.nft(c.Args), true
	case "fail2ban-client":
		return s.fail2ban(c.Args), true
	case "clamdscan":
		return ok("ClamAV 1.0.7/27470/Sun Nov 20 08:00:00 2026 (sandbox)\n"), true
	case "yara":
		return ok("4.5.0 (sandbox)\n"), true
	case "systemd-run":
		for i, a := range c.Args {
			if (a == ClamdscanBin || a == YaraBin) && i < len(c.Args)-1 {
				return s.scan(a, c.Args[len(c.Args)-1]), true
			}
		}
	}
	return platform.Result{}, false
}

func (s *secSim) nft(a []string) platform.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case len(a) == 4 && a[0] == "list" && a[1] == "table" && a[2] == "inet" && a[3] == FirewallTable:
		if s.table == "" {
			return fail(1, "Error: No such file or directory; did you mean table ‘itso’ in family inet?")
		}
		return ok(s.table)
	case len(a) >= 2 && a[len(a)-2] == "-f":
		b, err := os.ReadFile(a[len(a)-1])
		if err != nil {
			return fail(1, err.Error())
		}
		script := string(b)
		if strings.Contains(script, NftFailMarker) || !strings.HasPrefix(strings.TrimLeft(dropComments(script), "\n"), emptyTableScript) {
			return fail(1, "Error: syntax error, unexpected junk")
		}
		if a[0] == "-c" {
			return ok("")
		}
		body := strings.TrimPrefix(strings.TrimLeft(dropComments(script), "\n"), emptyTableScript)
		s.table = body
		return ok("")
	}
	return fail(1, "nft (sandbox): lệnh không hỗ trợ")
}

func dropComments(script string) string {
	var out []string
	for _, l := range strings.Split(script, "\n") {
		if strings.HasPrefix(l, "#") {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}

func (s *secSim) enabledJails() []string {
	b, _ := s.fs.ReadFile(Fail2banJailConf)
	var on []string
	cur := ""
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "[") && strings.HasSuffix(l, "]") {
			cur = strings.Trim(l, "[]")
		}
		if l == "enabled = true" && cur != "" && cur != "DEFAULT" {
			on = append(on, cur)
		}
	}
	return on
}

func (s *secSim) fail2ban(a []string) platform.Result {
	switch {
	case len(a) == 1 && a[0] == "-t":
		return ok("OK: configuration test is successful\n")
	case len(a) == 1 && a[0] == "status":
		on := s.enabledJails()
		return ok("Status\n|- Number of jail:\t" + itoa(len(on)) + "\n`- Jail list:\t" + strings.Join(on, ", ") + "\n")
	case len(a) == 2 && a[0] == "status":
		return ok("Status for the jail: " + a[1] + "\n|- Filter\n|  |- Currently failed:\t1\n|  `- Total failed:\t40\n" +
			"`- Actions\n   |- Currently banned:\t2\n   |- Total banned:\t12\n   `- Banned IP list:\t203.0.113.45 192.0.2.10\n")
	case len(a) == 4 && a[0] == "get" && a[2] == "banip":
		now := time.Now().Truncate(time.Second)
		f := "2006-01-02 15:04:05"
		return ok("203.0.113.45 \t" + now.Add(-10*time.Minute).Format(f) + " + 3600 = " + now.Add(50*time.Minute).Format(f) + "\n" +
			"192.0.2.10 \t" + now.Add(-2*time.Hour).Format(f) + " + -1 = 9999-12-31 23:59:59\n")
	case len(a) == 4 && a[0] == "set" && a[2] == "unbanip":
		return ok("1\n")
	}
	return fail(1, "fail2ban-client (sandbox): lệnh không hỗ trợ")
}

func itoa(n int) string { return strconv.Itoa(n) }

// NftTable trả bảng itso đang áp dụng trong sandbox (test).
func (s *Sim) NftTable() string {
	s.sec.mu.Lock()
	defer s.sec.mu.Unlock()
	return s.sec.table
}

// Mẫu engine giả: EICAR (clamav) và eval(base64_decode( trong file PHP (yara).
const (
	EicarSignature  = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
	sandboxWebshell = "eval(base64_decode("
)

// scan mô phỏng clamdscan/yara trên gốc FS giả: không theo symlink, chỉ file thường.
func (s *secSim) scan(engine, abs string) platform.Result {
	root, err := s.fs.Path(abs)
	if err != nil {
		return fail(2, err.Error())
	}
	var out strings.Builder
	n, found := 0, 0
	_ = filepath.WalkDir(root, func(p string, de fs.DirEntry, err error) error {
		if err != nil || !de.Type().IsRegular() {
			return nil
		}
		n++
		b, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		sys := abs + strings.TrimPrefix(p, root)
		switch {
		case engine == ClamdscanBin && strings.Contains(string(b), EicarSignature):
			out.WriteString(sys + ": Eicar-Test-Signature FOUND\n")
			found++
		case engine == YaraBin && strings.Contains(string(b), "<?php") && strings.Contains(string(b), sandboxWebshell):
			out.WriteString("ITSO_PHP_Eval_Base64 " + sys + "\n")
			found++
		}
		return nil
	})
	if engine == ClamdscanBin {
		out.WriteString("\n----------- SCAN SUMMARY -----------\nInfected files: " + itoa(found) + "\nScanned files: " + itoa(n) + "\n")
		if found > 0 {
			return platform.Result{ExitCode: 1, Stdout: []byte(out.String())}
		}
	}
	return ok(out.String())
}
