package ops_test

import (
	"regexp"
	"strings"
	"testing"

	"itso.local/agent/internal/ops"
)

// OnCalendar sinh ra chỉ gồm ký tự an toàn cho unit systemd (không xuống dòng, không %, không $, không nháy).
var reCal = regexp.MustCompile(`^((Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z.,]* )?\*-[0-9*.,]+-[0-9*.,]+ [0-9*.,]+:[0-9*.,]+:00$`)

func FuzzCronToOnCalendar(f *testing.F) {
	for _, s := range []string{"* * * * *", "*/15 2-5 * * 1-5", "0 0 29 2 *", "1,2 3-4/2 * 1-12/3 0,7", "* * 1 * 1", "0 27/1 * 1 00"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		cal, err := ops.CronToOnCalendar(s)
		if err != nil {
			return
		}
		if !reCal.MatchString(cal) {
			t.Fatalf("%q → OnCalendar sai dạng %q", s, cal)
		}
	})
}

func FuzzParseSSHKey(f *testing.F) {
	f.Add("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGj2 x@y")
	f.Add(`command="sh" ssh-ed25519 AAAA`)
	f.Fuzz(func(t *testing.T, s string) {
		line, err := ops.ParseSSHKey(s)
		if err != nil {
			return
		}
		if strings.ContainsAny(line, "\n\r\x00\"") || !(strings.HasPrefix(line, "ssh-") || strings.HasPrefix(line, "ecdsa-")) {
			t.Fatalf("khóa chuẩn hóa không an toàn: %q", line)
		}
	})
}

// FuzzUptimePath: path được chấp nhận không thể thoát khỏi domain (traversal, //, CRLF, ký tự mã hóa . hoặc /).
func FuzzUptimePath(f *testing.F) {
	for _, s := range []string{"/", "/health?x=1", "/../a", "/a%0d%0ab", "//evil", "/%2e%2e/", "/a/.?b"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if ops.CheckUptimePath(s) != nil {
			return
		}
		ls := strings.ToLower(s)
		bad := !strings.HasPrefix(s, "/") || strings.Contains(s, "//") || strings.ContainsAny(s, "\r\n\x00 #\\") ||
			strings.Contains(ls, "%2e") || strings.Contains(ls, "%2f") || strings.Contains(ls, "%0a") || strings.Contains(ls, "%0d")
		for _, seg := range strings.FieldsFunc(strings.SplitN(s, "?", 2)[0], func(r rune) bool { return r == '/' }) {
			if seg == "." || seg == ".." {
				bad = true
			}
		}
		if bad || len(s) > 200 {
			t.Fatalf("path uptime không an toàn được chấp nhận: %q", s)
		}
	})
}
